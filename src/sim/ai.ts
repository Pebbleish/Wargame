import { MAP, RULES, UNIT_TYPES, UnitTypeId } from './config';
import { OBJECTIVES, Vec, clampToMap, dist } from './map';
import { Command, Side, Unit, World, angleDiff, formationOf, isSupport } from './world';

type Posture = 'attack' | 'hold' | 'defend';
type Phase = 'gather' | 'bombard' | 'assault';

/** What the army as a whole is doing: its posture, and the objective it is attacking, if any. */
interface Plan {
  posture: Posture;
  target: number | null; // objective index under attack
  phase: Phase;
  phaseAt: number; // battle time the current phase began
  madeAt: number; // battle time of the last review
  restUntil: number; // after a failed attack, no new one before this time
}

/** An enemy regiment as last seen: the AI only knows what its own troops have spotted. */
interface Sighting {
  x: number;
  y: number;
  type: UnitTypeId;
  value: number;
  t: number;
}

/**
 * A layered AI. A commander reviews the battle every few seconds and settles the army's posture and which
 * objective to attack. Regiments are then given roles (garrison, assault group, reserve, recovering), and
 * each role turns into orders through the same commands a human player uses. It only knows about enemies
 * its own troops have seen.
 */
export class AI {
  private lastThink = -999;
  private calls = 0;
  private slots = new Map<number, number>();
  private lastAim = new Map<number, number>();
  private lastGoal = new Map<number, number>(); // objective each regiment was sent to last think
  private fallingBack = new Set<number>(); // general and wagons pulling back from a threat
  private plan: Plan = { posture: 'hold', target: null, phase: 'gather', phaseAt: 0, madeAt: -999, restUntil: 0 };
  private memory = new Map<number, Sighting>();
  private recovering = new Set<number>(); // worn regiments pulled back to rest
  private reserveId: number | null = null;
  private assault = new Set<number>(); // regiments in the current attack

  constructor(private side: Side) {}

  update(world: World): Command[] {
    if (world.phase === 'deploy') return this.deploy(world);
    if (world.phase !== 'battle' || world.time - this.lastThink < 2) return [];
    this.lastThink = world.time;
    return [...this.orders(world), ...this.reinforce(world)];
  }

  private homeX(offset: number): number {
    return this.side === 0 ? offset : MAP.width - offset;
  }

  private deploy(world: World): Command[] {
    if (world.sides[this.side].ready) return [];
    // Two batteries from the start: guns wear the enemy down without losses of their own.
    const buys: [UnitTypeId, number][] = [['line', 1200], ['artillery', 1800], ['artillery', 1500]];
    const cmds: Command[] = buys.map(([type, y]) => ({
      kind: 'callIn', side: this.side, type, x: this.homeX(RULES.zoneStart + (type === 'artillery' ? 250 : 450)), y: this.side === 0 ? y : MAP.height - y,
    }));
    cmds.push({ kind: 'ready', side: this.side });
    return cmds;
  }

  /** Objectives in order of how much this side wants them, with how many regiments each needs. */
  private needs(world: World): { pos: Vec; need: number }[] {
    return OBJECTIVES.map((o, i) => {
      const enemyNear = world.units.filter((u) => u.side !== this.side && u.seen[this.side] && u.state !== 'routing' && dist(u, o) < 600).length;
      const owned = world.owners[i] === this.side;
      let need = o.kind === 'bridge' ? 3 : 2;
      if (owned && enemyNear === 0) {
        // A town we hold is only garrisoned while the enemy is within striking distance of it (further for home
        // towns, since losing everything loses the battle).
        const reach = o.home === this.side ? RULES.garrisonThreat * 1.4 : RULES.garrisonThreat;
        const threat = world.units.some((u) => u.side !== this.side && u.seen[this.side] && u.state !== 'routing' && dist(u, o) < reach);
        need = threat ? 1 : 0;
      }
      need += Math.min(2, enemyNear);
      if (owned && this.plan.posture === 'defend' && enemyNear > 0) need += 1;
      return { pos: { x: o.x, y: o.y }, need };
    });
  }

  private orders(world: World): Command[] {
    const cmds: Command[] = [];
    const mine = world.units.filter((u) => u.side === this.side && u.state !== 'routing');
    const visibleEnemies = world.units.filter((u) => u.side !== this.side && u.seen[this.side]);
    this.remember(world, mine, visibleEnemies);
    this.command(world, mine);
    const needs = this.needs(world);

    // Greedy assignment: each regiment takes the nearest objective that still needs troops.
    // Regiments left over once every objective is covered join the attack on the hottest objective, from a flank.
    const assigned = new Map<number, Vec>();
    const spare = new Set<number>();
    const hot = this.hotObjective(world, visibleEnemies);
    const infantry = mine.filter((u) => u.type === 'line' || u.type === 'light');
    // Worn regiments pull back to rest before they break, and come back once recovered.
    for (const u of infantry) {
      // Shaken regiments step back to recover before they break.
      const worn = u.meleeWith === null && u.morale < 40;
      if (worn) this.recovering.add(u.id);
      else if (u.morale > 75) this.recovering.delete(u.id);
    }
    // One fresh line regiment stays back as a reserve once the army is big enough to spare it.
    const reserve = this.pickReserve(infantry);
    this.assault.clear();
    // Engineers dig in at the held objective nearest the front that the enemy is not already at.
    for (const u of mine.filter((m) => m.type === 'engineers')) assigned.set(u.id, this.worksSite(world, u, visibleEnemies));
    for (const u of infantry.sort((a, b) => a.id - b.id)) {
      if (this.recovering.has(u.id) || u.id === reserve) continue;
      let best = -1;
      let bestScore = Infinity;
      needs.forEach((n, i) => {
        if (n.need <= 0) return;
        // Stick with the objective it was already given, so regiments do not flip between two.
        const score = dist(u, n.pos) - n.need * 150 - (this.lastGoal.get(u.id) === i ? 200 : 0);
        if (score < bestScore) { bestScore = score; best = i; }
      });
      if (best === -1 && this.plan.target !== null) {
        // Everyone not needed elsewhere joins the attack.
        this.assault.add(u.id);
        assigned.set(u.id, OBJECTIVES[this.plan.target]);
        spare.add(u.id);
        continue;
      }
      if (best === -1) {
        const side = this.slot(u.id) % 2 ? 1 : -1;
        assigned.set(u.id, clampToMap({ x: hot.x - this.dir() * 150, y: hot.y + this.dir() * side * 350 }, RULES.borderWidth + 100));
        spare.add(u.id);
        continue;
      }
      needs[best].need -= 1;
      assigned.set(u.id, needs[best].pos);
      this.lastGoal.set(u.id, best);
    }
    const assaultOrders = this.plan.target !== null ? this.assaultOrders(world, cmds, mine, visibleEnemies) : new Set<number>();

    const helpers = this.assignHelpers(mine, visibleEnemies, assigned, spare);

    for (const u of mine) {
      if (u.meleeWith !== null) continue;
      const nearest = this.nearest(u, visibleEnemies);
      const nd = nearest ? dist(u, nearest) : Infinity;

      // The general rides behind the centre of the line; the wagons follow further back.
      if (u.type === 'general' || u.type === 'supply') {
        // Behind the attack while there is one, so its regiments fight inside the general's command radius.
        const anchor = this.plan.target !== null && this.assault.size >= 2 ? this.groupCentre(mine.filter((m) => this.assault.has(m.id))) : this.frontAnchor(mine);
        const back = u.type === 'general' ? 450 : 550;
        const p = { x: anchor.x - this.dir() * back, y: anchor.y + (u.type === 'supply' ? this.dir() * 150 : 0) };
        // Pull back when the enemy gets close, and only return once well clear, so it does not shuttle to and fro.
        const horseWithin = (r: number) => visibleEnemies.some((e) => e.type === 'cavalry' && e.state !== 'routing' && dist(e, u) < r);
        if (nd < 700 || horseWithin(1000)) this.fallingBack.add(u.id);
        else if (nd > 900 && !horseWithin(1200)) this.fallingBack.delete(u.id);
        if (this.fallingBack.has(u.id)) p.x = anchor.x - this.dir() * (back + 400);
        this.moveIfFar(cmds, u, clampToMap(p, RULES.borderWidth + 80), 200);
        continue;
      }

      if (u.type === 'cavalry') {
        const prey = visibleEnemies
          .filter((e) => dist(u, e) < 800 && formationOf(e) !== 'fortified' && (e.state !== 'ok' || e.type === 'artillery' || e.type === 'light' || e.type === 'supply' || (e.type === 'general' && dist(u, e) < 450)))
          .sort((a, b) => dist(u, a) - dist(u, b))[0];
        // Otherwise hit the flank or rear of an enemy already fighting our infantry.
        const target = prey ?? visibleEnemies
          .filter((e) => e.state !== 'routing' && !isSupport(e) && formationOf(e) !== 'fortified' && dist(u, e) < 1000
            && mine.some((m) => m.type !== 'cavalry' && !isSupport(m) && dist(m, e) < 350)
            && Math.abs(angleDiff(e.facing, Math.atan2(u.y - e.y, u.x - e.x))) > Math.PI / 3)
          .sort((a, b) => dist(u, a) - dist(u, b))[0];
        if (target && u.morale > 50 && u.fatigue < 70) {
          if (u.order.kind !== 'attack' || u.order.target !== target.id) cmds.push({ kind: 'attack', side: this.side, ids: [u.id], target: target.id });
        } else if (this.plan.target !== null && u.morale > 50) {
          // Wait off the flank of the objective under attack, ready to fall on defenders once they are engaged.
          const t = OBJECTIVES[this.plan.target];
          const stage = this.stagingPoint(mine);
          const along = { x: t.x - stage.x, y: t.y - stage.y };
          const len = Math.hypot(along.x, along.y) || 1;
          const side = this.slot(u.id) % 2 ? 1 : -1;
          this.moveIfFar(cmds, u, clampToMap({ x: stage.x - (along.y / len) * 450 * side, y: stage.y + (along.x / len) * 450 * side }, RULES.borderWidth + 80));
        } else {
          const anchor = this.frontAnchor(mine);
          this.moveIfFar(cmds, u, { x: anchor.x - this.dir() * 250, y: anchor.y + this.dir() * (this.slot(u.id) % 2 ? 300 : -300) });
        }
        continue;
      }

      if (u.type === 'artillery') {
        // With nothing to shell, guns move up behind the line toward the fighting.
        if (!this.aimGuns(world, cmds, u, mine, visibleEnemies) && !u.fireZone) {
          const anchor = this.frontAnchor(mine);
          const hot = this.plan.target !== null ? OBJECTIVES[this.plan.target] : this.hotObjective(world, visibleEnemies);
          this.moveIfFar(cmds, u, clampToMap({ x: anchor.x - this.dir() * 300, y: (anchor.y + hot.y) / 2 }, RULES.borderWidth + 80), 200);
        }
        continue;
      }

      if (assaultOrders.has(u.id)) continue;
      if (this.recovering.has(u.id) && (u.type === 'line' || u.type === 'light')) {
        // Fall back behind the line, near the wagons, to rest and refill.
        const wagons = mine.find((m) => m.type === 'supply');
        const rear = wagons ?? { x: this.frontAnchor(mine).x - this.dir() * 500, y: u.y };
        if (u.formation !== 'formation') cmds.push({ kind: 'formation', side: this.side, ids: [u.id], formation: 'formation' });
        this.moveIfFar(cmds, u, clampToMap({ x: rear.x + this.dir() * 150, y: rear.y + (this.slot(u.id) % 3 - 1) * 180 }, RULES.borderWidth + 80), 150);
        continue;
      }
      if (u.id === reserve) {
        this.reserveOrders(cmds, u, mine, visibleEnemies);
        continue;
      }
      // Back-line troops go to the help of regiments under attack, firing into the attacker's flank.
      const help = helpers.get(u.id);
      if (help) {
        if (u.formation !== 'formation') cmds.push({ kind: 'formation', side: this.side, ids: [u.id], formation: 'formation' });
        if (help.dist > UNIT_TYPES[u.type].range * 0.9 || u.order.kind !== 'hold') this.moveIfFar(cmds, u, help.spot, 80);
        continue;
      }

      const goal = assigned.get(u.id)!;
      // Light infantry works round the flank of whoever our line is fighting.
      if (u.type === 'light' && u.building <= 0) {
        const flank = this.flankSpot(u, mine, visibleEnemies);
        if (flank) {
          if (u.formation !== 'formation') cmds.push({ kind: 'formation', side: this.side, ids: [u.id], formation: 'formation' });
          if (!(nd < UNIT_TYPES.light.range * 0.9 && u.order.kind === 'hold')) this.moveIfFar(cmds, u, flank, 80);
          continue;
        }
      }
      // Spare regiments press home on enemies near the hot objective.
      const odds = nearest ? mine.filter((m) => !isSupport(m) && dist(m, nearest) < 500).length
        - visibleEnemies.filter((e) => e.state !== 'routing' && dist(e, nearest) < 500).length : 0;
      if (spare.has(u.id) && nearest && nd < 600 && nearest.state !== 'routing' && formationOf(nearest) !== 'fortified' && u.morale > 70 && odds >= 2) {
        if (u.formation !== 'formation') cmds.push({ kind: 'formation', side: this.side, ids: [u.id], formation: 'formation' });
        if (u.order.kind !== 'attack') cmds.push({ kind: 'attack', side: this.side, ids: [u.id], target: nearest.id });
        continue;
      }
      const enemyWeak = nearest && nd < 380 && (nearest.state === 'wavering' || (u.morale > 65 && nearest.morale < u.morale - 20));
      if (u.type === 'line' && enemyWeak && nearest) {
        if (u.formation !== 'formation') cmds.push({ kind: 'formation', side: this.side, ids: [u.id], formation: 'formation' });
        if (u.order.kind !== 'attack') cmds.push({ kind: 'attack', side: this.side, ids: [u.id], target: nearest.id });
        continue;
      }
      // Engineers throw up earthworks at their objective while it is quiet.
      if (u.type === 'engineers') {
        if (u.building > 0) continue;
        if (dist(u, goal) < 300 && nd > 400 && !u.moving && !world.buildBlocker(u)) {
          cmds.push({ kind: 'build', side: this.side, ids: [u.id] });
          continue;
        }
      }
      // Dig in early when holding an objective the enemy is coming for (it cannot start once in a fight), otherwise stay in formation and let long moves march.
      const atGoal = dist(u, goal) < 250;
      const cavThreat = visibleEnemies.some((e) => e.type === 'cavalry' && e.state === 'ok' && dist(e, u) < 300);
      // Troops already in a fight cannot start digging in, so only ask when the order will be accepted.
      const wanted = atGoal && (nd < 1200 || cavThreat) && (u.formation === 'fortified' || world.canFortify(u)) ? 'fortified' : 'formation';
      if (u.formation !== wanted) cmds.push({ kind: 'formation', side: this.side, ids: [u.id], formation: wanted });
      // Spread regiments around the objective, mirrored so both sides behave the same way.
      const n = this.slot(u.id);
      const spot = { x: goal.x + this.dir() * (((n * 37) % 160) - 120), y: goal.y + this.dir() * (((n * 53) % 200) - 100) };
      if (nd < UNIT_TYPES[u.type].range * 0.9 && u.order.kind === 'hold') continue; // in a firefight, stand
      this.moveIfFar(cmds, u, spot, 90);
    }
    return cmds;
  }

  /** Where engineers should build: a held objective with no enemy close, nearest the hot spot. */
  private worksSite(world: World, u: Unit, enemies: Unit[]): Vec {
    const hot = this.hotObjective(world, enemies);
    let best: Vec | undefined;
    let bd = Infinity;
    OBJECTIVES.forEach((o, i) => {
      if (world.owners[i] !== this.side || enemies.some((e) => e.state !== 'routing' && dist(e, o) < 600)) return;
      const d = dist(o, hot) + dist(o, u) * 0.3;
      if (d < bd) { bd = d; best = o; }
    });
    return best ?? world.homeTowns(this.side)[this.slot(u.id) % 2];
  }

  /** The objective where the fight is: the one with most enemies near it that we do not hold, else the centre. */
  private hotObjective(world: World, enemies: Unit[]): Vec {
    let best: Vec = OBJECTIVES.find((o) => o.centre)!;
    let bestScore = 0;
    OBJECTIVES.forEach((o, i) => {
      const near = enemies.filter((e) => e.state !== 'routing' && dist(e, o) < 700).length;
      const score = near + (world.owners[i] === this.side ? 0 : 1);
      if (near > 0 && score > bestScore) { bestScore = score; best = o; }
    });
    return best;
  }

  /** A firing spot off the flank of an enemy that our troops are already engaging, if there is one nearby. */
  private flankSpot(u: Unit, mine: Unit[], enemies: Unit[]): Vec | null {
    let target: Unit | undefined;
    let bd = 1000;
    for (const e of enemies) {
      if (e.state === 'routing' || isSupport(e)) continue;
      const engaged = mine.some((m) => m.id !== u.id && m.type !== 'light' && dist(m, e) < 400);
      const d = dist(u, e);
      if (engaged && d < bd) { bd = d; target = e; }
    }
    if (!target) return null;
    // Stand off to the side the enemy is not facing, at musket range.
    const across = { x: -Math.sin(target.facing), y: Math.cos(target.facing) };
    const sign = (u.x - target.x) * across.x + (u.y - target.y) * across.y >= 0 ? 1 : -1;
    const r = UNIT_TYPES.light.range * 0.8;
    return clampToMap({ x: target.x + across.x * sign * r, y: target.y + across.y * sign * r }, RULES.borderWidth + 80);
  }

  /**
   * Pick the best thing to shell: enemies attacking our regiments first, then crowds. Targets out of range count too;
   * the battery moves up to reach them, as long as the firing spot is not too close to the enemy.
   * Returns true if the battery has a target.
   */
  private aimGuns(world: World, cmds: Command[], u: Unit, mine: Unit[], enemies: Unit[]): boolean {
    if ((this.lastAim.get(u.id) ?? -99) > world.time - 5) return !!u.fireZone;
    this.lastAim.set(u.id, world.time);
    const range = UNIT_TYPES.artillery.range;
    let best: Unit | undefined;
    let bestScore = 0;
    for (const e of enemies) {
      const d = dist(u, e);
      if (e.state === 'routing' || d > range + 800) continue;
      if (d > range * 0.95) {
        const stop = { x: e.x + ((u.x - e.x) / d) * range * 0.9, y: e.y + ((u.y - e.y) / d) * range * 0.9 };
        if (enemies.some((o) => o.state !== 'routing' && dist(o, stop) < 500)) continue;
      }
      const friends = mine.filter((o) => dist(o, e) < 180).length;
      if (friends > 0 && e.meleeWith === null) continue; // too close to our own troops
      const crowd = enemies.filter((o) => o.state !== 'routing' && dist(o, e) < 200).length;
      const attacking = mine.some((m) => !isSupport(m) && (m.meleeWith === e.id || dist(m, e) < 400)) ? 3 : 0;
      const fortified = formationOf(e) === 'fortified' ? 1 : 0;
      // Before and during an attack, the guns work on the defenders of the objective.
      const prep = this.plan.target !== null && dist(e, OBJECTIVES[this.plan.target]) < 600 ? 4 : 0;
      const score = crowd + attacking + fortified + prep - friends * 2 - (d > range ? 1.5 : 0);
      if (score > bestScore) { bestScore = score; best = e; }
    }
    if (!best) {
      if (u.fireZone) cmds.push({ kind: 'ceaseFire', side: this.side, ids: [u.id] });
      return false;
    }
    if (!u.fireZone || dist(u.fireZone, best) > 60) cmds.push({ kind: 'bombard', side: this.side, ids: [u.id], x: best.x, y: best.y });
    return true;
  }

  /**
   * Regiments under attack call for help: up to two idle regiments nearby (spares, or garrisons that are not
   * an objective's only defender) move to fire into the attacker's flank.
   */
  private assignHelpers(mine: Unit[], enemies: Unit[], assigned: Map<number, Vec>, spare: Set<number>) {
    const helpers = new Map<number, { spot: Vec; dist: number }>();
    const busy = (m: Unit) => m.meleeWith !== null || m.underFire > 0 || m.building > 0
      || enemies.some((e) => e.state !== 'routing' && dist(e, m) < 600);
    const canSpare = (m: Unit) => {
      if (spare.has(m.id)) return true;
      const goal = assigned.get(m.id);
      if (!goal) return false;
      // Another regiment shares this post, so this one can leave.
      return mine.some((o) => o.id !== m.id && (o.type === 'line' || o.type === 'light') && dist(o, goal) < 300);
    };
    const free = mine.filter((m) => (m.type === 'line' || m.type === 'light') && m.morale > 60 && !busy(m) && canSpare(m));
    const pressed = mine.filter((m) => !isSupport(m) && (m.underFire > 0 || m.meleeWith !== null));
    for (const friend of pressed) {
      const attacker = enemies
        .filter((e) => e.state !== 'routing' && (friend.meleeWith === e.id || dist(e, friend) < 450))
        .sort((a, b) => dist(a, friend) - dist(b, friend))[0];
      if (!attacker) continue;
      const near = free.filter((m) => !helpers.has(m.id) && dist(m, attacker) < 1500).sort((a, b) => dist(a, attacker) - dist(b, attacker));
      for (const m of near.slice(0, 2)) {
        // Off the attacker's flank, on our side of it, at musket range.
        const across = { x: -Math.sin(attacker.facing), y: Math.cos(attacker.facing) };
        const sign = (m.x - attacker.x) * across.x + (m.y - attacker.y) * across.y >= 0 ? 1 : -1;
        const r = UNIT_TYPES[m.type].range * 0.85;
        const spot = clampToMap({ x: attacker.x + across.x * sign * r, y: attacker.y + across.y * sign * r }, RULES.borderWidth + 80);
        helpers.set(m.id, { spot, dist: dist(m, attacker) });
      }
    }
    return helpers;
  }

  private reinforce(world: World): Command[] {
    const s = world.sides[this.side];
    const count = (t: UnitTypeId) => world.units.filter((u) => u.side === this.side && u.type === t).length;
    const prefs: UnitTypeId[] = [];
    if (count('supply') === 0) prefs.push('supply');
    if (this.calls % 4 === 3) prefs.push('artillery');
    if (count('cavalry') < 2) prefs.push('cavalry');
    if (this.calls % 5 === 1) prefs.push('light');
    prefs.push('line');
    // Take the first type that can be called in; a capped or cooling type should not hold up the rest.
    const wanted = prefs.find((t) => !world.callInBlocker(this.side, t));
    if (!wanted || s.manpower < UNIT_TYPES[wanted].cost) return [];
    const needs = this.needs(world).sort((a, b) => b.need - a.need);
    this.calls += 1;
    const y = Math.max(100, Math.min(MAP.height - 100, needs[0].pos.y));
    return [{ kind: 'callIn', side: this.side, type: wanted, x: this.homeX(RULES.zoneStart + RULES.zoneDepth - 150), y }];
  }

  /** What a regiment is worth to the fight right now: its cost, scaled by strength, morale and fatigue. */
  private value(u: Pick<Unit, 'type' | 'men' | 'maxMen' | 'morale' | 'fatigue' | 'state'>): number {
    if (u.type === 'general' || u.type === 'supply') return 0;
    const strength = u.men / u.maxMen;
    const spirit = u.state === 'routing' ? 0.1 : 0.4 + 0.6 * Math.max(0, u.morale) / 100;
    return UNIT_TYPES[u.type].cost * strength * spirit * (1 - 0.3 * u.fatigue / 100);
  }

  /** Keep track of enemies seen, and forget them once they have been gone a while or the spot is seen empty. */
  private remember(world: World, mine: Unit[], visible: Unit[]) {
    for (const e of visible) this.memory.set(e.id, { x: e.x, y: e.y, type: e.type, value: this.value(e), t: world.time });
    for (const [id, s] of this.memory) {
      if (s.t === world.time) continue;
      const looked = mine.some((m) => dist(m, s) < UNIT_TYPES[m.type].sight * 0.7);
      if (world.time - s.t > 60 || looked || !world.unit(id)) this.memory.delete(id);
    }
  }

  private enemyPowerNear(p: Vec, r: number): number {
    let sum = 0;
    for (const s of this.memory.values()) if (dist(s, p) < r) sum += s.value;
    return sum;
  }

  /**
   * The commander. Compares the two armies as far as it can see them, the objectives held, the score and the
   * clock, and settles whether to attack, hold or stand on the defensive, and which objective to go for.
   */
  private command(world: World, mine: Unit[]) {
    const p = this.plan;
    const t = p.target;
    // Drop a target once it is ours and clear of the enemy.
    if (t !== null && world.owners[t] === this.side && this.enemyPowerNear(OBJECTIVES[t], 500) === 0) this.endAttack(world, false);
    if (world.time - p.madeAt < 10) return;
    p.madeAt = world.time;

    const ours = mine.reduce((a, u) => a + this.value(u), 0);
    let theirs = 0;
    for (const s of this.memory.values()) theirs += s.value;
    const ratio = ours / Math.max(1, theirs);
    const me = world.sides[this.side];
    const them = world.sides[1 - this.side];
    const heldByUs = world.owners.filter((o) => o === this.side).length;
    const heldByThem = world.owners.filter((o) => o === 1 - this.side).length;
    const late = world.time > RULES.finalPushAt - 90;
    const losing = me.score < them.score - 0.5 || me.armyMorale < them.armyMorale - 10;
    if (ratio > 1.15 || me.armyMorale > them.armyMorale + 20 || (ratio > 0.8 && (heldByThem > heldByUs || (late && losing)))) p.posture = 'attack';
    else if (ratio < 0.7 && !(late && losing)) p.posture = 'defend';
    else p.posture = 'hold';

    if (p.posture === 'defend') {
      if (p.target !== null) this.endAttack(world, true);
      return;
    }
    if (world.time < p.restUntil) return;

    // Check the attack in progress is still worth pressing.
    const group = mine.filter((u) => this.assault.has(u.id));
    if (p.target !== null && p.phase === 'assault' && group.length) {
      const morale = group.reduce((a, u) => a + u.morale, 0) / group.length;
      const local = group.reduce((a, u) => a + this.value(u), 0);
      if (morale < 40 || local < this.enemyPowerNear(OBJECTIVES[p.target], 600) * 0.6) {
        this.endAttack(world, true);
        return;
      }
    }

    // Pick the objective that is most worth taking for the effort, or keep the current one.
    const anchor = this.frontAnchor(mine);
    const strike = mine.filter((u) => u.type === 'line' || u.type === 'light' || u.type === 'cavalry').reduce((a, u) => a + this.value(u), 0);
    // Holding nothing at all is close to losing outright, so any objective will do.
    const desperate = heldByUs === 0 && heldByThem > 0;
    const limit = desperate ? 2 : 0.9;
    let best: number | null = null;
    let bestScore = -Infinity;
    OBJECTIVES.forEach((o, i) => {
      if (world.owners[i] === this.side) return;
      const defence = this.enemyPowerNear(o, 600);
      if (defence > strike * limit) return;
      // Our own home towns come first, then whatever the enemy holds, the centre, and depots (income).
      const worth = (o.centre ? 1.5 : o.kind === 'depot' ? 1.2 : 1) * (world.owners[i] === 1 - this.side ? 1.3 : 1) * (o.home === this.side ? 2 : 1);
      const score = (worth * 1000) / (defence + 300) - dist(anchor, o) * 0.4 + (i === p.target ? 0.6 : 0);
      if (score > bestScore) { bestScore = score; best = i; }
    });
    // In test battles, holding objectives and letting the enemy come beat attacking whenever ahead, so a set-piece
    // attack is only launched when the army must: late in the battle and behind, or holding no objective at all.
    // The rest of the time, spare regiments still pounce wherever they have the numbers.
    if (!desperate && !(late && losing)) best = null;
    if (best !== p.target) {
      if (p.target !== null) this.endAttack(world, false);
      if (best !== null) {
        p.target = best;
        p.phase = 'gather';
        p.phaseAt = world.time;
      }
    }
  }

  private endAttack(world: World, failed: boolean) {
    this.plan.target = null;
    this.plan.phase = 'gather';
    if (failed) this.plan.restUntil = world.time + 30;
  }

  /** Where the assault group forms up: short of the objective, on the side facing our army. */
  private stagingPoint(mine: Unit[]): Vec {
    const t = OBJECTIVES[this.plan.target!];
    const from = this.frontAnchor(mine);
    let dx = from.x - t.x;
    let dy = from.y - t.y;
    const len = Math.hypot(dx, dy);
    if (len < 200) { dx = -this.dir(); dy = 0; } else { dx /= len; dy /= len; }
    return clampToMap({ x: t.x + dx * 600, y: t.y + dy * 600 }, RULES.borderWidth + 100);
  }

  /**
   * The attack, in three steps: form up out of musket range, let the guns work on the defenders while the
   * infantry closes to firing range, then go in together, two regiments to each defender where possible.
   * Returns the regiments it has dealt with.
   */
  private assaultOrders(world: World, cmds: Command[], mine: Unit[], enemies: Unit[]): Set<number> {
    const p = this.plan;
    const t = OBJECTIVES[p.target!];
    const group = mine.filter((u) => this.assault.has(u.id) && u.meleeWith === null);
    const handled = new Set<number>(mine.filter((u) => this.assault.has(u.id)).map((u) => u.id));
    if (!group.length) return handled;
    const stage = this.stagingPoint(mine);
    const across = { x: -(t.y - stage.y), y: t.x - stage.x };
    const alen = Math.hypot(across.x, across.y) || 1;
    across.x /= alen;
    across.y /= alen;
    const defenders = enemies.filter((e) => e.state !== 'routing' && !isSupport(e) && dist(e, t) < 600);
    const fortified = defenders.some((e) => formationOf(e) === 'fortified');
    const sorted = group.slice().sort((a, b) => this.slot(a.id) - this.slot(b.id));
    const slotAt = (centre: Vec, k: number) => {
      const off = (k - (sorted.length - 1) / 2) * 190;
      return clampToMap({ x: centre.x + across.x * off, y: centre.y + across.y * off }, RULES.borderWidth + 80);
    };

    const elapsed = world.time - p.phaseAt;
    if (p.phase === 'gather') {
      const formed = sorted.filter((u, k) => dist(u, slotAt(stage, k)) < 180).length;
      if (formed >= Math.ceil(sorted.length * 0.7) || elapsed > 50) { p.phase = defenders.length ? 'bombard' : 'assault'; p.phaseAt = world.time; }
    } else if (p.phase === 'bombard') {
      const shaken = defenders.length > 0 && defenders.every((e) => e.state === 'wavering' || e.morale < 55);
      if (!defenders.length || shaken || elapsed > (fortified ? 60 : 35)) { p.phase = 'assault'; p.phaseAt = world.time; }
    }

    // The firing line: just inside musket range of the defenders, or of the objective itself.
    const line = (() => {
      const d = Math.hypot(stage.x - t.x, stage.y - t.y) || 1;
      return { x: t.x + ((stage.x - t.x) / d) * 230, y: t.y + ((stage.y - t.y) / d) * 230 };
    })();

    sorted.forEach((u, k) => {
      if (p.phase === 'gather') {
        if (u.formation === 'fortified') cmds.push({ kind: 'formation', side: this.side, ids: [u.id], formation: 'formation' });
        this.moveIfFar(cmds, u, slotAt(stage, k), 80);
        return;
      }
      if (u.formation !== 'formation') cmds.push({ kind: 'formation', side: this.side, ids: [u.id], formation: 'formation' });
      if (p.phase === 'bombard') {
        // Close to firing range and trade volleys while the guns work; stand once in a firefight.
        const nd = Math.min(...enemies.map((e) => dist(u, e)));
        if (nd < UNIT_TYPES[u.type].range * 0.9 && u.order.kind === 'hold') return;
        this.moveIfFar(cmds, u, slotAt(line, k), 80);
        return;
      }
      if (u.type === 'light') {
        const flank = this.flankSpot(u, mine, enemies);
        if (flank) { this.moveIfFar(cmds, u, flank, 80); return; }
      }
      if (!defenders.length) {
        this.moveIfFar(cmds, u, slotAt(t, k), 60);
        return;
      }
      // Two regiments to each defender, the shakiest and nearest first. Only charge home when it should win:
      // the defender is shaken, or not dug in and outnumbered two to one. Otherwise keep up the firefight.
      const ranked = defenders.slice().sort((a, b) => (a.morale + dist(a, line) * 0.1) - (b.morale + dist(b, line) * 0.1));
      const foe = ranked[Math.floor(k / 2) % ranked.length];
      const odds = sorted.length / defenders.length;
      const charge = foe.state === 'wavering' || foe.morale < 45 || (formationOf(foe) !== 'fortified' && odds >= 2 && foe.morale < 75);
      if (charge) {
        if (u.order.kind !== 'attack' || u.order.target !== foe.id) cmds.push({ kind: 'attack', side: this.side, ids: [u.id], target: foe.id });
        return;
      }
      const nd = Math.min(...enemies.map((e) => dist(u, e)));
      if (nd < UNIT_TYPES[u.type].range * 0.9 && u.order.kind === 'hold') return;
      this.moveIfFar(cmds, u, slotAt(line, k), 80);
    });
    return handled;
  }

  /** The freshest line regiment not tied down, kept back once the army has six or more infantry regiments. */
  private pickReserve(infantry: Unit[]): number | null {
    const line = infantry.filter((u) => u.type === 'line' && !this.recovering.has(u.id));
    if (infantry.length < 6) { this.reserveId = null; return null; }
    const current = line.find((u) => u.id === this.reserveId);
    if (current && (current.order.kind === 'attack' || current.morale > 60)) return current.id;
    const fresh = line.slice().sort((a, b) => this.value(b) - this.value(a) || a.id - b.id)[0];
    this.reserveId = fresh?.id ?? null;
    return this.reserveId;
  }

  /** The reserve waits behind the line and counter-attacks whoever is pressing one of our regiments hardest. */
  private reserveOrders(cmds: Command[], u: Unit, mine: Unit[], enemies: Unit[]) {
    const pressed = mine.filter((m) => m.id !== u.id && !isSupport(m) && (m.meleeWith !== null || m.state === 'wavering') && dist(m, u) < 1000);
    let foe: Unit | undefined;
    for (const m of pressed) {
      const e = enemies.find((x) => x.id === m.meleeWith) ?? this.nearest(m, enemies.filter((x) => x.state !== 'routing'));
      if (e && dist(e, m) < 400 && (!foe || dist(e, u) < dist(foe, u))) foe = e;
    }
    if (foe) {
      if (u.formation !== 'formation') cmds.push({ kind: 'formation', side: this.side, ids: [u.id], formation: 'formation' });
      if (u.order.kind !== 'attack' || u.order.target !== foe.id) cmds.push({ kind: 'attack', side: this.side, ids: [u.id], target: foe.id });
      return;
    }
    const centre = this.plan.target !== null && this.assault.size ? this.groupCentre(mine.filter((m) => this.assault.has(m.id))) : this.frontAnchor(mine);
    this.moveIfFar(cmds, u, clampToMap({ x: centre.x - this.dir() * 350, y: centre.y }, RULES.borderWidth + 80), 150);
  }

  private groupCentre(units: Unit[]): Vec {
    if (!units.length) return { x: this.homeX(400), y: MAP.height / 2 };
    return { x: units.reduce((a, u) => a + u.x, 0) / units.length, y: units.reduce((a, u) => a + u.y, 0) / units.length };
  }

  /** A per-side running number for each regiment, so both AIs spread out identically. */
  private slot(id: number): number {
    if (!this.slots.has(id)) this.slots.set(id, this.slots.size + 1);
    return this.slots.get(id)!;
  }

  private dir(): number {
    return this.side === 0 ? 1 : -1;
  }

  private nearest(u: Unit, others: Unit[]): Unit | undefined {
    let best: Unit | undefined;
    let bd = Infinity;
    for (const o of others) {
      const d = dist(u, o);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  /** Average position of the infantry, used to place guns and horse behind the line. */
  private frontAnchor(mine: Unit[]): Vec {
    const inf = mine.filter((u) => u.type === 'line');
    if (inf.length === 0) return { x: this.homeX(400), y: MAP.height / 2 };
    const x = inf.reduce((a, u) => a + u.x, 0) / inf.length;
    const y = inf.reduce((a, u) => a + u.y, 0) / inf.length;
    return { x, y };
  }

  private moveIfFar(cmds: Command[], u: Unit, p: Vec, slack = 150) {
    const current = u.order.kind === 'move' ? { x: u.order.x, y: u.order.y } : u;
    if (dist(current, p) <= slack) return;
    cmds.push({ kind: 'move', side: this.side, moves: [{ id: u.id, x: p.x, y: p.y }] });
  }
}
