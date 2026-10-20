import { MAP, RULES, UNIT_TYPES, UnitTypeId } from './config';
import { CROSSINGS, EARTHWORKS, OBJECTIVES, RIVER, Terrain, Vec, clampToMap, crossesRiver, dist, nearestRiverPoint, riverSide, terrainAt } from './map';
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
 * The values were tuned by self-play: mutants played the champion over thousands of battles, and changes were
 * kept only when they won at least 54% of 120 confirming battles. Re-tuned after the rally, comeback, river and
 * garrison changes (three changes kept out of twenty rounds). Then re-tuned with bigger self-play: each change
 * screened on 80 battles, kept only after winning at least 53.5% of 320 more and doing no worse against three
 * earlier AIs (one change kept out of ten rounds).
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
  hqBack: 313, // how far behind the line the general rides
  wagonsBack: 348, // and the wagons
  shyOf: 577, // the general and wagons fall back when enemy troops come this close
  raidReach: 860, // how far raiding cavalry goes after guns, wagons and the general
  cavReach: 673, // how far other cavalry does
  cavMorale: 50, // cavalry only charges above this morale
  cavFatigue: 105, // and below this fatigue (over 100: tiredness never stops a charge)
  cavWait: 589, // how far off the flank of an attack cavalry waits
  pressRange: 600, // spare regiments attack enemies this close
  pressMorale: 67, // when above this morale
  pressOdds: 2, // and this many more regiments than the enemy nearby
  pounceRange: 380, // line regiments charge a weaker enemy this close
  pounceGap: 15, // when this much steadier than it
  fortifyScale: 0.48, // multiplies how close the enemy must come before garrisons dig in
  gunPrep: 4, // how much guns favour the defenders of an objective under attack
  gunAttacking: 3, // and enemies fighting our regiments
  gunSafe: 401, // guns do not move up to within this of the enemy
  attackRatio: 1.78, // attack when this much stronger than the enemy as far as it can see
  defendRatio: 0.7, // stand on the defensive when weaker than this
  moraleLead: 15, // or attack when this far ahead on army morale
  takeOdds: 0.9, // only attack an objective whose defenders are at most this share of our strike force
  abortMorale: 40, // call off an attack when the attackers' morale falls below this
  abortOdds: 0.6, // or their strength below this share of the defenders'
  restAfter: 30, // seconds before a new attack after one fails
  bombardTime: 35, // seconds the guns prepare an attack (60 against dug-in defenders)
  chargeMorale: 45, // assault troops charge defenders below this morale
  chargeOdds: 4, // or not dug in when they have this many regiments to each defender
  reserveFrom: 7, // keep a reserve once there are this many infantry regiments
  helpRange: 1500, // how far idle regiments go to help one under attack
  helpers: 2, // how many go
  homeReach: 1100, // a home town we hold keeps a garrison only while an enemy is within this (other towns: garrisonThreat)
  postSafe: 919, // a lone garrison may leave to help when no enemy is within this of its post
  rescue: 1, // regiments go to the help of routing friends being ridden down by cavalry (0 never)
  comeback: 1, // when behind on army morale, attacks objectives the enemy holds to win morale back (0 never)
  comebackGap: 8, // how far behind counts
  comebackWorth: 1.28, // how much more an enemy-held objective is worth then
  horseAlert: 0, // an empty home town gets a garrison back when enemy cavalry comes this close (0: no special case; 1800 lost 46%)
  groupPress: 0, // spare regiments only pounce together, two or more on the same enemy at once (0: one at a time; 1 lost 47%)
  pontoon: 0, // on river maps, engineers bridge the river away from the crossings once a battle (0 never; 1 lost 46%)
  pontoonGap: 250, // at least this far from any other crossing
  openGuns: 2, // batteries in the opening army, counting the one it starts with (3 lost 42% in tests)
  gunEvery: 1, // scales how often reinforcements are batteries (each plan sets its own rate)
  lightEvery: 1, // and light infantry
  rally: 1, // the general rides out to rally broken regiments when it can do so safely (0 never does)
  rallyReach: 1500, // how far the general goes to reach them
  pursue: 1, // cavalry rides down routing regiments before they can rally (0 treats them like any other prey)
  focus: 0, // regiments in range concentrate their fire on the same shaky enemy (0 spreads it: focusing lost in tests)
  requisition: 0, // requisitions fresh troops when short of manpower and steady enough to pay for it (0 never: it lost in tests)
  requisitionMorale: 50, // only above this army morale
  requisitionLead: -5, // and this far ahead of the enemy's (negative: no further behind than this)
  callAtAttack: 1, // reinforcements arrive on the flank of the map an attack is going in on
  flankCross: 1, // an attack over a defended river crossing forms up across another, quieter one instead (0 never)
  flankOdds: 0.3, // when the enemy near that crossing is at most this share of the defence of the direct way
  look: 0, // before launching an attack, plays the battle forward to see whether attacking beats holding (0 never: no gain in tests yet)
  lookAhead: 75, // seconds of battle each look-ahead plays forward
  lookTicks: 8, // look-ahead ticks played per battle tick, so the look is spread over a few seconds of battle
  lookEvery: 20, // seconds between looks
  lookMargin: 2, // an attack must come out at least this much better than holding
  front: 0, // reads the whole front in three sectors and attacks where force can be massed against a weak point (0: local odds only; 1 lost 41%)
  frontRatio: 1.5, // attack a sector when the force we could mass there is this much stronger than the enemy in it
  frontHold: 0.8, // each other sector keeps this share of the enemy strength facing it, and sends the rest to the attack
  frontWill: 1, // and launches attacks wherever that is so, not only when the battle plan calls for one (0: the plan decides)
  frontReserve: 0, // with no attack on, spare regiments go to the sector where the enemy most outweighs us (0: to the hottest objective)
  focusTargets: 0, // goes for at most this many of the places the enemy holds at once (0: all of them; 1 won 51% of 800)
  needCap: 2, // most extra regiments an objective asks for because of enemies near it
  frontPull: 1, // garrisons in quiet sectors leave their posts to join the attack (0: only spare regiments go)
  fightLook: 0, // once an attack goes in, plays the fight forward to see whether pressing on beats falling back (0: rules of thumb; no gain in tests)
  fightAhead: 45, // seconds of battle each of those looks plays forward
  fightTicks: 20, // look-ahead ticks played per battle tick
  fightEvery: 15, // seconds between looks
  fightMargin: 0, // falling back must come out at least this much better than pressing on
  standLook: 0, // where our troops are fighting a stronger enemy at a town, plays it forward to see whether standing beats giving it up (0 never; 1 won 52%)
  standOdds: 0.8, // looks when the enemy there is at least this share of our strength there
  standFor: 30, // seconds a town given up is left alone
  together: 0, // regiments sent at a defended town wait short of it until enough have gathered to go in together (0: each goes as it arrives; 1 won 50%)
  togetherN: 2, // how many
  mergeAttack: 0, // regiments sent at the town under attack join the attack, with its forming up and gun preparation (0: they march straight in; 1 lost 44%)
  hunt: 0, // free regiments go after enemy regiments standing on their own, in strength (0 never; 1 lost 42%)
  huntReach: 1200, // from this far
  huntOdds: 1.5, // only with at least this many times the regiment's worth
  trend: 0, // regiments whose morale is falling fast pull back before they reach the rest threshold (0: only below restAt; 1 won 50%)
  trendDrop: 15, // morale lost in the last 20 seconds that counts as falling fast
  trendBelow: 60, // only once morale is below this
  finish: 0, // guns and infantry pile onto wavering enemies to break them (0: no special effort; 1 won 50%)
  counter: 1, // when an attack on a town we hold stalls, its defenders charge out (0: they hold; 1 won 54% of 960)
  counterMorale: 45, // stalled: the attackers' average morale is below this
  scout: 0, // one cavalry regiment scouts places the army has not seen lately (0: none; 1 lost 42%)
  ammoEarly: 0, // regiments low on ammunition and out of the fight go back to the wagons to refill (0: only once out; 1 won 50%)
  ammoAt: 40, // low
  clock: 0, // once the clock is draining morale and the army is well ahead, it stands on the defensive (0: no change; 1 won 52%, same as without)
  clockLead: 10, // well ahead
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

/** A look-ahead in progress: the battle as this side knows it, played forward once for each option. */
interface Look {
  kind: 'attack' | 'fight' | 'stand'; // whether to launch an attack, press on with one under way, or stand at a town
  start: World;
  options: (number | null)[]; // objectives to attack, or null to hold
  scores: number[];
  sim: World | null;
  ais: AI[];
  ends: number;
}

/** The front in three sectors, north to south: strength on each side, and what each sector can spare. */
interface Front {
  enemy: number[]; // enemy strength seen in each sector
  ours: number[]; // our fighting strength in each sector
  hold: number[]; // what each sector must keep to hold against the enemy facing it
  spare: number[]; // what each sector could send elsewhere
  massed: number[]; // the force we could bring to bear in each sector, its own plus what the others can spare
}

const sectorOf = (p: Vec) => (p.y < MAP.height / 3 ? 0 : p.y < (2 * MAP.height) / 3 ? 1 : 2);

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
  private seed: number;
  private look: Look | null = null;
  private lookAt = 60;
  private verdict: { target: number | null; at: number; kind: Look['kind'] } | null = null;
  private fightAt = 0; // next battle time a fight may be looked ahead
  private standAt = 0; // and a stand at a town
  private abandon = new Map<number, number>(); // towns given up after a look-ahead, until when
  private moraleLog = new Map<number, { t: number; m: number }[]>(); // each regiment's morale over the last 20 seconds
  private goAt = new Map<number, number>(); // towns whose gathered attackers have been sent in, until when
  private stageFrom = new Map<number, number>(); // when regiments began gathering short of each town
  private seenAt = new Map<number, number>(); // when each objective was last in sight // what the last look-ahead decided
  private fixed: number | null | undefined = undefined;
  private bridgeAt = new Map<number, Vec>(); // engineers on their way to bridge the river, and where
  private bridged = false; // this army has thrown its own bridge over the river
  private flankFor: number | null = null; // the attack the flank crossing below was chosen for
  private front: Front | null = null;
  private flank: Vec | null = null; // where that attack forms up beyond a quieter crossing, if anywhere // in a look-ahead copy: the attack it must make (null: none)

  /** Battle plan from the battle's seed (or given), so a replay of the same seed fights the same way. */
  constructor(readonly side: Side, seed = 1, opts: AIOptions = {}) {
    const h = Math.imul(seed * 2654435761 + side * 40503, 2246822519) >>> 0;
    this.seed = seed;
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
    if (this.look && world.phase === 'battle') this.stepLook(world);
    if (world.phase !== 'battle' || world.time - this.lastThink < 2) return [];
    this.lastThink = world.time;
    world.smarts[this.side].focus = this.params.focus > 0;
    return [...this.orders(world), ...this.reinforce(world)];
  }

  private homeX(offset: number): number {
    return this.side === 0 ? offset : MAP.width - offset;
  }

  private deploy(world: World): Command[] {
    if (world.sides[this.side].ready) return [];
    // At most openGuns batteries in the whole opening army (it starts with one): the cap on batteries means a
    // gun-heavy plan gets its guns from reinforcements anyway, so the opening buys infantry instead.
    let guns = 1;
    const deploy = this.doctrine.deploy.map((t): UnitTypeId => (t === 'artillery' && ++guns > this.params.openGuns ? 'line' : t));
    const buys = deploy.map((t, i): [UnitTypeId, number] => [t, [1200, 1800, 1500][i]]);
    const cmds: Command[] = buys.map(([type, y]) => ({
      kind: 'callIn', side: this.side, type, x: this.homeX(RULES.zoneStart + (type === 'artillery' ? 250 : 450)), y: this.side === 0 ? y : MAP.height - y,
    }));
    cmds.push({ kind: 'ready', side: this.side });
    return cmds;
  }

  /** Objectives in order of how much this side wants them, with how many regiments each needs. */
  private needs(world: World): { pos: Vec; need: number }[] {
    const needs = OBJECTIVES.map((o, i) => {
      const enemyNear = world.units.filter((u) => u.side !== this.side && u.seen[this.side] && u.state !== 'routing' && dist(u, o) < 600).length;
      const owned = world.owners[i] === this.side;
      let need = o.centre && o.kind === 'bridge' ? 3 : 2;
      if (owned && enemyNear === 0) {
        // A town we hold is only garrisoned while the enemy is within striking distance of it (further for home
        // towns, since losing everything loses the battle).
        const reach = o.home === this.side ? this.params.homeReach : RULES.garrisonThreat;
        // Horse covers ground fast, so enemy cavalry heading for an empty home town is a threat from further off.
        const threat = world.units.some((u) => u.side !== this.side && u.seen[this.side] && u.state !== 'routing'
          && (dist(u, o) < reach || (o.home === this.side && u.type === 'cavalry' && dist(u, o) < this.params.horseAlert)));
        need = threat ? 1 : 0;
      }
      need += Math.min(this.params.needCap, enemyNear);
      if (owned && this.plan.posture === 'defend' && enemyNear > 0) need += 1;
      if ((this.abandon.get(i) ?? -1) > world.time) need = 0;
      return { pos: { x: o.x, y: o.y }, need };
    });
    // Rather than send troops at every place the enemy holds at once, go for the few most worth it, in strength.
    const n = this.params.focusTargets;
    if (n > 0) {
      const mine = world.units.filter((u) => u.side === this.side && u.state !== 'routing');
      const anchor = this.frontAnchor(mine);
      const F = this.params.front > 0 ? this.front : null;
      const theirs = OBJECTIVES.map((_, i) => i).filter((i) => world.owners[i] === 1 - this.side);
      const score = (i: number) => {
        const o = OBJECTIVES[i];
        const s = sectorOf(o);
        const massing = F ? Math.min(2, F.massed[s] / Math.max(300, F.enemy[s])) : 1;
        return (massing * 1000) / (this.enemyPowerNear(o, 600) + 300) - dist(anchor, o) * 0.4 + (i === this.plan.target ? 1 : 0);
      };
      const keep = new Set(theirs.sort((a, b) => score(b) - score(a)).slice(0, n));
      for (const i of theirs) if (!keep.has(i)) needs[i].need = 0;
    }
    return needs;
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
    const goalOf = new Map<number, number>(); // objective each posted regiment was given
    const spare = new Set<number>();
    const hot = (P.frontReserve > 0 ? this.threatened(world) : null) ?? this.hotObjective(world, visibleEnemies);
    const infantry = mine.filter((u) => u.type === 'line' || u.type === 'light');
    // Worn regiments pull back to rest before they break, and come back once recovered.
    for (const u of infantry) {
      // Shaken regiments step back to recover before they break.
      const worn = u.meleeWith === null && u.morale < P.restAt;
      // So do regiments losing a fight fast, and ones low on rounds while nobody is in range to shoot at them.
      const drop = P.trend > 0 ? this.moraleDrop(world, u) : 0;
      const falling = P.trend > 0 && u.meleeWith === null && u.morale < P.trendBelow && drop >= P.trendDrop;
      const dry = P.ammoEarly > 0 && u.meleeWith === null && u.ammo < P.ammoAt
        && !visibleEnemies.some((e) => e.state !== 'routing' && !isSupport(e) && dist(e, u) < UNIT_TYPES[u.type].range * 1.5);
      if (worn || falling || dry) this.recovering.add(u.id);
      else if (u.morale > P.restedAt && (P.ammoEarly <= 0 || u.ammo >= 90)) this.recovering.delete(u.id);
    }
    // One fresh line regiment stays back as a reserve once the army is big enough to spare it.
    const reserve = this.pickReserve(infantry);
    this.assault.clear();
    // Engineers dig in at the held objective nearest the front that the enemy is not already at.
    for (const u of mine.filter((m) => m.type === 'engineers')) assigned.set(u.id, this.pontoonSite(world, u, visibleEnemies) ?? this.worksSite(world, u, visibleEnemies));
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
      goalOf.set(u.id, best);
    }
    if (this.front && P.front > 0 && P.frontPull > 0 && this.plan.target !== null) this.pullToAttack(world, infantry, visibleEnemies, goalOf, assigned, spare);
    // Regiments already marching on the town under attack join the attack rather than going in on their own.
    if (P.mergeAttack > 0 && this.plan.target !== null) {
      for (const u of infantry) if (goalOf.get(u.id) === this.plan.target) { this.assault.add(u.id); spare.add(u.id); goalOf.delete(u.id); }
    }
    const staging = P.together > 0 ? this.gather(world, mine, infantry, visibleEnemies, goalOf, assigned) : new Set<number>();
    const hunters = P.hunt > 0 ? this.assignHunters(mine, visibleEnemies, assigned, spare, reserve) : new Map<number, Unit>();
    const counters = P.counter > 0 ? this.counterAttacks(world, mine, visibleEnemies) : new Map<number, Unit>();
    if (P.scout > 0) this.watchObjectives(world, mine);
    const assaultOrders = this.plan.target !== null ? this.assaultOrders(world, cmds, mine, visibleEnemies) : new Set<number>();

    const helpers = this.assignHelpers(world, mine, visibleEnemies, assigned, spare);
    // Spare regiments that could press home, by the enemy each would go for: with group pressing, an enemy is only
    // attacked once two or more can go in together (or some are already at it).
    const pressing = new Map<number, number>();
    for (const u of mine) {
      if (u.type !== 'line' && u.type !== 'light') continue;
      if (u.order.kind === 'attack') { pressing.set(u.order.target, (pressing.get(u.order.target) ?? 0) + 1); continue; }
      if (!spare.has(u.id) || helpers.has(u.id) || this.recovering.has(u.id) || u.morale <= P.pressMorale) continue;
      const e = this.nearest(u, visibleEnemies);
      if (!e || dist(u, e) >= P.pressRange || e.state === 'routing' || formationOf(e) === 'fortified') continue;
      pressing.set(e.id, (pressing.get(e.id) ?? 0) + 1);
    }
    const together = (e: Unit) => P.groupPress <= 0 || (pressing.get(e.id) ?? 0) >= 2;
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
        // The general rides out to broken regiments it can reach safely, since only the general rallies a regiment
        // that has broken twice, and any rallies far sooner with the general there.
        const broken = u.type === 'general' && P.rally > 0 && !this.fallingBack.has(u.id) ? this.brokenToRally(world, u, visibleEnemies) : null;
        if (broken) {
          this.moveIfFar(cmds, u, clampToMap({ x: broken.x - this.dir() * 120, y: broken.y }, RULES.borderWidth + 80), 120);
          continue;
        }
        this.moveIfFar(cmds, u, clampToMap(p, RULES.borderWidth + 80), 200);
        continue;
      }

      if (u.type === 'cavalry') {
        if (P.scout > 0 && u.id === this.scoutId(mine)) {
          this.scoutOrders(world, cmds, u, mine, visibleEnemies);
          continue;
        }
        // Raiders range much further after guns, wagons and the general.
        // Deep raids only go for targets no formed infantry is guarding.
        const reach = this.doctrine.raid ? P.raidReach : P.cavReach;
        const guarded = (e: Unit) => visibleEnemies.some((g) => g !== e && (g.type === 'line' || g.type === 'light') && g.state !== 'routing' && dist(g, e) < 300);
        // Routing regiments are ridden down first, from further off, before they can rally.
        const chase = (e: Unit) => P.pursue > 0 && e.state === 'routing';
        const prey = visibleEnemies
          .filter((e) => dist(u, e) < reach + (chase(e) ? 300 : 0) && formationOf(e) !== 'fortified' && (e.state !== 'ok' || e.type === 'artillery' || e.type === 'light' || e.type === 'supply'
            || (e.type === 'general' && dist(u, e) < (this.doctrine.raid ? 1200 : 450)))
            && (dist(u, e) < P.cavReach || !guarded(e)))
          .sort((a, b) => dist(u, a) - (chase(a) ? 400 : 0) - dist(u, b) + (chase(b) ? 400 : 0))[0];
        // Otherwise hit the flank or rear of an enemy already fighting our infantry.
        const hunted = [...hunters.values()].filter((e) => dist(u, e) < P.cavReach && formationOf(e) !== 'fortified').sort((a, b) => dist(u, a) - dist(u, b))[0];
        const target = prey ?? hunted ?? visibleEnemies
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
      // Defenders charge out at a stalled attack, and hunters go for an enemy on its own.
      const charge = counters.get(u.id) ?? hunters.get(u.id);
      if (charge) {
        if (u.formation !== 'formation') cmds.push({ kind: 'formation', side: this.side, ids: [u.id], formation: 'formation' });
        if (u.order.kind !== 'attack' || u.order.target !== charge.id) cmds.push({ kind: 'attack', side: this.side, ids: [u.id], target: charge.id });
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
      if (spare.has(u.id) && nearest && nd < P.pressRange && nearest.state !== 'routing' && formationOf(nearest) !== 'fortified' && u.morale > P.pressMorale && odds >= P.pressOdds && together(nearest)) {
        if (u.formation !== 'formation') cmds.push({ kind: 'formation', side: this.side, ids: [u.id], formation: 'formation' });
        if (u.order.kind !== 'attack') cmds.push({ kind: 'attack', side: this.side, ids: [u.id], target: nearest.id });
        continue;
      }
      const finishing = P.finish > 0 && nearest?.state === 'wavering';
      const enemyWeak = nearest && nd < P.pounceRange * (finishing ? 1.6 : 1) && (nearest.state === 'wavering' || (u.morale > 65 && nearest.morale < u.morale - P.pounceGap));
      if ((u.type === 'line' || (finishing && u.type === 'light')) && enemyWeak && nearest) {
        if (u.formation !== 'formation') cmds.push({ kind: 'formation', side: this.side, ids: [u.id], formation: 'formation' });
        if (u.order.kind !== 'attack') cmds.push({ kind: 'attack', side: this.side, ids: [u.id], target: nearest.id });
        continue;
      }
      // Engineers throw up earthworks at their objective while it is quiet.
      if (u.type === 'engineers') {
        if (u.building > 0) continue;
        if (this.bridgeAt.get(u.id) === goal) {
          // At the river bank: bridge it once there; until then, march straight to the spot.
          if (dist(u, goal) < 50 && !u.moving && !world.buildBlocker(u)) cmds.push({ kind: 'build', side: this.side, ids: [u.id] });
          else this.moveIfFar(cmds, u, goal, 30);
          continue;
        }
        if (dist(u, goal) < 300 && nd > 400 && !u.moving && !world.buildBlocker(u)) {
          cmds.push({ kind: 'build', side: this.side, ids: [u.id] });
          continue;
        }
      }
      // Dig in early when holding an objective the enemy is coming for (it cannot start once in a fight), otherwise stay in formation and let long moves march.
      const atGoal = dist(u, goal) < 250;
      const cavThreat = visibleEnemies.some((e) => e.type === 'cavalry' && e.state === 'ok' && dist(e, u) < 300);
      // Troops already in a fight cannot start digging in, so only ask when the order will be accepted.
      const wanted = !staging.has(u.id) && atGoal && (nd < this.doctrine.fortifyAt * P.fortifyScale || cavThreat) && (u.formation === 'fortified' || world.canFortify(u)) ? 'fortified' : 'formation';
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

  /** How much a regiment's morale has fallen from its best in the last 20 seconds. */
  private moraleDrop(world: World, u: Unit): number {
    const log = this.moraleLog.get(u.id) ?? [];
    log.push({ t: world.time, m: u.morale });
    while (log.length && world.time - log[0].t > 20) log.shift();
    this.moraleLog.set(u.id, log);
    return Math.max(...log.map((s) => s.m)) - u.morale;
  }

  /**
   * Regiments sent at a defended town wait together short of it until enough have arrived to go in at once (or a
   * minute has passed), rather than walking in one at a time. Returns the regiments told to wait.
   */
  private gather(world: World, mine: Unit[], infantry: Unit[], enemies: Unit[], goalOf: Map<number, number>, assigned: Map<number, Vec>): Set<number> {
    const staging = new Set<number>();
    const anchor = this.frontAnchor(mine);
    const groups = new Map<number, Unit[]>();
    for (const u of infantry) {
      const g = goalOf.get(u.id);
      if (g === undefined) continue;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(u);
    }
    for (const [i, group] of groups) {
      const o = OBJECTIVES[i];
      const defended = enemies.some((e) => e.state !== 'routing' && !isSupport(e) && dist(e, o) < 600);
      if (world.owners[i] === this.side || group.length < 2 || !defended || (this.goAt.get(i) ?? -1) > world.time) { this.stageFrom.delete(i); continue; }
      const d = dist(anchor, o) || 1;
      const stage = clampToMap({ x: o.x + ((anchor.x - o.x) / d) * 650, y: o.y + ((anchor.y - o.y) / d) * 650 }, RULES.borderWidth + 100);
      const want = Math.min(group.length, Math.round(this.params.togetherN));
      const ready = group.filter((u) => dist(u, stage) < 300 || dist(u, o) < 450).length;
      if (!this.stageFrom.has(i)) this.stageFrom.set(i, world.time);
      if (ready >= want || world.time - this.stageFrom.get(i)! > 60) {
        this.goAt.set(i, world.time + 60);
        this.stageFrom.delete(i);
        continue;
      }
      for (const u of group) if (dist(u, o) >= 450) { assigned.set(u.id, stage); staging.add(u.id); }
    }
    return staging;
  }

  /**
   * Enemy regiments standing on their own (no other enemy within 500 m, not dug in, not in a town of theirs) are
   * hunted by the nearest free regiments, up to three, when together they are worth enough more than it.
   */
  private assignHunters(mine: Unit[], enemies: Unit[], assigned: Map<number, Vec>, spare: Set<number>, reserve: number | null): Map<number, Unit> {
    const P = this.params;
    const hunters = new Map<number, Unit>();
    const lone = enemies.filter((e) => e.state !== 'routing' && !isSupport(e) && e.type !== 'cavalry' && formationOf(e) !== 'fortified'
      && !enemies.some((o) => o !== e && o.state !== 'routing' && !isSupport(o) && dist(o, e) < 500));
    const canGo = (m: Unit) => {
      if (spare.has(m.id) && !this.assault.has(m.id)) return true;
      const goal = assigned.get(m.id);
      return !!goal && mine.some((o) => o.id !== m.id && (o.type === 'line' || o.type === 'light') && dist(o, goal) < 300);
    };
    const free = mine.filter((m) => (m.type === 'line' || m.type === 'light') && m.morale > 65 && m.meleeWith === null
      && !this.recovering.has(m.id) && m.id !== reserve && !this.assault.has(m.id) && canGo(m));
    for (const e of lone.sort((a, b) => this.value(a) - this.value(b))) {
      const near = free.filter((m) => !hunters.has(m.id) && dist(m, e) < P.huntReach).sort((a, b) => dist(a, e) - dist(b, e)).slice(0, 3);
      let worth = 0;
      const team: Unit[] = [];
      for (const m of near) {
        if (worth >= this.value(e) * P.huntOdds) break;
        team.push(m);
        worth += this.value(m);
      }
      if (worth < this.value(e) * P.huntOdds) continue;
      for (const m of team) hunters.set(m.id, e);
    }
    return hunters;
  }

  /** At a town we hold, when the enemy attacking it is shaken and we are a match for it, the defenders charge out. */
  private counterAttacks(world: World, mine: Unit[], enemies: Unit[]): Map<number, Unit> {
    const out = new Map<number, Unit>();
    OBJECTIVES.forEach((o, i) => {
      if (world.owners[i] !== this.side) return;
      const foes = enemies.filter((e) => e.state !== 'routing' && !isSupport(e) && dist(e, o) < 600);
      if (!foes.length) return;
      const morale = foes.reduce((a, e) => a + e.morale, 0) / foes.length;
      const ours = mine.filter((m) => (m.type === 'line' || m.type === 'light') && m.meleeWith === null && m.morale > 50 && !this.recovering.has(m.id) && dist(m, o) < 600);
      const worth = ours.reduce((a, m) => a + this.value(m), 0);
      if (morale >= this.params.counterMorale || worth < foes.reduce((a, e) => a + this.value(e), 0) * 0.8) return;
      for (const m of ours) out.set(m.id, this.nearest(m, foes)!);
    });
    return out;
  }

  /** Note which objectives our troops can see. */
  private watchObjectives(world: World, mine: Unit[]) {
    OBJECTIVES.forEach((o, i) => {
      if (mine.some((m) => dist(m, o) < UNIT_TYPES[m.type].sight * 0.8)) this.seenAt.set(i, world.time);
    });
  }

  /** The scout: the first cavalry regiment, once there are two or more. */
  private scoutId(mine: Unit[]): number | null {
    const cav = mine.filter((m) => m.type === 'cavalry').sort((a, b) => a.id - b.id);
    return cav.length >= 2 ? cav[0].id : null;
  }

  /** The scout rides to within sight of the place not ours that has gone unseen longest, and backs off from danger. */
  private scoutOrders(world: World, cmds: Command[], u: Unit, mine: Unit[], enemies: Unit[]) {
    const danger = enemies.find((e) => e.state !== 'routing' && !isSupport(e) && e.type !== 'artillery' && dist(e, u) < 600);
    if (danger) {
      const d = dist(danger, u) || 1;
      this.moveIfFar(cmds, u, clampToMap({ x: u.x + ((u.x - danger.x) / d) * 500, y: u.y + ((u.y - danger.y) / d) * 500 }, RULES.borderWidth + 80), 100);
      return;
    }
    let best = -1;
    let oldest = Infinity;
    OBJECTIVES.forEach((o, i) => {
      if (world.owners[i] === this.side) return;
      const t = (this.seenAt.get(i) ?? -999) + dist(u, o) / 100;
      if (t < oldest) { oldest = t; best = i; }
    });
    if (best < 0) {
      const anchor = this.frontAnchor(mine);
      this.moveIfFar(cmds, u, { x: anchor.x - this.dir() * 250, y: anchor.y });
      return;
    }
    const o = OBJECTIVES[best];
    const d = dist(u, o) || 1;
    const spot = d > 900 ? { x: o.x + ((u.x - o.x) / d) * 900, y: o.y + ((u.y - o.y) / d) * 900 } : { x: u.x, y: u.y };
    this.moveIfFar(cmds, u, clampToMap(spot, RULES.borderWidth + 80), 150);
  }

  /**
   * Mass for the attack: regiments posted in other sectors leave for it, as long as their sector keeps enough to
   * hold against the enemy facing it and every objective we hold keeps one regiment. Quiet posts go first.
   */
  private pullToAttack(world: World, infantry: Unit[], enemies: Unit[], goalOf: Map<number, number>, assigned: Map<number, Vec>, spare: Set<number>) {
    const F = this.front!;
    const t = this.plan.target!;
    const ts = sectorOf(OBJECTIVES[t]);
    const left = F.ours.slice();
    const posted = new Map<number, number>();
    for (const g of goalOf.values()) posted.set(g, (posted.get(g) ?? 0) + 1);
    const quiet = (i: number) => !enemies.some((e) => e.state !== 'routing' && !isSupport(e) && dist(e, OBJECTIVES[i]) < 700);
    const candidates = infantry.filter((u) => {
      const g = goalOf.get(u.id);
      return g !== undefined && g !== t && sectorOf(OBJECTIVES[g]) !== ts && u.meleeWith === null && u.underFire <= 0;
    }).sort((a, b) => (quiet(goalOf.get(b.id)!) ? 1 : 0) - (quiet(goalOf.get(a.id)!) ? 1 : 0) || dist(a, OBJECTIVES[t]) - dist(b, OBJECTIVES[t]) || a.id - b.id);
    for (const u of candidates) {
      const g = goalOf.get(u.id)!;
      const s = sectorOf(OBJECTIVES[g]);
      const v = this.value(u);
      if (world.owners[g] === this.side && (posted.get(g) ?? 0) <= 1) continue;
      if (left[s] - v < F.hold[s]) continue;
      left[s] -= v;
      posted.set(g, (posted.get(g) ?? 0) - 1);
      goalOf.delete(u.id);
      this.assault.add(u.id);
      assigned.set(u.id, OBJECTIVES[t]);
      spare.add(u.id);
    }
  }

  /**
   * Start a look-ahead. The copy of the battle holds only what this side knows: its own troops, and enemies in
   * sight or remembered where they were last seen. Enemies it has not seen are left out.
   */
  private startLook(world: World, options: (number | null)[], kind: Look['kind'] = 'attack') {
    const start = world.clone();
    start.units = start.units.filter((e) => e.side === this.side || e.seen[this.side] || this.memory.has(e.id));
    for (const e of start.units) {
      const s = this.memory.get(e.id);
      if (e.side !== this.side && !e.seen[this.side] && s) { e.x = s.x; e.y = s.y; }
    }
    this.look = { kind, start, options, scores: [], sim: null, ais: [], ends: 0 };
  }

  /** Play the look-ahead on a few ticks, and settle on the best option once each has been played. */
  private stepLook(world: World) {
    const L = this.look!;
    const P = this.params;
    // Works and bridges dug in the look-ahead must not appear on the real map.
    const works = EARTHWORKS.length;
    const crossings = CROSSINGS.length;
    const fight = L.kind === 'fight';
    for (let k = 0; k < (fight ? P.fightTicks : P.lookTicks); k++) {
      if (!L.sim) {
        L.sim = L.start.clone();
        L.ais = [this.copyFor(L.options[L.scores.length], L.kind), new AI((1 - this.side) as Side, this.seed, { params: { look: 0, fightLook: 0, standLook: 0 } })];
        L.ends = L.sim.time + (fight ? P.fightAhead : P.lookAhead);
      }
      for (const ai of L.ais) for (const c of ai.update(L.sim)) L.sim.apply(c);
      L.sim.step();
      if (L.sim.phase === 'ended' || L.sim.time >= L.ends) {
        L.scores.push(this.judge(L.sim));
        L.sim = null;
        if (L.scores.length === L.options.length) break;
      }
    }
    EARTHWORKS.length = works;
    CROSSINGS.length = crossings;
    if (L.scores.length < L.options.length) return;
    // The first option is the default (holding, or pressing on): another has to come out clearly better.
    const margin = fight ? P.fightMargin : P.lookMargin;
    let pick = 0;
    for (let i = 1; i < L.options.length; i++) if (L.scores[i] > L.scores[pick] + (pick === 0 ? margin : 0)) pick = i;
    this.verdict = { target: L.options[pick], at: world.time, kind: L.kind };
    this.look = null;
    if (!fight) this.lookAt = world.time + P.lookEvery;
  }

  /** A copy of this AI for a look-ahead, committed to one option and not looking ahead itself. */
  private copyFor(target: number | null, kind: Look['kind'] = 'attack'): AI {
    const { look, verdict, ...rest } = this as unknown as { look: unknown; verdict: unknown };
    void look; void verdict;
    const c = Object.assign(Object.create(AI.prototype), structuredClone(rest)) as AI;
    c.look = null;
    c.verdict = null;
    c.fixed = kind === 'stand' ? undefined : target;
    if (kind === 'stand' && target !== null) c.abandon.set(target, Infinity);
    c.lastThink = -999;
    c.plan.madeAt = -999;
    c.doctrine = this.doctrine;
    (c as { params: Params }).params = { ...this.params, look: 0, fightLook: 0, standLook: 0 };
    return c;
  }

  /** How well a look-ahead went for this side: the gap in army morale, and objectives held. */
  private judge(sim: World): number {
    if (sim.phase === 'ended') return sim.result!.winner === this.side ? 1000 : sim.result!.winner === -1 ? 0 : -1000;
    const held = (s: number) => sim.owners.filter((o) => o === s).length;
    return sim.sides[this.side].armyMorale - sim.sides[1 - this.side].armyMorale + 5 * (held(this.side) - held(1 - this.side));
  }

  /** The nearest routing regiment the general can ride to without coming near the enemy, if any. */
  private brokenToRally(world: World, g: Unit, enemies: Unit[]): Unit | null {
    const safe = (p: Vec) => !enemies.some((e) => e.state !== 'routing' && !isSupport(e) && dist(e, p) < this.params.shyOf);
    let best: Unit | null = null;
    let bd = this.params.rallyReach;
    for (const r of world.units) {
      if (r.side !== this.side || r.state !== 'routing') continue;
      const d = dist(g, r);
      if (d < bd && safe(r)) { bd = d; best = r; }
    }
    return best;
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

  /**
   * On river maps, once a battle, a spot on our bank for engineers to bridge the river: well away from every other
   * crossing and from the enemy, and as close as possible to an objective over the river that we do not hold,
   * so the army gets a way across that the enemy is not watching. Null once bridged, or when there is no such spot.
   */
  private pontoonSite(world: World, u: Unit, enemies: Unit[]): Vec | null {
    if (this.params.pontoon <= 0 || !RIVER.length || world.time < 60) return null;
    if (!this.bridged && CROSSINGS.some((c) => c.pontoon && dist(c, this.bridgeAt.get(u.id) ?? { x: -1e9, y: -1e9 }) < 250)) this.bridged = true;
    if (this.bridged) { this.bridgeAt.delete(u.id); return null; }
    const kept = this.bridgeAt.get(u.id);
    if (kept && !enemies.some((e) => e.state !== 'routing' && !isSupport(e) && dist(e, kept) < 600)) return kept;
    const ourBank = riverSide({ x: this.homeX(300), y: MAP.height / 2 });
    const targets = OBJECTIVES.filter((o, i) => world.owners[i] !== this.side && riverSide(o) !== ourBank && o.kind !== 'bridge');
    if (!targets.length) return null;
    let best: Vec | null = null;
    let bestScore = Infinity;
    for (let i = 0; i < RIVER.length - 1; i++) {
      const a = RIVER[i];
      const b = RIVER[i + 1];
      const len = dist(a, b);
      const n = { x: -(b.y - a.y) / (len || 1), y: (b.x - a.x) / (len || 1) };
      for (let t = 0; t < len; t += 60) {
        const q = { x: a.x + ((b.x - a.x) * t) / len, y: a.y + ((b.y - a.y) * t) / len };
        if (CROSSINGS.some((c) => dist(c, q) < this.params.pontoonGap)) continue;
        let p = { x: q.x + n.x * 90, y: q.y + n.y * 90 };
        if (riverSide(p) !== ourBank) p = { x: q.x - n.x * 90, y: q.y - n.y * 90 };
        if (riverSide(p) !== ourBank || (nearestRiverPoint(p)?.d ?? 0) > 130) continue;
        if (p.y < 300 || p.y > MAP.height - 300) continue;
        if (enemies.some((e) => e.state !== 'routing' && !isSupport(e) && dist(e, p) < 700)) continue;
        const score = Math.min(...targets.map((o) => dist(o, q))) + dist(u, p) * 0.3;
        if (score < bestScore) { bestScore = score; best = p; }
      }
    }
    if (best) this.bridgeAt.set(u.id, best);
    else this.bridgeAt.delete(u.id);
    return best;
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
      const shaky = this.params.finish > 0 && (e.state === 'wavering' || e.morale < 45) ? 3 : 0;
      const score = crowd + attacking + fortified + prep + shaky - friends * 2 - (d > range ? 1.5 : 0);
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
  private assignHelpers(world: World, mine: Unit[], enemies: Unit[], assigned: Map<number, Vec>, spare: Set<number>) {
    const helpers = new Map<number, { spot: Vec; dist: number; attacker: Unit }>();
    const busy = (m: Unit) => m.meleeWith !== null || m.underFire > 0 || m.building > 0
      || enemies.some((e) => e.state !== 'routing' && dist(e, m) < 600);
    const canSpare = (m: Unit) => {
      if (spare.has(m.id)) return true;
      const goal = assigned.get(m.id);
      if (!goal) return false;
      // Another regiment shares this post, so this one can leave; or no enemy is anywhere near the post.
      return mine.some((o) => o.id !== m.id && (o.type === 'line' || o.type === 'light') && dist(o, goal) < 300)
        || !enemies.some((e) => e.state !== 'routing' && !isSupport(e) && dist(e, goal) < this.params.postSafe);
    };
    const free = mine.filter((m) => (m.type === 'line' || m.type === 'light') && m.morale > 60 && !busy(m) && canSpare(m));
    const pressed = mine.filter((m) => !isSupport(m) && (m.underFire > 0 || m.meleeWith !== null));
    // Routing friends with enemy horse on their heels are worth saving too: a volley drives the cavalry off.
    if (this.params.rescue > 0) {
      for (const r of world.units) {
        if (r.side !== this.side || r.state !== 'routing') continue;
        if (enemies.some((e) => e.type === 'cavalry' && e.state !== 'routing' && dist(e, r) < 300)) pressed.push(r);
      }
    }
    for (const friend of pressed) {
      const attacker = enemies
        .filter((e) => e.state !== 'routing' && (friend.meleeWith === e.id || dist(e, friend) < 450))
        .sort((a, b) => (a.type === 'cavalry' ? 0 : 1) - (b.type === 'cavalry' ? 0 : 1) || dist(a, friend) - dist(b, friend))[0];
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
    const gunEvery = Math.max(1, Math.round(d.artilleryEvery * this.params.gunEvery));
    const lightEvery = Math.max(2, Math.round(d.lightEvery * this.params.lightEvery));
    if (this.calls % gunEvery === gunEvery - 1) prefs.push('artillery');
    if (count('cavalry') < d.cavalry) prefs.push('cavalry');
    if (this.calls % lightEvery === 1) prefs.push('light');
    prefs.push('line');
    // Take the first type that can be called in; a capped or cooling type should not hold up the rest.
    const wanted = prefs.find((t) => !world.callInBlocker(this.side, t));
    if (!wanted) return [];
    const cmds: Command[] = [];
    if (s.manpower < UNIT_TYPES[wanted].cost) {
      // Short of men with room in the field: requisition, if the army is steady enough to pay for it in morale.
      const them = world.sides[1 - this.side];
      const room = world.units.filter((u) => u.side === this.side && !isSupport(u)).length < RULES.fieldCap - 2;
      if (this.params.requisition > 0 && !s.requisitionUsed && room && world.time > 90
        && s.armyMorale - RULES.requisitionMoraleCost > this.params.requisitionMorale && s.armyMorale >= them.armyMorale + this.params.requisitionLead) {
        cmds.push({ kind: 'requisition', side: this.side });
      } else return [];
    }
    const needs = this.needs(world).sort((a, b) => b.need - a.need);
    this.calls += 1;
    // During an attack, fresh troops arrive on the attack's side of the map to feed it.
    const towards = this.params.callAtAttack > 0 && this.plan.target !== null ? OBJECTIVES[this.plan.target].y : needs[0].pos.y;
    const y = Math.max(100, Math.min(MAP.height - 100, towards));
    cmds.push({ kind: 'callIn', side: this.side, type: wanted, x: this.homeX(RULES.zoneStart + RULES.zoneDepth - 150), y });
    return cmds;
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

  /** The objective we hold nearest the enemy in the sector where the enemy most outweighs us, if it does anywhere. */
  private threatened(world: World): Vec | null {
    const F = this.front;
    if (!F) return null;
    let s = -1;
    let gap = 0;
    for (let i = 0; i < 3; i++) if (F.enemy[i] - F.ours[i] > gap) { gap = F.enemy[i] - F.ours[i]; s = i; }
    if (s < 0) return null;
    const foes = [...this.memory.values()].filter((e) => sectorOf(e) === s);
    const centre = foes.length ? { x: foes.reduce((a, e) => a + e.x, 0) / foes.length, y: foes.reduce((a, e) => a + e.y, 0) / foes.length } : null;
    let best: Vec | null = null;
    let bd = Infinity;
    OBJECTIVES.forEach((o, i) => {
      if (world.owners[i] !== this.side || sectorOf(o) !== s || !centre) return;
      const d = dist(o, centre);
      if (d < bd) { bd = d; best = o; }
    });
    return best;
  }

  /** Strength on each side in each sector of the front, and what each sector could spare for an attack elsewhere. */
  private readFront(mine: Unit[]): Front {
    const enemy = [0, 0, 0];
    const ours = [0, 0, 0];
    const mobile = [0, 0, 0];
    for (const s of this.memory.values()) enemy[sectorOf(s)] += s.value;
    for (const u of mine) {
      if (isSupport(u) || u.type === 'engineers') continue;
      const v = this.value(u);
      ours[sectorOf(u)] += v;
      if (u.type !== 'artillery') mobile[sectorOf(u)] += v;
    }
    const hold = enemy.map((e) => e * this.params.frontHold);
    const spare = ours.map((o, i) => Math.min(mobile[i], Math.max(0, o - hold[i])));
    const total = spare.reduce((a, b) => a + b, 0);
    const massed = ours.map((o, i) => o + total - spare[i]);
    return { enemy, ours, hold, spare, massed };
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
    this.standOrGo(world, mine);
    if (world.time - p.madeAt < 10) return;
    p.madeAt = world.time;
    if (P.front > 0 || P.frontReserve > 0) this.front = this.readFront(mine);

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
    // With the clock draining both armies, a side well ahead only has to hold on.
    if (P.clock > 0 && world.time > RULES.timePressureAt && me.armyMorale > them.armyMorale + P.clockLead) p.posture = 'defend';

    if (p.posture === 'defend') {
      if (p.target !== null) this.endAttack(world, true);
      return;
    }
    if (world.time < p.restUntil) return;
    // The whole front at a glance: where could we mass more force than the enemy has there?
    const F = P.front > 0 ? this.front : null;
    const odds = (i: number) => (F ? F.massed[sectorOf(OBJECTIVES[i])] / Math.max(300, F.enemy[sectorOf(OBJECTIVES[i])]) : 0);

    // Check the attack in progress is still worth pressing.
    const group = mine.filter((u) => this.assault.has(u.id));
    // An attack nobody can be spared for is called off rather than left hanging.
    if (p.target !== null && !group.length && world.time - p.phaseAt > 30) {
      this.endAttack(world, true);
      return;
    }
    if (p.target !== null && p.phase === 'assault' && group.length && P.fightLook > 0 && this.fixed === undefined) {
      // Rather than a rule of thumb, play the fight forward both ways: pressing on, and calling the attack off.
      const v = this.verdict;
      if (v && v.kind === 'fight' && world.time - v.at < 10) {
        this.verdict = null;
        if (v.target === null) {
          this.endAttack(world, true);
          return;
        }
      }
      if (!this.look && world.time >= this.fightAt) {
        this.startLook(world, [p.target, null], 'fight');
        this.fightAt = world.time + P.fightEvery;
      }
    } else if (p.target !== null && p.phase === 'assault' && group.length) {
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
    const behind = P.comeback > 0 && me.armyMorale < them.armyMorale - P.comebackGap && heldByThem > 0 && RULES.recaptureMorale > 0;
    const limit = desperate ? 2 : P.takeOdds;
    let best: number | null = null;
    let bestScore = -Infinity;
    const ranked: [number, number][] = [];
    OBJECTIVES.forEach((o, i) => {
      if (world.owners[i] === this.side) return;
      const defence = this.enemyPowerNear(o, 600);
      if (defence > strike * limit) return;
      // Our own home towns come first, then whatever the enemy holds, the centre, and depots (income).
      const worth = (o.centre ? 1.5 : o.kind === 'depot' ? 1.2 : 1) * (world.owners[i] === 1 - this.side ? 1.3 : 1) * (o.home === this.side ? 2 : 1)
        // Behind on morale, taking places back from the enemy is how to win it back.
        * (behind && world.owners[i] === 1 - this.side ? P.comebackWorth : 1);
      // A one-wing plan prefers objectives on its chosen flank.
      const onWing = this.doctrine.wing && (o.y - MAP.height / 2) * this.dir() * this.wingSign > 200 ? 1.5 : 1;
      // Reading the whole front, the sector where we can mass the most against the least is the place to strike.
      const massing = F ? Math.min(2, odds(i) / P.frontRatio) : 1;
      const score = (worth * onWing * massing * 1000) / (defence + 300) - dist(anchor, o) * 0.4 + (i === p.target ? 0.6 : 0);
      ranked.push([score, i]);
      if (score > bestScore) { bestScore = score; best = i; }
    });
    ranked.sort((a, b) => b[0] - a[0]);
    // In test battles, holding objectives and letting the enemy come beat attacking whenever ahead, so a set-piece
    // attack is only launched when the army must: late in the battle and behind, or holding no objective at all.
    // The rest of the time, spare regiments still pounce wherever they have the numbers.
    const willing = (this.doctrine.attack === 'stronger' && p.posture === 'attack') || (behind && ratio > 0.8)
      || (F !== null && P.frontWill > 0 && best !== null && odds(best) > P.frontRatio);
    if (this.fixed !== undefined) {
      // A look-ahead copy makes the attack it was given, or none.
      best = this.fixed !== null && world.owners[this.fixed] !== this.side ? this.fixed : null;
    } else if (P.look > 0 && (this.verdict || this.look || ranked.length)) {
      // Rather than a rule of thumb, play the battle forward: holding, and attacking each of the two likeliest
      // objectives. Until a look has an answer, keep to the rule of thumb.
      if (!this.look && p.target === null && world.time >= this.lookAt && ranked.length) {
        this.startLook(world, [null, ...ranked.slice(0, 2).map(([, i]) => i)]);
      }
      const v = this.verdict?.kind === 'attack' ? this.verdict : null;
      const attacking = v && v.target !== null && p.target === v.target && world.owners[v.target] !== this.side;
      const fresh = v && world.time - v.at < 20;
      if (attacking) best = v.target;
      else if (fresh) best = v.target !== null && world.owners[v.target] !== this.side ? v.target : null;
      else if (!desperate && !(late && losing) && !willing) best = null;
    } else if (!desperate && !(late && losing) && !willing) best = null;
    if (best !== p.target) {
      if (p.target !== null) this.endAttack(world, false);
      if (best !== null) {
        p.target = best;
        p.phase = 'gather';
        p.phaseAt = world.time;
      }
    }
  }

  /**
   * Where our troops are fighting a stronger enemy for a town, play it forward both ways: standing, and giving the
   * town up so its defenders go elsewhere. Gives it up for a while when that comes out better.
   */
  private standOrGo(world: World, mine: Unit[]) {
    const P = this.params;
    if (P.standLook <= 0 || this.fixed !== undefined) return;
    const v = this.verdict;
    if (v && v.kind === 'stand') {
      this.verdict = null;
      if (v.target !== null && world.time - v.at < 10) this.abandon.set(v.target, world.time + P.standFor);
    }
    if (this.look || world.time < this.standAt) return;
    let pick: number | null = null;
    let worst = P.standOdds;
    OBJECTIVES.forEach((o, i) => {
      if ((this.abandon.get(i) ?? -1) > world.time) return;
      const ours = mine.filter((u) => !isSupport(u) && dist(u, o) < 600).reduce((a, u) => a + this.value(u), 0);
      const theirs = this.enemyPowerNear(o, 600);
      if (ours > 0 && theirs / ours >= worst) { worst = theirs / ours; pick = i; }
    });
    if (pick === null) return;
    this.startLook(world, [null, pick], 'stand');
    this.standAt = world.time + P.fightEvery;
  }

  private endAttack(world: World, failed: boolean) {
    if (this.verdict && this.verdict.target === this.plan.target) this.verdict = null;
    this.plan.target = null;
    this.plan.phase = 'gather';
    if (failed) this.plan.restUntil = world.time + this.params.restAfter;
  }

  /** Where the assault group forms up: short of the objective, on the side facing our army. */
  private stagingPoint(mine: Unit[]): Vec {
    const t = OBJECTIVES[this.plan.target!];
    const from = this.frontAnchor(mine);
    // Settled once per attack, so the group does not swing between two ways in.
    if (this.flankFor !== this.plan.target) {
      this.flankFor = this.plan.target;
      this.flank = this.params.flankCross > 0 ? this.flankCrossing(from, t) : null;
    }
    if (this.flank) return this.flank;
    let dx = from.x - t.x;
    let dy = from.y - t.y;
    const len = Math.hypot(dx, dy);
    if (len < 200) { dx = -this.dir(); dy = 0; } else { dx /= len; dy /= len; }
    return clampToMap({ x: t.x + dx * 600, y: t.y + dy * 600 }, RULES.borderWidth + 100);
  }

  /**
   * When the objective lies over the river (or is a bridge) and the direct way is defended, a quieter crossing to
   * form up beyond, so the attack comes in from the enemy's bank or flank instead of straight over the bridge.
   */
  private flankCrossing(from: Vec, t: Vec & { kind: string }): Vec | null {
    if (!RIVER.length) return null;
    const onRiver = t.kind === 'bridge';
    if (!onRiver && !crossesRiver(from, t)) return null;
    const direct = this.enemyPowerNear(t, 600);
    if (direct <= 0) return null;
    const ourBank = riverSide(from);
    let best: Vec | null = null;
    let bestCost = Infinity;
    for (const c of CROSSINGS) {
      if (dist(c, t) < 300) continue; // that is the direct way
      const held = this.enemyPowerNear(c, 500);
      if (held > direct * this.params.flankOdds) continue;
      const landing = { x: c.x + this.dir() * 260, y: c.y };
      if (riverSide(landing) === ourBank) continue;
      const cost = dist(from, c) + dist(c, t) + held;
      if (cost < bestCost) { bestCost = cost; best = landing; }
    }
    if (!best) return null;
    // Form up a little way from the landing towards the objective, still clear of musket range.
    const d = dist(best, t);
    const k = d > 700 ? Math.min(0.5, (d - 600) / d) : 0;
    return clampToMap({ x: best.x + (t.x - best.x) * k, y: best.y + (t.y - best.y) * k }, RULES.borderWidth + 100);
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
