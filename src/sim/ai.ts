import { MAP, RULES, UNIT_TYPES, UnitTypeId } from './config';
import { OBJECTIVES, Vec, clampToMap, dist } from './map';
import { Command, Side, Unit, World, formationOf, isSupport } from './world';

/**
 * A simple layered AI: it decides which objectives each regiment should go for,
 * then gives orders through the same commands a human player uses.
 */
export class AI {
  private lastThink = -999;
  private calls = 0;
  private slots = new Map<number, number>();
  private lastAim = new Map<number, number>();

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
    const buys: [UnitTypeId, number][] = [['line', 1200], ['line', 1800], ['artillery', 1500]];
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
      if (owned && enemyNear === 0) need = 1;
      need += Math.min(2, enemyNear);
      return { pos: { x: o.x, y: o.y }, need };
    });
  }

  private orders(world: World): Command[] {
    const cmds: Command[] = [];
    const mine = world.units.filter((u) => u.side === this.side && u.state !== 'routing');
    const visibleEnemies = world.units.filter((u) => u.side !== this.side && u.seen[this.side]);
    const needs = this.needs(world);

    // Greedy assignment: each regiment takes the nearest objective that still needs troops.
    // Regiments left over once every objective is covered join the attack on the hottest objective, from a flank.
    const assigned = new Map<number, Vec>();
    const spare = new Set<number>();
    const hot = this.hotObjective(world, visibleEnemies);
    const infantry = mine.filter((u) => u.type === 'line' || u.type === 'light');
    // Engineers dig in at the held objective nearest the front that the enemy is not already at.
    for (const u of mine.filter((m) => m.type === 'engineers')) assigned.set(u.id, this.worksSite(world, u, visibleEnemies));
    for (const u of infantry.sort((a, b) => a.id - b.id)) {
      let best = -1;
      let bestScore = Infinity;
      needs.forEach((n, i) => {
        if (n.need <= 0) return;
        const score = dist(u, n.pos) - n.need * 150;
        if (score < bestScore) { bestScore = score; best = i; }
      });
      if (best === -1) {
        const side = this.slot(u.id) % 2 ? 1 : -1;
        assigned.set(u.id, clampToMap({ x: hot.x - this.dir() * 150, y: hot.y + this.dir() * side * 350 }, RULES.borderWidth + 100));
        spare.add(u.id);
        continue;
      }
      needs[best].need -= 1;
      assigned.set(u.id, needs[best].pos);
    }

    for (const u of mine) {
      if (u.meleeWith !== null) continue;
      const nearest = this.nearest(u, visibleEnemies);
      const nd = nearest ? dist(u, nearest) : Infinity;

      // The general rides behind the centre of the line; the wagons follow further back.
      if (u.type === 'general' || u.type === 'supply') {
        const anchor = this.frontAnchor(mine);
        const back = u.type === 'general' ? 450 : 550;
        const p = { x: anchor.x - this.dir() * back, y: anchor.y + (u.type === 'supply' ? this.dir() * 150 : 0) };
        // Pull back when the enemy gets close.
        const horse = visibleEnemies.some((e) => e.type === 'cavalry' && e.state !== 'routing' && dist(e, u) < 1000);
        if (nd < 700 || horse) p.x = u.x - this.dir() * 400;
        this.moveIfFar(cmds, u, clampToMap(p, RULES.borderWidth + 80), 200);
        continue;
      }

      if (u.type === 'cavalry') {
        const prey = visibleEnemies
          .filter((e) => dist(u, e) < 800 && formationOf(e) !== 'fortified' && (e.state !== 'ok' || e.type === 'artillery' || e.type === 'light' || e.type === 'supply' || (e.type === 'general' && dist(u, e) < 450)))
          .sort((a, b) => dist(u, a) - dist(u, b))[0];
        if (prey) {
          if (u.order.kind !== 'attack' || u.order.target !== prey.id) cmds.push({ kind: 'attack', side: this.side, ids: [u.id], target: prey.id });
        } else {
          const anchor = this.frontAnchor(mine);
          this.moveIfFar(cmds, u, { x: anchor.x - this.dir() * 250, y: anchor.y + this.dir() * (this.slot(u.id) % 2 ? 300 : -300) });
        }
        continue;
      }

      if (u.type === 'artillery') {
        const anchor = this.frontAnchor(mine);
        this.moveIfFar(cmds, u, { x: anchor.x - this.dir() * 450, y: anchor.y }, 150);
        this.aimGuns(world, cmds, u, mine, visibleEnemies);
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
      const enemyWeak = nearest && nd < 380 && (nearest.state !== 'ok' || (u.morale > 65 && nearest.morale < u.morale - 20));
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
      // Dig in when holding an objective under threat, otherwise stay in formation and let long moves march.
      const atGoal = dist(u, goal) < 250;
      const cavThreat = visibleEnemies.some((e) => e.type === 'cavalry' && e.state === 'ok' && dist(e, u) < 300);
      const wanted = atGoal && (nd < 700 || cavThreat) ? 'fortified' : 'formation';
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

  /** Re-aim a battery's fire circle at the densest enemy group in range, away from our own troops. */
  private aimGuns(world: World, cmds: Command[], u: Unit, mine: Unit[], enemies: Unit[]) {
    if ((this.lastAim.get(u.id) ?? -99) > world.time - 6) return;
    let best: Unit | undefined;
    let bestScore = 0;
    for (const e of enemies) {
      if (e.state === 'routing' || dist(u, e) > UNIT_TYPES.artillery.range * 0.95) continue;
      const crowd = enemies.filter((o) => o.state !== 'routing' && dist(o, e) < 200).length;
      const friends = mine.filter((o) => dist(o, e) < 200).length;
      const score = crowd - friends * 3;
      if (score > bestScore) { bestScore = score; best = e; }
    }
    this.lastAim.set(u.id, world.time);
    if (!best) {
      if (u.fireZone) cmds.push({ kind: 'ceaseFire', side: this.side, ids: [u.id] });
      return;
    }
    if (!u.fireZone || dist(u.fireZone, best) > 60) cmds.push({ kind: 'bombard', side: this.side, ids: [u.id], x: best.x, y: best.y });
  }

  private reinforce(world: World): Command[] {
    const s = world.sides[this.side];
    const count = (t: UnitTypeId) => world.units.filter((u) => u.side === this.side && u.type === t).length;
    let wanted: UnitTypeId = 'line';
    if (count('supply') === 0) wanted = 'supply';
    else if (this.calls % 4 === 3) wanted = 'artillery';
    else if (count('cavalry') < 2) wanted = 'cavalry';
    else if (this.calls % 5 === 1) wanted = 'light';
    if (world.callInBlocker(this.side, wanted) || s.manpower < UNIT_TYPES[wanted].cost) return [];
    const needs = this.needs(world).sort((a, b) => b.need - a.need);
    this.calls += 1;
    const y = Math.max(100, Math.min(MAP.height - 100, needs[0].pos.y));
    return [{ kind: 'callIn', side: this.side, type: wanted, x: this.homeX(RULES.zoneStart + RULES.zoneDepth - 150), y }];
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
