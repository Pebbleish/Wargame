import { MAP, RULES, UNIT_TYPES, UnitTypeId } from './config';
import { OBJECTIVES, Terrain, Vec, clampToMap, dist, terrainAt } from './map';
import { Habits } from './habits';
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
 * A battle plan. Each battle the AI picks one, so it does not fight the same way every time: what it opens with,
 * what it buys, when it attacks and where, how early it digs in, and what its cavalry is for.
 */
export interface Doctrine {
  name: string;
  report: string; // what the other side's scouts make of it, a minute into the battle
  deploy: UnitTypeId[]; // the three regiments bought before the battle
  cavalry: number; // cavalry regiments to keep in the field
  artilleryEvery: number; // every Nth reinforcement is a battery
  lightEvery: number; // every Nth reinforcement is light infantry
  attack: 'late' | 'stronger'; // set-piece attacks only when it must, or whenever it is the stronger army
  wing: boolean; // concentrates spare regiments, attacks and cavalry on one flank
  fortifyAt: number; // garrisons dig in when the enemy comes this close
  reserve: boolean; // keeps a regiment back to counter-attack
  raid: boolean; // cavalry ranges deep after guns, wagons and the general
}

export const DOCTRINES: Doctrine[] = [
  {
    name: 'Fortress', report: 'Scouts report the enemy digging in around its towns, with guns behind.',
    deploy: ['line', 'artillery', 'artillery'], cavalry: 2, artilleryEvery: 4, lightEvery: 5,
    attack: 'late', wing: false, fortifyAt: 1200, reserve: true, raid: false,
  },
  {
    name: 'Hammer', report: 'Scouts report enemy infantry massing for an attack.',
    deploy: ['line', 'line', 'artillery'], cavalry: 2, artilleryEvery: 3, lightEvery: 6,
    attack: 'stronger', wing: false, fortifyAt: 700, reserve: true, raid: false,
  },
  {
    name: 'Envelopment', report: 'Scouts report enemy columns working round one of our flanks.',
    deploy: ['light', 'line', 'artillery'], cavalry: 3, artilleryEvery: 5, lightEvery: 3,
    attack: 'stronger', wing: true, fortifyAt: 900, reserve: false, raid: false,
  },
  {
    name: 'Grand battery', report: 'Scouts report the enemy bringing up a great many guns.',
    deploy: ['artillery', 'artillery', 'line'], cavalry: 1, artilleryEvery: 2, lightEvery: 4,
    attack: 'late', wing: false, fortifyAt: 1200, reserve: true, raid: false,
  },
  {
    name: 'Raiders', report: 'Scouts report strong bodies of enemy horse on the move.',
    deploy: ['cavalry', 'line', 'artillery'], cavalry: 3, artilleryEvery: 4, lightEvery: 4,
    attack: 'late', wing: true, fortifyAt: 1200, reserve: true, raid: true,
  },
];

/**
 * The AI's tunable numbers. Tests and self-play tuning can hand an AI its own copy; the game uses these.
 */
export const PARAMS = {
  ground: 0, // weight on cover and high ground when garrisons pick where to stand (0 ignores the ground)
  gunGround: 1, // batteries look for high ground to fire from
  coverFire: 0, // skirmishers and regiments going to help fire from woods and towns where they can
  dodgeShells: 1, // troops with no enemy foot near step out of open ground under shellfire
  adapt: 1, // changes battle plan mid-battle to counter what the enemy is doing (0 never does)
  remember: 1, // how strongly a player's habits from earlier battles sway the choice of plan
  restAt: 40, // worn regiments pull back to rest below this morale
  restedAt: 75, // and come back above this
  stickTo: 200, // pull (in metres) of the objective a regiment was already sent to
  needPull: 150, // pull for each regiment an objective still needs
  hqBack: 450, // how far behind the line the general rides
  wagonsBack: 550, // and the wagons
  shyOf: 700, // the general and wagons fall back when enemy troops come this close
  raidReach: 1400, // how far raiding cavalry goes after guns, wagons and the general
  cavReach: 800, // how far other cavalry does
  cavMorale: 50, // cavalry only charges above this morale
  cavFatigue: 70, // and below this fatigue
  cavWait: 450, // how far off the flank of an attack cavalry waits
  pressRange: 600, // spare regiments attack enemies this close
  pressMorale: 70, // when above this morale
  pressOdds: 2, // and this many more regiments than the enemy nearby
  pounceRange: 380, // line regiments charge a weaker enemy this close
  pounceGap: 20, // when this much steadier than it
  fortifyScale: 1, // multiplies how close the enemy must come before garrisons dig in
  gunPrep: 4, // how much guns favour the defenders of an objective under attack
  gunAttacking: 3, // and enemies fighting our regiments
  gunSafe: 500, // guns do not move up to within this of the enemy
  attackRatio: 1.15, // attack when this much stronger than the enemy as far as it can see
  defendRatio: 0.7, // stand on the defensive when weaker than this
  moraleLead: 20, // or attack when this far ahead on army morale
  takeOdds: 0.9, // only attack an objective whose defenders are at most this share of our strike force
  abortMorale: 40, // call off an attack when the attackers' morale falls below this
  abortOdds: 0.6, // or their strength below this share of the defenders'
  restAfter: 30, // seconds before a new attack after one fails
  bombardTime: 35, // seconds the guns prepare an attack (60 against dug-in defenders)
  chargeMorale: 45, // assault troops charge defenders below this morale
  chargeOdds: 2, // or not dug in when they have this many regiments to each defender
  reserveFrom: 6, // keep a reserve once there are this many infantry regiments
  helpRange: 1500, // how far idle regiments go to help one under attack
  helpers: 2, // how many go
};

// Which battle plan answers which enemy habit, from playing every plan against every other (60 battles a pair):
// massed guns and strong horse are best met dug in with guns behind (Fortress won 62% against both), and troops
// that dig in or a mass of infantry rushing the centre by a grand battery (38% against Fortress, which beats
// everything, but 78% against an infantry rush).
const FORTRESS = 0;
const GRAND_BATTERY = 3;

/** How strongly the enemy shows each habit, 0 to 1. */
interface Signals {
  guns: number;
  dugIn: number;
  rush: number;
  horse: number;
}

/** The plan that best answers the enemy's strongest habit, if one stands out. */
function counterPlan(s: Signals, threshold = 0.5): number | null {
  const options: [number, number][] = [[s.guns, FORTRESS], [s.dugIn, GRAND_BATTERY], [s.rush, GRAND_BATTERY], [s.horse, FORTRESS]];
  options.sort((a, b) => b[0] - a[0]);
  return options[0][0] >= threshold ? options[0][1] : null;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** A player's habits over earlier battles, as signals. */
function habitSignals(h: Habits): Signals {
  return {
    guns: clamp01((h.guns - 0.15) / 0.2),
    dugIn: clamp01((h.dugIn - 0.25) / 0.35),
    rush: clamp01(h.centreRush),
    horse: clamp01((h.cavalry - 0.15) / 0.2 * 0.6 + h.raids * 0.6),
  };
}
export type Params = typeof PARAMS;

export interface AIOptions {
  doctrine?: Doctrine;
  params?: Partial<Params>;
  habits?: Habits; // how the enemy player has fought in earlier battles
}

/** A shell seen landing, remembered a little longer than the smoke lasts. */
interface Shell {
  x: number;
  y: number;
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

  private spots = new Map<number, Vec>(); // where each regiment was last told to stand
  private shells: Shell[] = [];
  private lastShell = -1;
  private gunSpots = new Map<number, Vec>(); // high ground a battery is moving to before it opens fire

  doctrine: Doctrine;
  readonly params: Params;
  private adaptAt = 120; // next battle time to review the plan against what the enemy is doing
  private pending: number | null = null; // a change of plan seen at the last review, made if the next agrees
  private switchedAt = -999;
  private switches = 0;
  private reported = false;
  private wingSign: number; // which flank a one-wing plan favours: +1 or -1, from the army's own point of view

  /** Battle plan from the battle's seed (or given), so a replay of the same seed fights the same way. */
  constructor(readonly side: Side, seed = 1, opts: AIOptions = {}) {
    const h = Math.imul(seed * 2654435761 + side * 40503, 2246822519) >>> 0;
    this.params = { ...PARAMS, ...opts.params };
    this.doctrine = opts.doctrine ?? DOCTRINES[this.choosePlan(h, opts.habits)];
    this.wingSign = (h & 1) ? 1 : -1;
  }

  /**
   * Pick the battle plan from the seed, so a replay fights the same way. Against a player with a known style,
   * the plan that beats it is likelier: up to three times as likely after a few battles, never certain.
   */
  private choosePlan(h: number, habits?: Habits): number {
    const weights = DOCTRINES.map(() => 1);
    if (habits && habits.battles > 0 && this.params.remember > 0) {
      const sure = Math.min(1, habits.battles / 3) * this.params.remember;
      const s = habitSignals(habits);
      const best = counterPlan(s, 0.25);
      if (best !== null) weights[best] += 3 * sure * Math.max(s.guns, s.dugIn, s.rush, s.horse);
    }
    const total = weights.reduce((a, b) => a + b, 0);
    if (total === weights.length) return (h >>> 8) % weights.length;
    let roll = ((h >>> 8) % 10007) / 10007 * total;
    for (let i = 0; i < weights.length; i++) {
      roll -= weights[i];
      if (roll < 0) return i;
    }
    return weights.length - 1;
  }

  /**
   * Every half minute from the second minute on, compare what the enemy is doing with the plan, and switch to
   * the plan that counters it when two reviews in a row agree. At most twice a battle, and not in quick succession.
   */
  private adapt(world: World, enemies: Unit[]) {
    if (this.params.adapt <= 0 || world.time < this.adaptAt) return;
    this.adaptAt = world.time + 30;
    const seen = [...this.memory.values()];
    const guns = seen.filter((s) => s.type === 'artillery').length;
    const horse = seen.filter((s) => s.type === 'cavalry').length;
    const foot = enemies.filter((e) => (e.type === 'line' || e.type === 'light') && e.state !== 'routing');
    const dug = foot.filter((e) => formationOf(e) === 'fortified').length;
    const centre = OBJECTIVES.find((o) => o.centre)!;
    const atCentre = foot.filter((e) => dist(e, centre) < 700).length;
    const signals: Signals = {
      guns: guns >= 3 ? 1 : guns === 2 ? 0.3 : 0, // three batteries is as many as an army can field
      dugIn: foot.length >= 3 ? clamp01((dug / foot.length - 0.3) / 0.4) : 0,
      rush: world.time < 300 && atCentre >= 3 && atCentre >= foot.length * 0.6 ? 1 : 0,
      horse: horse >= 3 ? 1 : horse === 2 ? 0.3 : 0,
    };
    const pick = counterPlan(signals, 1 - 0.5 * this.params.adapt);
    if (pick === null || DOCTRINES[pick] === this.doctrine) { this.pending = null; return; }
    if (this.pending !== pick) { this.pending = pick; return; }
    if (this.switches >= 2 || world.time - this.switchedAt < 150) return;
    this.doctrine = DOCTRINES[pick];
    this.switches += 1;
    this.switchedAt = world.time;
    this.pending = null;
    if (this.reported) world.log(this.side === 0 ? 1 : 0, `The enemy is changing its plan. ${this.doctrine.report}`);
  }

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
    const buys = this.doctrine.deploy.map((t, i): [UnitTypeId, number] => [t, [1200, 1800, 1500][i]]);
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
    const P = this.params;
    const mine = world.units.filter((u) => u.side === this.side && u.state !== 'routing');
    const visibleEnemies = world.units.filter((u) => u.side !== this.side && u.seen[this.side]);
    this.remember(world, mine, visibleEnemies);
    this.watchShells(world);
    this.adapt(world, visibleEnemies);
    // A minute in, the other side's scouts work out what kind of battle this army is fighting.
    if (!this.reported && world.time > 60) {
      this.reported = true;
      world.log(this.side === 0 ? 1 : 0, this.doctrine.report);
    }
    this.command(world, mine);
    const stood = new Set<number>(); // regiments given a place to stand this time
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
      const worn = u.meleeWith === null && u.morale < P.restAt;
      if (worn) this.recovering.add(u.id);
      else if (u.morale > P.restedAt) this.recovering.delete(u.id);
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
        const score = dist(u, n.pos) - n.need * P.needPull - (this.lastGoal.get(u.id) === i ? P.stickTo : 0);
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
        const side = this.doctrine.wing ? this.wingSign : this.slot(u.id) % 2 ? 1 : -1;
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
    const footNear = (p: Vec, r: number) => visibleEnemies.some((e) => e.state !== 'routing' && !isSupport(e) && e.type !== 'artillery' && dist(e, p) < r);

    for (const u of mine) {
      if (u.meleeWith !== null) continue;
      const nearest = this.nearest(u, visibleEnemies);
      const nd = nearest ? dist(u, nearest) : Infinity;

      // The general rides behind the centre of the line; the wagons follow further back.
      if (u.type === 'general' || u.type === 'supply') {
        // Behind the attack while there is one, so its regiments fight inside the general's command radius.
        const anchor = this.plan.target !== null && this.assault.size >= 2 ? this.groupCentre(mine.filter((m) => this.assault.has(m.id))) : this.frontAnchor(mine);
        const back = u.type === 'general' ? P.hqBack : P.wagonsBack;
        const p = { x: anchor.x - this.dir() * back, y: anchor.y + (u.type === 'supply' ? this.dir() * 150 : 0) };
        // Pull back when the enemy gets close, and only return once well clear, so it does not shuttle to and fro.
        const horseWithin = (r: number) => visibleEnemies.some((e) => e.type === 'cavalry' && e.state !== 'routing' && dist(e, u) < r);
        if (nd < P.shyOf || horseWithin(P.shyOf + 300)) this.fallingBack.add(u.id);
        else if (nd > P.shyOf + 200 && !horseWithin(P.shyOf + 500)) this.fallingBack.delete(u.id);
        if (this.fallingBack.has(u.id)) p.x = anchor.x - this.dir() * (back + 400);
        this.moveIfFar(cmds, u, clampToMap(p, RULES.borderWidth + 80), 200);
        continue;
      }

      if (u.type === 'cavalry') {
        // Raiders range much further after guns, wagons and the general.
        // Deep raids only go for targets no formed infantry is guarding.
        const reach = this.doctrine.raid ? P.raidReach : P.cavReach;
        const guarded = (e: Unit) => visibleEnemies.some((g) => g !== e && (g.type === 'line' || g.type === 'light') && g.state !== 'routing' && dist(g, e) < 300);
        const prey = visibleEnemies
          .filter((e) => dist(u, e) < reach && formationOf(e) !== 'fortified' && (e.state !== 'ok' || e.type === 'artillery' || e.type === 'light' || e.type === 'supply'
            || (e.type === 'general' && dist(u, e) < (this.doctrine.raid ? 1200 : 450)))
            && (dist(u, e) < P.cavReach || !guarded(e)))
          .sort((a, b) => dist(u, a) - dist(u, b))[0];
        // Otherwise hit the flank or rear of an enemy already fighting our infantry.
        const target = prey ?? visibleEnemies
          .filter((e) => e.state !== 'routing' && !isSupport(e) && formationOf(e) !== 'fortified' && dist(u, e) < 1000
            && mine.some((m) => m.type !== 'cavalry' && !isSupport(m) && dist(m, e) < 350)
            && Math.abs(angleDiff(e.facing, Math.atan2(u.y - e.y, u.x - e.x))) > Math.PI / 3)
          .sort((a, b) => dist(u, a) - dist(u, b))[0];
        if (target && u.morale > P.cavMorale && u.fatigue < P.cavFatigue) {
          if (u.order.kind !== 'attack' || u.order.target !== target.id) cmds.push({ kind: 'attack', side: this.side, ids: [u.id], target: target.id });
        } else if (this.plan.target !== null && u.morale > P.cavMorale) {
          // Wait off the flank of the objective under attack, ready to fall on defenders once they are engaged.
          const t = OBJECTIVES[this.plan.target];
          const stage = this.stagingPoint(mine);
          const along = { x: t.x - stage.x, y: t.y - stage.y };
          const len = Math.hypot(along.x, along.y) || 1;
          const side = this.doctrine.wing ? this.wingSign * this.dir() : this.slot(u.id) % 2 ? 1 : -1;
          this.moveIfFar(cmds, u, clampToMap({ x: stage.x - (along.y / len) * P.cavWait * side, y: stage.y + (along.x / len) * P.cavWait * side }, RULES.borderWidth + 80));
        } else if (this.doctrine.raid || this.doctrine.wing) {
          // Out on the chosen flank, just behind the line, looking for an opening.
          const anchor = this.frontAnchor(mine);
          this.moveIfFar(cmds, u, clampToMap({ x: anchor.x - this.dir() * 150, y: anchor.y + this.dir() * this.wingSign * 600 }, RULES.borderWidth + 80));
        } else {
          const anchor = this.frontAnchor(mine);
          this.moveIfFar(cmds, u, { x: anchor.x - this.dir() * 250, y: anchor.y + this.dir() * (this.slot(u.id) % 2 ? 300 : -300) });
        }
        continue;
      }

      if (u.type === 'artillery') {
        // With nothing to shell, guns move up behind the line toward the fighting.
        if (!this.aimGuns(world, cmds, u, mine, visibleEnemies, stood) && !u.fireZone) {
          const anchor = this.frontAnchor(mine);
          const hot = this.plan.target !== null ? OBJECTIVES[this.plan.target] : this.hotObjective(world, visibleEnemies);
          const at = clampToMap({ x: anchor.x - this.dir() * 300, y: (anchor.y + hot.y) / 2 }, RULES.borderWidth + 80);
          // Wait on high ground if there is some close by, or hidden in woods.
          this.moveIfFar(cmds, u, (P.gunGround > 0 ? this.stand(u, at, 200, AI.gunGround, stood) : null) ?? at, 200);
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
        // Fire from cover if there is some within range of the attacker.
        const reach = UNIT_TYPES[u.type].range * 0.9;
        const spot = (P.coverFire > 0 ? this.stand(u, help.spot, 90, AI.cover, stood, (p) => dist(p, help.attacker) < reach) : null) ?? help.spot;
        if (help.dist > reach || u.order.kind !== 'hold') this.moveIfFar(cmds, u, spot, 80);
        continue;
      }

      const goal = assigned.get(u.id)!;
      // Light infantry works round the flank of whoever our line is fighting.
      if (u.type === 'light' && u.building <= 0) {
        const flank = this.flankSpot(u, mine, visibleEnemies, stood);
        if (flank) {
          if (u.formation !== 'formation') cmds.push({ kind: 'formation', side: this.side, ids: [u.id], formation: 'formation' });
          if (!(nd < UNIT_TYPES.light.range * 0.9 && u.order.kind === 'hold')) this.moveIfFar(cmds, u, flank, 80);
          continue;
        }
      }
      // Spare regiments press home on enemies near the hot objective.
      const odds = nearest ? mine.filter((m) => !isSupport(m) && dist(m, nearest) < 500).length
        - visibleEnemies.filter((e) => e.state !== 'routing' && dist(e, nearest) < 500).length : 0;
      if (spare.has(u.id) && nearest && nd < P.pressRange && nearest.state !== 'routing' && formationOf(nearest) !== 'fortified' && u.morale > P.pressMorale && odds >= P.pressOdds) {
        if (u.formation !== 'formation') cmds.push({ kind: 'formation', side: this.side, ids: [u.id], formation: 'formation' });
        if (u.order.kind !== 'attack') cmds.push({ kind: 'attack', side: this.side, ids: [u.id], target: nearest.id });
        continue;
      }
      const enemyWeak = nearest && nd < P.pounceRange && (nearest.state === 'wavering' || (u.morale > 65 && nearest.morale < u.morale - P.pounceGap));
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
      const wanted = atGoal && (nd < this.doctrine.fortifyAt * P.fortifyScale || cavThreat) && (u.formation === 'fortified' || world.canFortify(u)) ? 'fortified' : 'formation';
      if (u.formation !== wanted) cmds.push({ kind: 'formation', side: this.side, ids: [u.id], formation: wanted });
      // Stand in the best cover at the objective, spread out from the others. While shells fall on it and no
      // enemy foot is near enough to rush it, step back out of the fire to cover nearby.
      const shelled = this.params.dodgeShells > 0 && this.shellfire(goal) > 0 && !footNear(goal, 1000);
      const n = this.slot(u.id);
      const spot = (P.ground > 0 || shelled ? this.stand(u, goal, shelled ? 350 : spare.has(u.id) ? 150 : 130, AI.cover, stood, undefined, !shelled) : null)
        ?? { x: goal.x + this.dir() * (((n * 37) % 160) - 120), y: goal.y + this.dir() * (((n * 53) % 200) - 100) };
      if (nd < UNIT_TYPES[u.type].range * 0.9 && u.order.kind === 'hold') continue; // in a firefight, stand
      this.moveIfFar(cmds, u, spot, 90);
    }
    for (const id of this.spots.keys()) if (!stood.has(id)) this.spots.delete(id);
    return cmds;
  }

  // How good a piece of ground is to stand on, for each kind of regiment.
  private static cover = (t: Terrain) => (1 - t.cover) * 120 + (t.hill ? 10 : 0) - (t.marsh ? 60 : 0);
  private static gunGround = (t: Terrain) => (t.hill ? 80 : 0) + (t.woods ? 30 : 0) - (t.marsh ? 60 : 0);
  private static skirmishGround = (t: Terrain) => (t.woods ? 70 : 0) + (1 - t.cover) * 40 - (t.marsh ? 60 : 0);

  /**
   * The best place for a regiment to stand within r of a point: woods, a town, earthworks or a hill if there
   * are any, clear of the places given to other regiments and of where shells are falling. The ground is
   * sampled on a grid laid out from this army's side, so both armies read mirrored ground the same way.
   * Returns null when every spot is taken.
   */
  private stand(u: Unit, centre: Vec, r: number, value: (t: Terrain) => number, stood: Set<number>, ok?: (p: Vec) => boolean, behind = false): Vec | null {
    const step = 30;
    const n = Math.floor(r / step);
    const prev = this.spots.get(u.id);
    const others = [...this.spots].filter(([id]) => id !== u.id).map(([, p]) => p);
    let best: Vec | null = null;
    let bestScore = -Infinity;
    for (let i = -n; i <= n; i++) {
      for (let j = -n; j <= n; j++) {
        const off = Math.hypot(i, j) * step;
        if (off > r) continue;
        // Garrisons keep to their own side of the objective, out of the enemy's way, as they did before.
        if (behind && i > 1) continue;
        const p = { x: centre.x + this.dir() * i * step, y: centre.y + this.dir() * j * step };
        if (p.x < RULES.borderWidth + 80 || p.x > MAP.width - RULES.borderWidth - 80 || p.y < RULES.borderWidth + 80 || p.y > MAP.height - RULES.borderWidth - 80) continue;
        // Regiments stand in line abreast, so they need more room side to side than front to back.
        if (others.some((o) => Math.abs(o.x - p.x) < 45 && Math.abs(o.y - p.y) < 140)) continue;
        if (ok && !ok(p)) continue;
        // A little nearer our own side is better than a little nearer the enemy.
        const score = value(terrainAt(p)) - off * 0.15 - i * step * 0.05
          + (prev && dist(p, prev) < 25 ? 40 : 0) - this.shellfire(p) * 80;
        if (score > bestScore) { bestScore = score; best = p; }
      }
    }
    if (best) {
      this.spots.set(u.id, best);
      stood.add(u.id);
    }
    return best;
  }

  /** Keep track of where enemy shells have been landing lately. */
  private watchShells(world: World) {
    for (const i of world.impacts) {
      // Only shells from the other side: our own guns' fire is not a reason to move.
      if (i.t <= this.lastShell || i.side === this.side) continue;
      this.shells.push({ x: i.x, y: i.y, t: i.t });
    }
    this.lastShell = world.impacts.reduce((a, i) => Math.max(a, i.t), this.lastShell);
    this.shells = this.shells.filter((s) => world.time - s.t < 12);
  }

  /** How heavily shells have been falling around a spot lately: 0 for none, 1 for steady fire. */
  private shellfire(p: Vec): number {
    let n = 0;
    for (const s of this.shells) if (Math.abs(s.x - p.x) < 200 && Math.abs(s.y - p.y) < 200 && dist(s, p) < 200) n++;
    return Math.min(1, n / 3);
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
  private flankSpot(u: Unit, mine: Unit[], enemies: Unit[], stood: Set<number>): Vec | null {
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
    const spot = clampToMap({ x: target.x + across.x * sign * r, y: target.y + across.y * sign * r }, RULES.borderWidth + 80);
    // Skirmish from woods where there are some within range.
    const t = target;
    if (this.params.coverFire <= 0) return spot;
    return this.stand(u, spot, 90, AI.skirmishGround, stood, (p) => dist(p, t) < UNIT_TYPES.light.range * 0.9) ?? spot;
  }

  /**
   * Pick the best thing to shell: enemies attacking our regiments first, then crowds. Targets out of range count too;
   * the battery moves up to reach them, as long as the firing spot is not too close to the enemy.
   * Returns true if the battery has a target.
   */
  private aimGuns(world: World, cmds: Command[], u: Unit, mine: Unit[], enemies: Unit[], stood: Set<number>): boolean {
    if ((this.lastAim.get(u.id) ?? -99) > world.time - 5) {
      if (this.gunSpots.has(u.id)) stood.add(u.id);
      return !!u.fireZone || this.gunSpots.has(u.id);
    }
    this.lastAim.set(u.id, world.time);
    const range = UNIT_TYPES.artillery.range;
    let best: Unit | undefined;
    let bestScore = 0;
    for (const e of enemies) {
      const d = dist(u, e);
      if (e.state === 'routing' || d > range + 800) continue;
      if (d > range * 0.95) {
        const stop = { x: e.x + ((u.x - e.x) / d) * range * 0.9, y: e.y + ((u.y - e.y) / d) * range * 0.9 };
        if (enemies.some((o) => o.state !== 'routing' && dist(o, stop) < this.params.gunSafe)) continue;
      }
      const friends = mine.filter((o) => dist(o, e) < 180).length;
      if (friends > 0 && e.meleeWith === null) continue; // too close to our own troops
      const crowd = enemies.filter((o) => o.state !== 'routing' && dist(o, e) < 200).length;
      const attacking = mine.some((m) => !isSupport(m) && (m.meleeWith === e.id || dist(m, e) < 400)) ? this.params.gunAttacking : 0;
      const fortified = formationOf(e) === 'fortified' ? 1 : 0;
      // Before and during an attack, the guns work on the defenders of the objective.
      const prep = this.plan.target !== null && dist(e, OBJECTIVES[this.plan.target]) < 600 ? this.params.gunPrep : 0;
      const score = crowd + attacking + fortified + prep - friends * 2 - (d > range ? 1.5 : 0);
      if (score > bestScore) { bestScore = score; best = e; }
    }
    this.gunSpots.delete(u.id);
    if (!best) {
      if (u.fireZone) cmds.push({ kind: 'ceaseFire', side: this.side, ids: [u.id] });
      return false;
    }
    // Out of range: bring the guns up onto high ground in reach of the target if there is some, where they
    // see and shoot further, rather than straight up the open. Not anywhere enemy foot could rush them.
    const reach = (p: Vec) => range * (terrainAt(p).hill ? 1.2 : 1);
    const d = dist(u, best);
    if (d > reach(u) && this.params.gunGround > 0) {
      const b = best;
      const stop = { x: b.x + ((u.x - b.x) / d) * range * 0.9, y: b.y + ((u.y - b.y) / d) * range * 0.9 };
      const safe = (p: Vec) => dist(p, b) < reach(p) * 0.92 && !enemies.some((o) => o.state !== 'routing' && !isSupport(o) && dist(o, p) < this.params.gunSafe);
      const spot = this.stand(u, stop, 300, AI.gunGround, stood, safe);
      if (spot && terrainAt(spot).hill) {
        this.gunSpots.set(u.id, spot);
        if (u.fireZone) cmds.push({ kind: 'ceaseFire', side: this.side, ids: [u.id] });
        this.moveIfFar(cmds, u, spot, 40);
        return true;
      }
    }
    if (!u.fireZone || dist(u.fireZone, best) > 60) cmds.push({ kind: 'bombard', side: this.side, ids: [u.id], x: best.x, y: best.y });
    return true;
  }

  /**
   * Regiments under attack call for help: up to two idle regiments nearby (spares, or garrisons that are not
   * an objective's only defender) move to fire into the attacker's flank.
   */
  private assignHelpers(mine: Unit[], enemies: Unit[], assigned: Map<number, Vec>, spare: Set<number>) {
    const helpers = new Map<number, { spot: Vec; dist: number; attacker: Unit }>();
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
      const near = free.filter((m) => !helpers.has(m.id) && dist(m, attacker) < this.params.helpRange).sort((a, b) => dist(a, attacker) - dist(b, attacker));
      for (const m of near.slice(0, Math.round(this.params.helpers))) {
        // Off the attacker's flank, on our side of it, at musket range.
        const across = { x: -Math.sin(attacker.facing), y: Math.cos(attacker.facing) };
        const sign = (m.x - attacker.x) * across.x + (m.y - attacker.y) * across.y >= 0 ? 1 : -1;
        const r = UNIT_TYPES[m.type].range * 0.85;
        const spot = clampToMap({ x: attacker.x + across.x * sign * r, y: attacker.y + across.y * sign * r }, RULES.borderWidth + 80);
        helpers.set(m.id, { spot, dist: dist(m, attacker), attacker });
      }
    }
    return helpers;
  }

  private reinforce(world: World): Command[] {
    const s = world.sides[this.side];
    const count = (t: UnitTypeId) => world.units.filter((u) => u.side === this.side && u.type === t).length;
    const prefs: UnitTypeId[] = [];
    if (count('supply') === 0) prefs.push('supply');
    const d = this.doctrine;
    if (this.calls % d.artilleryEvery === d.artilleryEvery - 1) prefs.push('artillery');
    if (count('cavalry') < d.cavalry) prefs.push('cavalry');
    if (this.calls % d.lightEvery === 1) prefs.push('light');
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
    const P = this.params;
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
    if (ratio > P.attackRatio || me.armyMorale > them.armyMorale + P.moraleLead || (ratio > 0.8 && (heldByThem > heldByUs || (late && losing)))) p.posture = 'attack';
    else if (ratio < P.defendRatio && !(late && losing)) p.posture = 'defend';
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
      if (morale < P.abortMorale || local < this.enemyPowerNear(OBJECTIVES[p.target], 600) * P.abortOdds) {
        this.endAttack(world, true);
        return;
      }
    }

    // Pick the objective that is most worth taking for the effort, or keep the current one.
    const anchor = this.frontAnchor(mine);
    const strike = mine.filter((u) => u.type === 'line' || u.type === 'light' || u.type === 'cavalry').reduce((a, u) => a + this.value(u), 0);
    // Holding nothing at all is close to losing outright, so any objective will do.
    const desperate = heldByUs === 0 && heldByThem > 0;
    const limit = desperate ? 2 : P.takeOdds;
    let best: number | null = null;
    let bestScore = -Infinity;
    OBJECTIVES.forEach((o, i) => {
      if (world.owners[i] === this.side) return;
      const defence = this.enemyPowerNear(o, 600);
      if (defence > strike * limit) return;
      // Our own home towns come first, then whatever the enemy holds, the centre, and depots (income).
      const worth = (o.centre ? 1.5 : o.kind === 'depot' ? 1.2 : 1) * (world.owners[i] === 1 - this.side ? 1.3 : 1) * (o.home === this.side ? 2 : 1);
      // A one-wing plan prefers objectives on its chosen flank.
      const onWing = this.doctrine.wing && (o.y - MAP.height / 2) * this.dir() * this.wingSign > 200 ? 1.5 : 1;
      const score = (worth * onWing * 1000) / (defence + 300) - dist(anchor, o) * 0.4 + (i === p.target ? 0.6 : 0);
      if (score > bestScore) { bestScore = score; best = i; }
    });
    // In test battles, holding objectives and letting the enemy come beat attacking whenever ahead, so a set-piece
    // attack is only launched when the army must: late in the battle and behind, or holding no objective at all.
    // The rest of the time, spare regiments still pounce wherever they have the numbers.
    const willing = this.doctrine.attack === 'stronger' && p.posture === 'attack';
    if (!desperate && !(late && losing) && !willing) best = null;
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
    if (failed) this.plan.restUntil = world.time + this.params.restAfter;
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
      const prepTime = this.params.bombardTime * (fortified ? 60 / 35 : 1);
      if (!defenders.length || shaken || elapsed > prepTime) { p.phase = 'assault'; p.phaseAt = world.time; }
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
        const flank = this.flankSpot(u, mine, enemies, new Set());
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
      const charge = foe.state === 'wavering' || foe.morale < this.params.chargeMorale || (formationOf(foe) !== 'fortified' && odds >= this.params.chargeOdds && foe.morale < 75);
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
    if (infantry.length < this.params.reserveFrom || !this.doctrine.reserve) { this.reserveId = null; return null; }
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
