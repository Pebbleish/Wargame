import {
  CAVALRY_FORMATION_SPEED, EXPERIENCE, Experience, FORMATION, FORMATIONS, Formation, MAP, RULES, UNIT_SIZE, UNIT_TYPES, UnitTypeId,
} from './config';
import {
  CROSSINGS, EARTHWORKS, OBJECTIVES, Vec, addEarthwork, addPontoon, clampToMap, crossesRiver, dist,
  MapData, generateMap, loadMap, nearCrossing, nearestRiverPoint, planRoute, terrainAt,
} from './map';
import { Rng } from './rng';
import { mapFor } from './fairmaps';

export type Side = 0 | 1;
export type UnitState = 'ok' | 'wavering' | 'routing';

export type Order =
  | { kind: 'hold' }
  | { kind: 'move'; x: number; y: number; facing?: number }
  | { kind: 'attack'; target: number; retaliate?: boolean };

export interface Unit {
  id: number;
  side: Side;
  type: UnitTypeId;
  name: string;
  x: number;
  y: number;
  facing: number;
  men: number;
  maxMen: number;
  morale: number;
  formation: Formation;
  order: Order;
  waypoints: Vec[];
  state: UnitState;
  routs: number;
  holdPosition: boolean; // ordered to hold: will not chase whoever attacks it
  lastAttacker: number | null; // the most recent enemy to hurt this unit
  building: number; // engineers: seconds of work left on earthworks or a pontoon bridge
  buildKind: 'earthwork' | 'pontoon' | null;
  brigade: number; // index into the side's brigades
  fatigue: number; // 0 fresh to 100 exhausted
  ammo: number; // 100 full, 0 out of rounds
  xp: number; // experience points, see EXPERIENCE
  digIn: number; // seconds until a fortifying unit is dug in
  edgeTime: number; // seconds a shaken unit has spent pinned against the map border
  underFire: number; // seconds of "recently hit" left
  firedAt: number; // battle time of last volley, for smoke
  meleeWith: number | null;
  charged: number[]; // targets this cavalry unit already hit with a charge
  moving: boolean;
  marching: boolean; // temporarily marching for a long move, back to formation on arrival
  seen: [boolean, boolean]; // seen[side] = visible to that side
  group: number; // regiments ordered together march at the pace of the slowest
  prev: { x: number; y: number; facing: number }; // position at the start of the tick, for smooth drawing
  fireZone: Vec | null; // artillery: the area it is bombarding
  reload: number; // artillery: seconds until the next shell
  suppliedUntil: number; // battle time until which the last supply cart to reach this unit keeps it supplied
  cartAt: number; // supply wagons: battle time the next cart can leave
  shotAt: number | null; // the enemy it fired at last, which it keeps shooting while that still makes sense
  flankedAt: number; // battle time it was last hit in the flank or rear
  note: Note | null; // something it is doing on its own initiative, for the display
  noteFor: Order | null; // the order the note belongs to: it lapses once the regiment gets another
}

export type Note = 'bracing' | 'fallingBack' | 'ammo';

/** A regiment brought to a battle from outside it (the campaign): its arm, strength and experience. */
export interface ArmyEntry {
  type: UnitTypeId;
  men: number;
  xp: number;
  army?: number; // campaign: the allied or enemy army this regiment belongs to (none: the player's own)
  town?: number; // campaign: the town whose garrison it is
}

/** What drags a side's army morale down, in points. */
export interface MoraleBreakdown {
  losses: number;
  routing: number;
  removed: number;
  objectives: number;
  time: number;
  regained: number; // morale won back: objectives retaken from the enemy, and regiments rallied
}

/**
 * What regiments do for themselves without orders. Every switch is on in the game; tests turn them off for one
 * side to measure what each is worth.
 */
export interface Smarts {
  target: boolean; // shoot the shakiest enemy in front, not just the nearest
  brace: boolean; // stop and face cavalry charging in
  bait: boolean; // do not leave position to go after attackers that are dug in, in cover or stronger
  fallBack: boolean; // a wavering regiment with no orders steps back out of musket range to recover
  shells: boolean; // marching troops go round ground the enemy guns are shelling
  ammo: boolean; // a regiment out of ammunition with nothing to do walks to the supply wagons
  focus: boolean; // with smart targeting, prefer the enemy other regiments are already shooting (the AI turns it on)
}

export const ALL_SMARTS: Smarts = { target: true, brace: true, bait: true, fallBack: true, shells: true, ammo: true, focus: false };

export interface Impact {
  x: number;
  y: number;
  t: number;
  side: Side; // whose battery fired it
}

/** A cart of ammunition on its way from the wagon train to a regiment. It can be shot up on the road. */
export interface Cart {
  side: Side;
  wagon: number;
  target: number; // the regiment it is driving to
  x: number;
  y: number;
  hp: number;
  seen: [boolean, boolean];
}

export interface Brigade {
  name: string;
  kind: 'infantry' | 'cavalry' | 'artillery' | 'army';
}

export interface CallIn {
  side: Side;
  type: UnitTypeId;
  readyAt: number;
  x: number;
  y: number;
}

export interface SideState {
  nation: string;
  manpower: number;
  cooldowns: Record<UnitTypeId, number>;
  queue: CallIn[];
  requisitionUsed: boolean;
  objectiveDrain: number;
  timeDrain: number; // army morale lost to the clock so far
  regained: number;
  lostMen: number;
  fieldedMen: number;
  removed: number;
  armyMorale: number;
  score: number;
  ready: boolean;
  nameCounters: Record<UnitTypeId, number>;
  works: number;
  brigades: Brigade[];
  generalLost: boolean;
}

export interface GameEvent {
  t: number;
  side: Side | -1;
  text: string;
}

export type Command =
  | { kind: 'move'; side: Side; moves: { id: number; x: number; y: number }[]; facing?: number }
  | { kind: 'attack'; side: Side; ids: number[]; target: number }
  | { kind: 'bombard'; side: Side; ids: number[]; x: number; y: number }
  | { kind: 'ceaseFire'; side: Side; ids: number[] }
  | { kind: 'hold'; side: Side; ids: number[] }
  | { kind: 'formation'; side: Side; ids: number[]; formation?: Formation }
  | { kind: 'build'; side: Side; ids: number[] }
  | { kind: 'callIn'; side: Side; type: UnitTypeId; x: number; y: number }
  | { kind: 'requisition'; side: Side }
  | { kind: 'ready'; side: Side }
  | { kind: 'resign'; side: Side };

export interface Result {
  winner: Side | -1;
  reason: string;
}

const DT = 1 / RULES.tickRate;

const NAMES: Record<UnitTypeId, string[]> = {
  line: ['Fusiliers', 'Grenadiers', 'Musketeers', 'Line Infantry'],
  light: ['Jäger', 'Rifles'],
  cavalry: ['Hussars', 'Dragoons', 'Uhlans'],
  artillery: ['Field Battery'],
  engineers: ['Pioneers'],
  supply: ['Supply Train'],
  general: ['Army HQ'],
};

export function experienceOf(u: Pick<Unit, 'xp'>): Experience {
  return u.xp >= EXPERIENCE.elite.xp ? 'elite' : u.xp >= EXPERIENCE.veteran.xp ? 'veteran' : u.xp >= EXPERIENCE.trained.xp ? 'trained' : 'green';
}

/** Support units that never fight on their own initiative or take ground. */
export function isSupport(u: Pick<Unit, 'type'>): boolean {
  return u.type === 'general' || u.type === 'supply';
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function angleDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

type FormationView = Pick<Unit, 'formation'> & { marching?: boolean; digIn?: number };

/** The formation a unit is effectively in: long moves are marched, and fortifying takes time. */
export function formationOf(u: FormationView): Formation {
  if (u.marching) return 'marching';
  if (u.formation === 'fortified' && (u.digIn ?? 0) > 0) return 'formation';
  return u.formation;
}

export function unitSize(u: Pick<Unit, 'type'> & FormationView): { w: number; d: number } {
  return UNIT_SIZE[u.type][u.marching ? 'marching' : u.formation];
}

export function unitRadius(u: Pick<Unit, 'type'> & FormationView): number {
  const s = unitSize(u);
  return (s.w + s.d) / 4;
}

export function inZone(side: Side, p: Vec): boolean {
  if (p.y < 0 || p.y > MAP.height) return false;
  const x = side === 0 ? p.x : MAP.width - p.x;
  return x >= RULES.zoneStart && x <= RULES.zoneStart + RULES.zoneDepth;
}

export function homeEdgeX(side: Side): number {
  return side === 0 ? 0 : MAP.width;
}

function newSide(nation: string): SideState {
  const zero = { line: 0, light: 0, cavalry: 0, artillery: 0, engineers: 0, supply: 0, general: 0 };
  return {
    nation,
    manpower: RULES.startingBudget,
    cooldowns: { ...zero },
    queue: [],
    requisitionUsed: false,
    objectiveDrain: 0,
    timeDrain: 0,
    regained: 0,
    lostMen: 0,
    fieldedMen: 0,
    removed: 0,
    armyMorale: 100,
    score: 0,
    ready: false,
    nameCounters: { ...zero },
    works: 0,
    brigades: [
      { name: 'Army Troops', kind: 'army' },
      { name: 'Cavalry Brigade', kind: 'cavalry' },
      { name: 'Artillery Reserve', kind: 'artillery' },
    ],
    generalLost: false,
  };
}

export class World {
  phase: 'deploy' | 'battle' | 'ended' = 'deploy';
  deployLeft = RULES.deploymentTime;
  deployTimeLimit = true; // false: deployment lasts until both sides are ready (the tutorial)
  deployKeepOut: { x: number; y: number; r: number } | null = null; // nobody may deploy inside this ring
  lords: [string | null, string | null] = [null, null]; // campaign: a lord leading a side in person; losing them costs far more
  lordLossMorale = 30; // extra army morale lost when a lord falls
  timePressure: [number, number] = [1, 1]; // how hard the clock wears on each army (a town's defenders can wait; its attackers cannot)
  domination: [number, number] = [0, 0]; // seconds each side has held every objective
  time = 0;
  units: Unit[] = [];
  sides: [SideState, SideState];
  owners: (Side | -1)[] = [];
  capture: { side: Side | -1; t: number }[] = []; // who is taking each town, and how far along (seconds)
  events: GameEvent[] = [];
  result: Result | null = null;
  impacts: Impact[] = [];
  carts: Cart[] = [];
  smarts: [Smarts, Smarts] = [{ ...ALL_SMARTS }, { ...ALL_SMARTS }];
  reinforcements = true; // false: no manpower and no call-ins (campaign battles, the tutorial)
  autoEnd = true; // false: the battle only ends when told to (the tutorial)
  endWhenWiped = false; // a side with no fighting regiments left on the field loses
  private lastCartLog: [number, number] = [-99, -99];
  rng: Rng;
  private nextId = 1;
  private nextGroup = 1;
  private groupSpeed = new Map<number, number>();

  /** mapSeed picks the battlefield; by default one of the maps vetted as fair (see fairmaps.ts) is taken from the seed. */
  constructor(seed = 1, nations: [string, string] = ['Valdmark', 'Ostmark'], map: number | MapData = mapFor(seed)) {
    if (typeof map === 'number') generateMap(map);
    else loadMap(map);
    this.owners = OBJECTIVES.map(() => -1);
    this.capture = OBJECTIVES.map(() => ({ side: -1 as Side | -1, t: 0 }));
    this.rng = new Rng(seed);
    this.sides = [newSide(nations[0]), newSide(nations[1])];
    for (const side of [0, 1] as Side[]) this.placeCore(side);
  }

  /** An independent copy of the battle that can be played forward (the AI's look-ahead). The log is left behind. */
  clone(): World {
    const { rng, events, ...rest } = this as unknown as { rng: Rng; events: GameEvent[] };
    const c = Object.assign(Object.create(World.prototype), structuredClone(rest)) as World;
    c.rng = rng.copy();
    c.events = [];
    void events;
    return c;
  }

  // ---------- setup ----------

  /** The two towns on a side's own half, where its starting army stands. */
  homeTowns(side: Side): Vec[] {
    return OBJECTIVES.filter((o) => o.home === side);
  }

  /**
   * Field given armies instead of the usual starting ones (campaign battles, the tutorial): each side's regiments,
   * with their strength and experience, drawn up in rows in front of its home towns, plus its general and a supply
   * train. Returns the unit id each regiment became, in order, so the survivors can be matched up afterwards.
   */
  fieldArmies(armies: [ArmyEntry[], ArmyEntry[]]): [number[], number[]] {
    this.units = [];
    const out: [number[], number[]] = [[], []];
    for (const side of [0, 1] as Side[]) {
      const s = this.sides[side];
      s.nameCounters = { line: 0, light: 0, cavalry: 0, artillery: 0, engineers: 0, supply: 0, general: 0 };
      const [a, b] = this.homeTowns(side);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const dir = side === 0 ? 1 : -1;
      const order: UnitTypeId[] = ['line', 'light', 'artillery', 'cavalry', 'engineers', 'supply'];
      const list = armies[side].map((e, i) => ({ e, i })).sort((p, q) => order.indexOf(p.e.type) - order.indexOf(q.e.type));
      const perRow = 6;
      list.forEach(({ e, i }, k) => {
        const row = Math.floor(k / perRow);
        const inRow = Math.min(perRow, list.length - row * perRow);
        const col = (k % perRow) - (inRow - 1) / 2;
        const p = clampToMap({ x: mid.x + dir * (200 - row * 170), y: mid.y + col * 180 }, RULES.borderWidth + 80);
        const u = this.spawn(side, e.type, p.x, p.y, { brigade: this.brigadeFor(side, e.type), xp: e.xp });
        u.men = Math.max(1, Math.min(u.maxMen, e.men));
        out[side][i] = u.id;
      });
      const back = (dx: number, dy: number) => clampToMap({ x: mid.x - dir * dx, y: mid.y + dy }, RULES.borderWidth + 80);
      const g = back(260, -120);
      this.spawn(side, 'general', g.x, g.y, { brigade: 0 });
      const w = back(420, 160);
      this.spawn(side, 'supply', w.x, w.y, { brigade: 0 });
    }
    return out;
  }

  /** The starting army garrisons its two home towns; guns and horse wait between them. */
  private placeCore(side: Side) {
    const [a, b] = this.homeTowns(side);
    const dir = side === 0 ? 1 : -1;
    const at = (t: Vec, dx: number, dy: number) => ({ x: t.x + dx * dir, y: t.y + dy * dir });
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    // Each town is held by its own brigade; the general and the supply train stand back between them.
    const first = this.newBrigade(side);
    const second = this.newBrigade(side);
    const spots: [UnitTypeId, Vec, number?][] = [
      ['line', at(a, 170, -190), first], ['line', at(a, 170, 190), first], ['light', at(a, 300, 0), first],
      ['line', at(b, 170, -190), second], ['line', at(b, 170, 190), second], ['line', at(b, -150, 0), second],
      ['artillery', at(mid, -60, 0)], ['cavalry', at(mid, -320, 0)], ['engineers', at(mid, -200, 120)],
      ['general', at(mid, -250, -120)], ['supply', at(mid, -420, -200)], ['supply', at(mid, -420, 200)],
    ];
    for (const [type, p, brigade] of spots) {
      const q = clampToMap(p, RULES.borderWidth + 80);
      this.spawn(side, type, q.x, q.y, { brigade, xp: RULES.coreXp });
    }
  }

  private newBrigade(side: Side): number {
    const list = this.sides[side].brigades;
    const n = list.filter((b) => b.kind === 'infantry').length + 1;
    list.push({ name: `${ordinal(n)} Brigade`, kind: 'infantry' });
    return list.length - 1;
  }

  /** New infantry fills up the smallest brigade, or forms a new one; other arms have a brigade each. */
  private brigadeFor(side: Side, type: UnitTypeId): number {
    if (type === 'cavalry') return 1;
    if (type === 'artillery') return 2;
    if (type !== 'line' && type !== 'light') return 0;
    const list = this.sides[side].brigades;
    let best = -1;
    let bestSize = RULES.brigadeSize;
    list.forEach((b, i) => {
      if (b.kind !== 'infantry') return;
      const size = this.units.filter((u) => u.side === side && u.brigade === i).length;
      if (size < bestSize) { bestSize = size; best = i; }
    });
    return best === -1 ? this.newBrigade(side) : best;
  }

  brigadeName(u: Unit): string {
    return this.sides[u.side].brigades[u.brigade]?.name ?? '';
  }

  /** The army commander, while alive. */
  general(side: Side): Unit | undefined {
    return this.units.find((u) => u.side === side && u.type === 'general');
  }

  /** A side well behind on army morale fights with its back to the wall. */
  behind(side: Side): boolean {
    return this.phase === 'battle' && this.sides[side].armyMorale <= this.sides[1 - side].armyMorale - RULES.desperateGap;
  }

  /** Regiments inside the general's command radius hold their nerve better. */
  inCommand(u: Vec & { side: Side }): boolean {
    const g = this.general(u.side);
    return !!g && dist(g, u) <= RULES.commandRadius;
  }

  /** During deployment, regiments can be placed in the deployment strip or around their home towns. */
  canDeployAt(side: Side, p: Vec): boolean {
    if (this.deployKeepOut && dist(p, this.deployKeepOut) < this.deployKeepOut.r) return false;
    return inZone(side, p) || this.homeTowns(side).some((t) => dist(t, p) <= RULES.townDeployRadius);
  }

  spawn(side: Side, type: UnitTypeId, x: number, y: number, opts: { brigade?: number; xp?: number } = {}): Unit {
    const def = UNIT_TYPES[type];
    const s = this.sides[side];
    s.nameCounters[type] += 1;
    const names = NAMES[type];
    const n = s.nameCounters[type];
    const unit: Unit = {
      id: this.nextId++,
      side,
      type,
      name: `${ordinal(n)} ${s.nation} ${names[(n - 1) % names.length]}`,
      x,
      y,
      facing: side === 0 ? 0 : Math.PI,
      men: def.men,
      maxMen: def.men,
      morale: 100,
      formation: 'formation',
      order: { kind: 'hold' },
      waypoints: [],
      state: 'ok',
      routs: 0,
      holdPosition: false,
      lastAttacker: null,
      building: 0,
      buildKind: null,
      digIn: 0,
      edgeTime: 0,
      underFire: 0,
      firedAt: -99,
      meleeWith: null,
      charged: [],
      moving: false,
      marching: false,
      seen: [side === 0, side === 1],
      group: 0,
      prev: { x, y, facing: side === 0 ? 0 : Math.PI },
      fireZone: null,
      reload: 0,
      suppliedUntil: 0,
      cartAt: 0,
      shotAt: null,
      flankedAt: -99,
      note: null,
      noteFor: null,
      brigade: opts.brigade ?? this.brigadeFor(side, type),
      fatigue: 0,
      ammo: 100,
      xp: opts.xp ?? RULES.calledInXp,
    };
    s.fieldedMen += def.men;
    this.units.push(unit);
    return unit;
  }

  unit(id: number): Unit | undefined {
    return this.units.find((u) => u.id === id);
  }

  fieldCount(side: Side): number {
    return this.units.filter((u) => u.side === side && u.type !== 'general').length + this.sides[side].queue.length;
  }

  log(side: Side | -1, text: string) {
    this.events.push({ t: this.time, side, text });
    if (this.events.length > 60) this.events.shift();
  }

  // ---------- commands ----------

  /** Why a call-in would be refused right now, or null if it is allowed. */
  callInBlocker(side: Side, type: UnitTypeId): string | null {
    const s = this.sides[side];
    const def = UNIT_TYPES[type];
    if (this.phase === 'ended') return 'Battle over';
    if (!this.reinforcements) return 'No reinforcements';
    if (this.phase === 'battle') {
      if (this.time >= RULES.callInCutoff) return 'Call-ins closed';
      if (s.cooldowns[type] > this.time) return 'Cooling down';
      if (s.queue.length >= RULES.queueLimit) return 'Queue full';
    }
    if (type === 'artillery') {
      const guns = this.units.filter((u) => u.side === side && u.type === 'artillery').length
        + s.queue.filter((c) => c.type === 'artillery').length;
      if (guns >= RULES.artilleryCap) return `Limit of ${RULES.artilleryCap} batteries`;
    }
    if (type === 'supply') {
      const wagons = this.units.filter((u) => u.side === side && u.type === 'supply').length
        + s.queue.filter((c) => c.type === 'supply').length;
      if (wagons >= RULES.supplyCap) return `Limit of ${RULES.supplyCap} supply trains`;
    }
    if (s.manpower < def.cost) return 'Not enough manpower';
    if (this.fieldCount(side) >= RULES.fieldCap) return 'Army at full size';
    return null;
  }

  apply(cmd: Command) {
    if (this.phase === 'ended') return;
    const own = (id: number) => {
      const u = this.unit(id);
      return u && u.side === cmd.side && u.state !== 'routing' ? u : undefined;
    };
    switch (cmd.kind) {
      case 'move': {
        const group = cmd.moves.length > 1 ? this.nextGroup++ : 0;
        for (const m of cmd.moves) {
          const u = own(m.id);
          if (!u) continue;
          const p = clampToMap(m);
          if (this.phase === 'deploy') {
            if (!this.canDeployAt(u.side, p)) continue;
            u.x = p.x;
            u.y = p.y;
            if (cmd.facing !== undefined) u.facing = cmd.facing;
            continue;
          }
          u.order = { kind: 'move', x: p.x, y: p.y, facing: cmd.facing };
          u.holdPosition = false;
          u.waypoints = this.route(u, p);
          u.meleeWith = null;
          u.group = group;
        }
        break;
      }
      case 'attack': {
        const target = this.unit(cmd.target);
        if (!target || target.side === cmd.side || this.phase !== 'battle') break;
        for (const id of cmd.ids) {
          const u = own(id);
          if (!u || isSupport(u)) continue;
          if (u.type === 'artillery') {
            // Guns never charge: attacking with artillery means stopping and shelling where the target stands.
            this.aimGuns(u, target);
            continue;
          }
          u.order = { kind: 'attack', target: target.id };
          u.holdPosition = false;
          u.waypoints = this.route(u, target);
          u.group = 0;
        }
        break;
      }
      case 'bombard': {
        if (this.phase !== 'battle') break;
        for (const id of cmd.ids) {
          const u = own(id);
          if (u?.type === 'artillery') this.aimGuns(u, clampToMap({ x: cmd.x, y: cmd.y }));
        }
        break;
      }
      case 'ceaseFire': {
        for (const id of cmd.ids) {
          const u = own(id);
          if (u) u.fireZone = null;
        }
        break;
      }
      case 'hold': {
        for (const id of cmd.ids) {
          const u = own(id);
          if (!u) continue;
          u.order = { kind: 'hold' };
          u.waypoints = [];
          u.holdPosition = true;
        }
        break;
      }
      case 'formation': {
        for (const id of cmd.ids) {
          const u = own(id);
          if (!u) continue;
          let next = cmd.formation ?? FORMATIONS[(FORMATIONS.indexOf(u.formation) + 1) % FORMATIONS.length];
          // Troops already in combat cannot dig in; cycling skips past fortified.
          if (next === 'fortified' && !this.canFortify(u)) {
            if (cmd.formation) continue;
            next = FORMATIONS[(FORMATIONS.indexOf(next) + 1) % FORMATIONS.length];
          }
          if (next === u.formation) continue;
          u.marching = false;
          if (next === 'fortified') this.fortify(u);
          else u.formation = next;
        }
        break;
      }
      case 'callIn': {
        const p = clampToMap(cmd);
        if (!inZone(cmd.side, p)) break;
        if (this.callInBlocker(cmd.side, cmd.type)) break;
        const s = this.sides[cmd.side];
        const def = UNIT_TYPES[cmd.type];
        s.manpower -= def.cost;
        if (this.phase === 'deploy') {
          this.spawn(cmd.side, cmd.type, p.x, p.y);
        } else {
          s.cooldowns[cmd.type] = this.time + def.cooldown;
          s.queue.push({ side: cmd.side, type: cmd.type, readyAt: this.time + def.arrival, x: p.x, y: p.y });
        }
        break;
      }
      case 'requisition': {
        const s = this.sides[cmd.side];
        if (this.phase !== 'battle' || s.requisitionUsed) break;
        s.requisitionUsed = true;
        s.manpower = Math.min(RULES.stockpileCap, s.manpower + RULES.requisitionAmount);
        s.objectiveDrain += RULES.requisitionMoraleCost;
        this.log(cmd.side, `${s.nation} requisitions fresh conscripts`);
        break;
      }
      case 'ready': {
        if (this.phase !== 'deploy') break;
        this.sides[cmd.side].ready = true;
        if (this.sides[0].ready && this.sides[1].ready) this.startBattle();
        break;
      }
      case 'build': {
        if (this.phase !== 'battle') break;
        for (const id of cmd.ids) {
          const u = own(id);
          if (u?.type !== 'engineers' || u.state === 'routing' || u.building > 0) continue;
          const why = this.buildBlocker(u);
          if (why) { this.log(u.side, `${u.name}: ${why}`); continue; }
          const river = nearestRiverPoint(u);
          u.buildKind = river && river.d < 140 ? 'pontoon' : 'earthwork';
          u.building = u.buildKind === 'pontoon' ? RULES.pontoonTime : RULES.buildTime;
          u.order = { kind: 'hold' };
          u.waypoints = [];
          u.marching = false;
        }
        break;
      }
      case 'resign': {
        this.end(cmd.side === 0 ? 1 : 0, `${this.sides[cmd.side].nation} has resigned`);
        break;
      }
    }
  }

  /**
   * Shell the given spot. In range, the battery halts and sets up where it stands; out of range,
   * it moves up until the spot is in range and sets up there.
   */
  private aimGuns(u: Unit, at: Vec) {
    u.fireZone = { x: at.x, y: at.y };
    const range = UNIT_TYPES.artillery.range * (terrainAt(u).hill ? 1.2 : 1);
    const d = dist(u, at);
    if (d > range) {
      const stop = UNIT_TYPES.artillery.range * 0.9;
      const p = clampToMap({ x: at.x + ((u.x - at.x) / d) * stop, y: at.y + ((u.y - at.y) / d) * stop });
      u.order = { kind: 'move', x: p.x, y: p.y };
      u.waypoints = this.route(u, p);
      u.group = 0;
      if (u.formation === 'fortified') u.formation = 'formation';
      return;
    }
    u.order = { kind: 'hold' };
    u.waypoints = [];
    u.marching = false;
    if (u.formation !== 'fortified') this.fortify(u);
  }

  /** Only troops out of combat can dig in. Guns always can: fortified is how a battery sets up to fire. */
  canFortify(u: Unit): boolean {
    return u.type === 'artillery' || !this.inCombat(u);
  }

  private fortify(u: Unit) {
    u.formation = 'fortified';
    u.digIn = u.type === 'artillery' ? RULES.artilleryFortifyTime : RULES.fortifyTime;
  }

  /** Why these engineers cannot start building here, or null if they can. */
  buildBlocker(u: Unit): string | null {
    if (this.sides[u.side].works >= RULES.maxWorks) return `Limit of ${RULES.maxWorks} works`;
    const river = nearestRiverPoint(u);
    if (river && river.d < 140) {
      if (CROSSINGS.some((c) => dist(c, river.point) < 200)) return 'Already a crossing here';
      return null;
    }
    if (EARTHWORKS.some((e) => dist(e, u) < 150)) return 'Too close to other works';
    return null;
  }

  inCombat(u: Unit): boolean {
    if (u.meleeWith !== null || u.underFire > 0) return true;
    return this.units.some((e) => e.side !== u.side && e.state !== 'routing' && e.seen[u.side] && dist(e, u) < RULES.combatRange);
  }

  /** Formation numbers for a unit right now. */
  stats(u: Unit) {
    return FORMATION[formationOf(u)];
  }

  private startBattle() {
    this.phase = 'battle';
    for (const s of this.sides) s.manpower = Math.min(s.manpower, RULES.stockpileCap);
    this.log(-1, 'The battle begins');
  }

  // ---------- simulation ----------

  step() {
    if (this.phase === 'ended') return;
    if (this.phase === 'deploy') {
      if (!this.deployTimeLimit) return;
      this.deployLeft -= DT;
      if (this.deployLeft <= 0) this.startBattle();
      return;
    }
    this.time += DT;
    for (const u of this.units) u.prev = { x: u.x, y: u.y, facing: u.facing };
    this.impacts = this.impacts.filter((i) => this.time - i.t < 3);
    // Process regiments in a fresh random order each tick so neither side gets to act first.
    for (let i = this.units.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng.next() * (i + 1));
      [this.units[i], this.units[j]] = [this.units[j], this.units[i]];
    }
    this.updateGroupSpeeds();
    this.updateVisibility();
    this.updateSupply();
    this.economy();
    this.arrivals();
    this.countAims();
    for (const u of this.units) this.updateUnit(u);
    this.resolveMelee();
    this.separate();
    this.keepOnMap();
    this.cleanup();
    this.objectives();
    this.armyMorale();
    this.checkEnd();
  }

  /** Regiments moved together keep pace with the slowest of them, so lines arrive as lines. */
  private updateGroupSpeeds() {
    this.groupSpeed.clear();
    for (const u of this.units) {
      if (!u.group || u.order.kind !== 'move' || u.waypoints.length === 0 || u.state === 'routing') continue;
      const sp = this.baseSpeed(u);
      const cur = this.groupSpeed.get(u.group);
      if (cur === undefined || sp < cur) this.groupSpeed.set(u.group, sp);
    }
  }

  /** How many regiments of each side are shooting at each enemy, for focused fire. */
  private aims = new Map<number, number>();
  private countAims() {
    this.aims.clear();
    for (const u of this.units) {
      if (u.shotAt === null || u.state === 'routing' || !this.smarts[u.side].focus) continue;
      const e = this.unit(u.shotAt);
      if (!e || dist(u, e) > UNIT_TYPES[u.type].range * 1.2) continue;
      this.aims.set(e.id, (this.aims.get(e.id) ?? 0) + 1);
    }
  }

  private enemiesOf(u: Unit): Unit[] {
    return this.units.filter((e) => e.side !== u.side);
  }

  private updateVisibility() {
    const sight = new Map<number, number>();
    for (const o of this.units) sight.set(o.id, UNIT_TYPES[o.type].sight * (terrainAt(o).hill ? 1.25 : 1));
    for (const e of this.units) {
      for (const side of [0, 1] as Side[]) {
        if (e.side === side) { e.seen[side] = true; continue; }
        // Woods hide whoever is inside unless the enemy is close, but a battery firing gives itself away.
        const hidden = terrainAt(e).woods && !(e.type === 'artillery' && this.time - e.firedAt < RULES.firingReveals);
        const range = (o: Unit) => (hidden ? Math.min(RULES.woodsSpotRange, sight.get(o.id)!) : sight.get(o.id)!);
        e.seen[side] = this.units.some((o) => o.side === side && dist(o, e) <= range(o));
      }
    }
  }

  private economy() {
    if (!this.reinforcements) return;
    for (const side of [0, 1] as Side[]) {
      const s = this.sides[side];
      let perMinute = RULES.baseIncome;
      OBJECTIVES.forEach((o, i) => {
        if (this.owners[i] === side) perMinute += o.kind === 'depot' ? RULES.depotIncome : RULES.objectiveIncome;
      });
      if (this.behind(side)) perMinute *= 1 + RULES.catchUpBonus;
      s.manpower = Math.min(RULES.stockpileCap, s.manpower + (perMinute / 60) * DT);
    }
  }

  incomePerMinute(side: Side): number {
    let perMinute = RULES.baseIncome;
    OBJECTIVES.forEach((o, i) => {
      if (this.owners[i] === side) perMinute += o.kind === 'depot' ? RULES.depotIncome : RULES.objectiveIncome;
    });
    if (this.behind(side)) perMinute *= 1 + RULES.catchUpBonus;
    return perMinute;
  }

  private arrivals() {
    for (const s of this.sides) {
      const due = s.queue.filter((c) => c.readyAt <= this.time);
      s.queue = s.queue.filter((c) => c.readyAt > this.time);
      for (const c of due) {
        const u = this.spawn(c.side, c.type, c.side === 0 ? 15 : MAP.width - 15, c.y);
        u.order = { kind: 'move', x: c.x, y: c.y };
        u.waypoints = [{ x: c.x, y: c.y }];
        this.log(c.side, `${u.name} arrives`);
      }
    }
  }

  /** Speed on open ground, before terrain and keeping pace with the group. */
  private baseSpeed(u: Unit): number {
    const def = UNIT_TYPES[u.type];
    const f = formationOf(u);
    const fm = u.type === 'cavalry' && f === 'formation' ? CAVALRY_FORMATION_SPEED : f === 'formation' && (u.type === 'line' || u.type === 'light') ? RULES.formationSpeed : this.stats(u).speed;
    let s = def.speed * RULES.moveSpeedScale * fm * (1 - RULES.fatigueSpeedLoss * u.fatigue / 100);
    if (u.state === 'wavering') s *= 0.7;
    return s;
  }

  private speedOf(u: Unit): number {
    const def = UNIT_TYPES[u.type];
    const t = terrainAt(u);
    if (u.state === 'routing') return def.speed * RULES.moveSpeedScale * 1.1 * Math.max(0.6, t.speed);
    const pace = this.groupSpeed.get(u.group);
    return Math.min(this.baseSpeed(u), pace ?? Infinity) * t.speed * this.traffic(u);
  }

  /** A bridge or ford only takes so many at once: each other regiment on it slows the crossing. */
  private traffic(u: Unit): number {
    const c = nearCrossing(u);
    if (!c) return 1;
    let others = 0;
    for (const o of this.units) if (o !== u && o.state !== 'routing' && dist(o, c) < RULES.crossingCrowd) others++;
    return Math.max(RULES.crossingMinPace, 1 / (1 + RULES.crossingSlow * others));
  }

  /** A route for a regiment, steering round crossings that are jammed or that the enemy is seen to hold. */
  route(u: Unit, p: Vec): Vec[] {
    return planRoute(u, p, (c) => {
      let cost = 0;
      for (const o of this.units) {
        if (o === u || o.state === 'routing' || isSupport(o)) continue;
        const d = dist(o, c);
        if (o.side !== u.side && o.seen[u.side] && d < RULES.crossingHeldRange) cost += RULES.crossingHeldCost;
        else if (o.side === u.side && d < RULES.crossingCrowd) cost += RULES.crossingCrowdCost;
      }
      return cost;
    });
  }

  private turnRate(u: Unit): number {
    if (u.type === 'cavalry') return 4.5;
    if (formationOf(u) === 'fortified') return 1;
    if (u.type === 'line' && formationOf(u) === 'formation') return 1.5;
    return 3;
  }

  private updateUnit(u: Unit) {
    u.underFire = Math.max(0, u.underFire - DT);
    const def = UNIT_TYPES[u.type];
    const enemies = this.enemiesOf(u);

    if (u.state === 'routing') {
      this.updateRouting(u, enemies);
      return;
    }

    this.retaliate(u);
    this.build(u);
    this.fallBack(u, enemies);
    this.fetchAmmo(u);

    // Work out where the unit wants to go.
    let goal: Vec | null = null;
    let target: Unit | undefined;
    if (u.order.kind === 'move') {
      goal = u.waypoints[0] ?? null;
      if (!goal) {
        if (u.order.facing !== undefined) u.facing = this.turnToward(u, u.order.facing);
        if (u.order.facing === undefined || Math.abs(angleDiff(u.facing, u.order.facing)) < 0.05) u.order = { kind: 'hold' };
      }
    } else if (u.order.kind === 'attack') {
      target = this.unit(u.order.target);
      if (!target || (target.state === 'routing' && u.type !== 'cavalry') || (u.order.retaliate && !target.seen[u.side])) {
        u.order = { kind: 'hold' };
      } else {
        const d = dist(u, target);
        const standOff = def.range > 0 && (u.type !== 'line' || u.order.retaliate) ? def.range * 0.8 : 0;
        if (standOff > 0 && d <= standOff) goal = null;
        else {
          if (u.waypoints.length === 0 || dist(u.waypoints[u.waypoints.length - 1], target) > 60) u.waypoints = this.route(u, target);
          goal = u.waypoints[0];
        }
      }
    }

    // Engineers nearby help any unit dig in twice as fast.
    if (u.digIn > 0) {
      const helped = this.units.some((e) => e.side === u.side && e.type === 'engineers' && e.state !== 'routing' && dist(e, u) <= RULES.engineerAura);
      u.digIn = Math.max(0, u.digIn - DT * (helped ? 2 : 1));
    }
    const wasMarching = u.marching;
    u.marching = this.shouldMarch(u, goal);
    // Coming off a march, troops form up again; a battery with a target sets up to fire.
    if (wasMarching && !u.marching && u.formation === 'fortified') u.formation = 'formation';
    if (u.type === 'artillery' && u.fireZone && !goal && !u.marching && u.formation !== 'fortified') this.fortify(u);
    u.moving = false;
    // The general's staff can always gallop clear of a fight.
    if (goal && u.type === 'general' && u.order.kind === 'move' && u.meleeWith !== null) {
      for (const e of enemies) if (e.meleeWith === u.id) e.meleeWith = null;
      u.meleeWith = null;
    }
    // Troops on the move halt and turn to face cavalry charging at them, rather than take it in the flank.
    const horse = this.chargingHorse(u, enemies);
    if (u.note === 'bracing') u.note = null;
    if (horse) {
      u.note = 'bracing';
      u.noteFor = u.order;
      goal = null;
      u.marching = false;
      if (u.meleeWith === null) u.facing = this.turnToward(u, Math.atan2(horse.y - u.y, horse.x - u.x));
    }
    if (goal && u.meleeWith === null) this.moveToward(u, goal, enemies, target);
    // Leaving prepared positions gives up the fortification.
    if (u.moving && u.formation === 'fortified') u.formation = 'formation';

    const firedBefore = u.firedAt;
    if (u.type === 'artillery') {
      this.bombard(u);
    } else if (!u.moving && u.meleeWith === null) this.fire(u, enemies, target);
    else if (u.type === 'light' && formationOf(u) === 'formation' && u.meleeWith === null) this.fire(u, enemies, target, 0.5);

    this.updateFatigue(u, u.firedAt !== firedBefore);
    this.resupply(u);
    if (u.underFire > 0 || u.meleeWith !== null) u.xp += RULES.xpCombat * DT;
    this.updateMorale(u, enemies);
  }

  /** Marching, charging, melee and long firefights tire troops; standing still lets them recover. */
  private updateFatigue(u: Unit, fired: boolean) {
    let rate = 0;
    if (u.meleeWith !== null) rate += RULES.fatigueMelee;
    if (u.moving) {
      if (u.type === 'cavalry' && u.order.kind === 'attack') rate += RULES.fatigueCharge;
      else rate += formationOf(u) === 'marching' ? RULES.fatigueMarch : RULES.fatigueMove;
    }
    if (fired) rate += RULES.fatigueFiring;
    if (rate === 0) rate = -RULES.fatigueRest * (formationOf(u) === 'fortified' ? 1.25 : 1);
    u.fatigue = Math.max(0, Math.min(100, u.fatigue + rate * DT));
  }

  /** Is this regiment drawing on a supply cart that reached it? */
  isSupplied(u: Unit): boolean {
    return this.time < u.suppliedUntil;
  }

  /** Can this wagon train send carts right now? It must stand still and not be fighting. */
  canSendCarts(w: Unit): boolean {
    return w.state !== 'routing' && !w.moving && w.meleeWith === null;
  }

  /** How much a regiment needs a cart: missing ammunition plus half its fatigue. */
  private supplyNeed(u: Unit): number {
    return (UNIT_TYPES[u.type].range > 0 || u.type === 'artillery' ? 100 - u.ammo : 0) + u.fatigue * 0.5;
  }

  /** The regiments inside this wagon train's ring that are supplied or have a cart on the way. */
  supplyingCount(w: Unit): number {
    return this.units.filter((u) => u.side === w.side && !isSupport(u) && dist(w, u) <= RULES.supplyRange
      && (this.isSupplied(u) || this.carts.some((c) => c.target === u.id))).length;
  }

  /**
   * Wagons supply on their own: every regiment inside the ring that needs it gets carts, neediest first,
   * with several carts on the road at once.
   */
  private updateSupply() {
    for (const w of this.units) {
      if (w.type !== 'supply' || !this.canSendCarts(w) || this.time < w.cartAt) continue;
      if (this.carts.filter((c) => c.wagon === w.id).length >= RULES.cartsOut) continue;
      let best: Unit | undefined;
      let bestNeed = RULES.autoSupplyMinNeed;
      for (const u of this.units) {
        if (u.side !== w.side || isSupport(u) || u.state === 'routing' || dist(w, u) > RULES.supplyRange) continue;
        if (u.suppliedUntil - this.time > RULES.cartLead || this.carts.some((c) => c.target === u.id)) continue;
        const need = this.supplyNeed(u);
        if (need > bestNeed) { bestNeed = need; best = u; }
      }
      if (!best) continue;
      this.carts.push({ side: w.side, wagon: w.id, target: best.id, x: w.x, y: w.y, hp: 100, seen: [w.side === 0, w.side === 1] });
      w.cartAt = this.time + RULES.cartInterval;
    }
    this.carts = this.carts.filter((c) => {
      const w = this.unit(c.wagon);
      const t = this.unit(c.target);
      // A cart turns back if its regiment routs or moves well out of the wagons' ring.
      if (!w || !t || t.state === 'routing' || dist(w, t) > RULES.supplyRange * 1.2) return false;
      for (const e of this.units) {
        if (e.side === c.side || e.state === 'routing' || isSupport(e)) continue;
        const reach = (e.type === 'cavalry' ? 60 : UNIT_TYPES[e.type].range) + unitRadius(e);
        if (e.type !== 'artillery' && dist(e, c) <= reach) c.hp -= RULES.cartDamage * DT;
      }
      for (const i of this.impacts) if (this.time - i.t < DT * 1.5 && dist(i, c) <= RULES.shellBlast) c.hp = 0;
      if (c.hp <= 0) {
        if (this.time - this.lastCartLog[c.side] > 15) this.log(c.side, `A supply cart from the ${w.name} was destroyed`);
        this.lastCartLog[c.side] = this.time;
        return false;
      }
      const d = dist(c, t);
      const step = RULES.cartSpeed * DT;
      // The cart unloads as soon as it reaches the regiment's rear.
      if (d <= step + unitRadius(t) + 20) {
        t.suppliedUntil = this.time + RULES.cartLoad;
        return false;
      }
      c.x += ((t.x - c.x) / d) * step;
      c.y += ((t.y - c.y) / d) * step;
      for (const side of [0, 1] as Side[]) {
        c.seen[side] = c.side === side || this.units.some((o) => o.side === side && dist(o, c) <= UNIT_TYPES[o.type].sight);
      }
      return true;
    });
  }

  /**
   * Ammunition comes from the wagons' supply area (even mid-fight), or more slowly from the deployment zone
   * and depots you hold when not firing. The supply area also lets tired troops recover.
   */
  private resupply(u: Unit) {
    const area = this.isSupplied(u);
    if (area) u.fatigue = Math.max(0, u.fatigue - RULES.supplyFatigueRelief * DT);
    if (u.ammo >= 100) return;
    if (area) {
      u.ammo = Math.min(100, u.ammo + RULES.resupplyRate * DT);
      return;
    }
    if (this.time - u.firedAt < 3) return;
    const base = inZone(u.side, u)
      || OBJECTIVES.some((o, i) => o.kind === 'depot' && this.owners[i] === u.side && dist(o, u) <= RULES.depotSupplyRadius);
    if (base) u.ammo = Math.min(100, u.ammo + RULES.resupplyRate * 0.5 * DT);
  }

  /** A rough measure of a regiment's fighting strength, for deciding whether to take it on. */
  private strength(u: Unit): number {
    return u.men * UNIT_TYPES[u.type].shock * (0.3 + Math.max(0, u.morale) / 100) * (u.state === 'wavering' ? 0.6 : 1);
  }

  /** Enemy cavalry charging at this foot regiment and close, if it has the sense to see it coming. */
  private chargingHorse(u: Unit, enemies: Unit[]): Unit | undefined {
    if (!this.smarts[u.side].brace || u.type === 'cavalry' || u.type === 'artillery' || isSupport(u) || u.meleeWith !== null) return undefined;
    if (u.order.kind === 'attack') return undefined;
    for (const e of enemies) {
      if (e.type !== 'cavalry' || e.state === 'routing' || !e.seen[u.side]) continue;
      if (e.order.kind === 'attack' && e.order.target === u.id && dist(e, u) < 300) return e;
    }
    return undefined;
  }

  /**
   * Where to head for so as to go round ground the enemy guns are shelling, rather than straight through it.
   * Returns the goal itself when the way is clear, or the unit is already under the shells.
   */
  private aroundShellfire(u: Unit, goal: Vec, enemies: Unit[]): Vec {
    if (!this.smarts[u.side].shells || u.type === 'artillery' || u.order.kind !== 'move') return goal;
    const r = RULES.bombardRadius + RULES.shellBlast + 20;
    for (const g of enemies) {
      const z = g.fireZone;
      if (g.type !== 'artillery' || !z || this.time - g.firedAt > 8 || !g.seen[u.side]) continue;
      if (dist(u, z) < r || dist(goal, z) < r) continue;
      // Closest point of the straight path to the shelled spot.
      const dx = goal.x - u.x;
      const dy = goal.y - u.y;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((z.x - u.x) * dx + (z.y - u.y) * dy) / len2));
      const c = { x: u.x + dx * t, y: u.y + dy * t };
      const off = dist(c, z);
      if (off >= r) continue;
      // Step out to the side the path already passes on, clear of the shelling.
      const nx = off > 1 ? (c.x - z.x) / off : -dy / Math.sqrt(len2);
      const ny = off > 1 ? (c.y - z.y) / off : dx / Math.sqrt(len2);
      const p = clampToMap({ x: z.x + nx * r * 1.2, y: z.y + ny * r * 1.2 });
      if (crossesRiver(u, p) || crossesRiver(p, goal)) continue;
      return p;
    }
    return goal;
  }

  /** A wavering regiment left without orders steps back out of musket range to recover, before it breaks. */
  private fallBack(u: Unit, enemies: Unit[]) {
    if (!this.smarts[u.side].fallBack || u.state !== 'wavering' || u.order.kind !== 'hold' || u.holdPosition) return;
    if (u.meleeWith !== null || u.formation === 'fortified' || u.building > 0 || isSupport(u) || u.type === 'artillery') return;
    // Turning its back on nearby horse would invite a charge in the rear.
    if (enemies.some((e) => e.type === 'cavalry' && e.state !== 'routing' && dist(e, u) < 400)) return;
    // A garrison stays: giving up the objective costs more than the regiment.
    if (OBJECTIVES.some((o) => dist(o, u) < RULES.captureRadius + 100)) return;
    let threat: Unit | undefined;
    let td = Infinity;
    for (const e of enemies) {
      if (e.state === 'routing' || !e.seen[u.side] || UNIT_TYPES[e.type].range <= 0 || e.type === 'artillery') continue;
      const d = dist(u, e);
      if (d < td) { td = d; threat = e; }
    }
    if (!threat) return;
    const reach = UNIT_TYPES[threat.type].range * (terrainAt(threat).hill ? 1.2 : 1);
    if (td > reach) return;
    // Only when it is close to breaking and outgunned: stepping back costs volleys and ground.
    const shooters = enemies.filter((e) => e.state !== 'routing' && e.seen[u.side] && UNIT_TYPES[e.type].range > 0 && e.type !== 'artillery' && dist(e, u) <= UNIT_TYPES[e.type].range).length;
    if (u.morale > 25 || shooters < 2) return;
    const back = reach - td + 80;
    const p = clampToMap({ x: u.x + ((u.x - threat.x) / td) * back, y: u.y + ((u.y - threat.y) / td) * back });
    if (crossesRiver(u, p)) return;
    u.order = { kind: 'move', x: p.x, y: p.y, facing: Math.atan2(threat.y - u.y, threat.x - u.x) };
    u.waypoints = [p];
    u.group = 0;
    u.note = 'fallingBack';
    u.noteFor = u.order;
  }

  /** A regiment out of ammunition with nothing to do walks back to its supply wagons to refill. */
  private fetchAmmo(u: Unit) {
    if (!this.smarts[u.side].ammo || u.ammo > 0 || u.order.kind !== 'hold' || u.holdPosition) return;
    if (u.meleeWith !== null || u.underFire > 0 || isSupport(u) || UNIT_TYPES[u.type].range <= 0 || this.isSupplied(u)) return;
    let wagons: Unit | undefined;
    let wd = Infinity;
    for (const w of this.units) {
      if (w.side !== u.side || w.type !== 'supply' || w.state === 'routing') continue;
      const d = dist(w, u);
      if (d < wd) { wd = d; wagons = w; }
    }
    // Within reach of the wagons' carts it only has to wait.
    if (!wagons || wd < RULES.supplyRange * 0.9) return;
    const stop = RULES.supplyRange * 0.6;
    const p = clampToMap({ x: wagons.x + ((u.x - wagons.x) / wd) * stop, y: wagons.y + ((u.y - wagons.y) / wd) * stop });
    u.order = { kind: 'move', x: p.x, y: p.y };
    u.waypoints = this.route(u, p);
    u.group = 0;
    u.note = 'ammo';
    u.noteFor = u.order;
  }

  /** Firepower left after fatigue, ammunition and experience. */
  private firepower(u: Unit): number {
    const ammo = u.ammo <= 0 ? 0 : u.ammo < RULES.lowAmmo ? 0.5 : 1;
    return ammo * (1 - RULES.fatigueFireLoss * u.fatigue / 100) * EXPERIENCE[experienceOf(u)].fire;
  }

  /**
   * An idle unit that gets hit goes after whoever hit it; one told to hold or fortified fights back from where it stands.
   * Shooters close to firing range rather than charging; guns shell the attacker if it is in range.
   */
  private retaliate(u: Unit) {
    const id = u.lastAttacker;
    u.lastAttacker = null;
    if (id === null || u.order.kind !== 'hold' || u.meleeWith !== null) return;
    const a = this.unit(id);
    if (!a || a.state === 'routing' || !a.seen[u.side]) return;
    // Guns shell back from where they stand, whatever their orders.
    if (u.type === 'artillery') {
      if (!u.fireZone && dist(u, a) <= UNIT_TYPES.artillery.range) this.aimGuns(u, a);
      return;
    }
    // Holding and fortified units fight back from where they are (they already return fire in range).
    if (u.holdPosition || u.formation === 'fortified' || u.building > 0 || isSupport(u)) return;
    // Distant attackers (a battery shelling from across the field) are not worth a long charge into the open.
    if (dist(u, a) > Math.max(RULES.retaliateRange, UNIT_TYPES[u.type].range * 1.5)) return;
    // Nor is leaving position for an attacker that is dug in, in cover, or stronger: stand and return fire instead.
    if (this.smarts[u.side].bait && (formationOf(a) === 'fortified' || terrainAt(a).cover < 1 || this.strength(a) > this.strength(u) * 1.2)) return;
    u.order = { kind: 'attack', target: a.id, retaliate: true };
    u.waypoints = this.route(u, a);
    u.group = 0;
  }

  /** Engineers at work: moving off cancels the job, melee pauses it, finishing leaves the works behind. */
  private build(u: Unit) {
    if (u.building <= 0) return;
    if (u.order.kind !== 'hold') {
      u.building = 0;
      u.buildKind = null;
      return;
    }
    if (u.meleeWith !== null) return;
    u.building -= DT;
    if (u.building > 0) return;
    u.building = 0;
    const s = this.sides[u.side];
    if (s.works >= RULES.maxWorks) return;
    s.works += 1;
    if (u.buildKind === 'pontoon') {
      const river = nearestRiverPoint(u);
      if (river) addPontoon(river.point);
      this.log(u.side, `${u.name} completes a pontoon bridge`);
    } else {
      addEarthwork(u.side, u);
      this.log(u.side, `${u.name} completes earthworks`);
    }
    u.buildKind = null;
  }

  /** Out of combat, any move order is marched; the unit forms up again when it arrives or meets the enemy. */
  private shouldMarch(u: Unit, goal: Vec | null): boolean {
    if (!goal || u.order.kind !== 'move' || u.formation === 'marching') return false;
    const final = u.waypoints[u.waypoints.length - 1] ?? goal;
    return dist(u, final) > (u.marching ? 5 : 60) && !this.inCombat(u);
  }

  private turnToward(u: Unit, desired: number): number {
    const diff = angleDiff(u.facing, desired);
    const step = this.turnRate(u) * DT;
    return Math.abs(diff) <= step ? desired : u.facing + Math.sign(diff) * step;
  }

  private moveToward(u: Unit, goal: Vec, enemies: Unit[], target?: Unit) {
    const d = dist(u, goal);
    if (d < 4) {
      u.waypoints.shift();
      return;
    }
    const aim = this.aroundShellfire(u, goal, enemies);
    const desired = Math.atan2(aim.y - u.y, aim.x - u.x);
    const final = u.waypoints[u.waypoints.length - 1] ?? goal;
    // A short step to the rear is taken backwards, still facing the enemy, instead of turning around.
    const backstep = u.type !== 'cavalry' && u.type !== 'artillery' && dist(u, final) < 220
      && Math.abs(angleDiff(u.facing, desired)) > (2 * Math.PI) / 3;
    let step: number;
    if (backstep) {
      step = Math.min(d, this.speedOf(u) * 0.5 * DT);
    } else {
      u.facing = this.turnToward(u, desired);
      // Keep marching while wheeling, slowing in proportion to how far off the heading is.
      const align = Math.cos(angleDiff(u.facing, desired));
      step = Math.min(d, this.speedOf(u) * Math.max(0.2, align) * DT);
    }
    const next = { x: u.x + Math.cos(desired) * step, y: u.y + Math.sin(desired) * step };

    if (crossesRiver(u, next) && !nearCrossing(u) && !nearCrossing(next)) {
      u.waypoints = this.route(u, final);
      return;
    }

    // Contact with the enemy stops the march; an attack order turns it into melee.
    for (const e of enemies) {
      if (e.state === 'routing' && u.type !== 'cavalry') continue;
      const contact = unitRadius(u) + unitRadius(e) + 8;
      if (dist(next, e) < contact) {
        const attacking = target?.id === e.id || u.type === 'cavalry' && u.order.kind === 'attack';
        if (attacking || e.state === 'routing') this.engage(u, e);
        return;
      }
    }
    u.x = next.x;
    u.y = next.y;
    u.moving = true;
  }

  /**
   * Artillery does not pick targets. It shells a circle the player places, so it only hurts
   * whoever is inside that circle (friends included) and has to be re-aimed as the enemy moves.
   */
  private bombard(u: Unit) {
    u.reload = Math.max(0, u.reload - DT);
    const zone = u.fireZone;
    if (!zone || formationOf(u) !== 'fortified' || u.moving || u.meleeWith !== null) return;
    const range = UNIT_TYPES.artillery.range * (terrainAt(u).hill ? 1.2 : 1);
    if (dist(u, zone) > range) return;
    u.facing = this.turnToward(u, Math.atan2(zone.y - u.y, zone.x - u.x));
    if (u.reload > 0 || u.ammo <= 0) return;
    u.reload = RULES.shellInterval * (u.state === 'wavering' ? 1.5 : 1);
    u.firedAt = this.time;
    u.ammo = Math.max(0, u.ammo - RULES.shellAmmo);
    const a = this.rng.range(0, Math.PI * 2);
    const r = Math.sqrt(this.rng.next()) * RULES.bombardRadius;
    const hit = { x: zone.x + Math.cos(a) * r, y: zone.y + Math.sin(a) * r };
    this.impacts.push({ ...hit, t: this.time, side: u.side });
    const strength = (u.men / u.maxMen) * this.firepower(u);
    for (const t of this.units) {
      const d = dist(t, hit) - unitRadius(t) * 0.6;
      if (d > RULES.shellBlast) continue;
      const falloff = 1 - Math.max(0, d) / RULES.shellBlast;
      let taken = this.fireTaken(t);
      const dug = formationOf(t) === 'fortified';
      if (dug) taken *= RULES.shellVsFortified;
      if (t.side === u.side) taken *= RULES.friendlyFire;
      const cas = RULES.shellDamage * strength * falloff * taken * this.cover(t) * this.rng.range(0.7, 1.3);
      this.damage(t, cas, u, 3.5);
      // A near hit shakes dug-in troops out of their prepared positions for a while.
      if (dug && t.type !== 'artillery' && t.side !== u.side && falloff > 0.5 && RULES.shellUnsettle > 0) t.digIn = Math.max(t.digIn, RULES.shellUnsettle);
    }
  }

  /**
   * Terrain cover on a target. Dug-in troops in a town or woods normally get both protections; with coverStacks
   * off they only get the better of the two (the dig-in bonus is already counted in fireTaken, so it is divided out).
   */
  private cover(t: Unit): number {
    const c = terrainAt(t).cover;
    if (RULES.coverStacks || formationOf(t) !== 'fortified') return c;
    const f = FORMATION.fortified.fireTaken;
    return Math.min(c, f) / f;
  }

  private fireTaken(t: Unit): number {
    const f = formationOf(t);
    let taken = this.stats(t).fireTaken;
    if (t.type === 'cavalry') taken *= 1.1;
    if (t.type === 'light' && f !== 'marching') taken *= 0.6; // skirmishers are spread out
    if (t.type === 'general') taken *= 0.2; // a handful of riders is a hard target
    return taken;
  }

  private flankMultiplier(attacker: Vec, target: Unit): number {
    const toAttacker = Math.atan2(attacker.y - target.y, attacker.x - target.x);
    const off = Math.abs(angleDiff(target.facing, toAttacker));
    const flank = off < Math.PI / 3 ? 1 : off < (2 * Math.PI) / 3 ? 2 : 3;
    // Dug-in troops have prepared positions all round, so flanking them matters less.
    return formationOf(target) === 'fortified' ? Math.min(flank, 1.5) : flank;
  }

  private damage(target: Unit, casualties: number, from: Unit, moraleWeight: number) {
    if (from.side !== target.side) target.lastAttacker = from.id;
    const lost = Math.max(0, Math.min(target.men, casualties));
    target.men -= lost;
    this.sides[target.side].lostMen += lost;
    if (from.side !== target.side) from.xp += (lost / target.maxMen) * RULES.xpPerKill;
    const flank = this.flankMultiplier(from, target);
    if (flank > 1 && from.side !== target.side) target.flankedAt = this.time;
    const steadiness = EXPERIENCE[experienceOf(target)].morale * (this.inCommand(target) ? RULES.commandMoraleTaken : 1);
    // An army fighting with its back to the wall holds on harder.
    const desperate = this.behind(target.side) ? RULES.desperateMoraleTaken : 1;
    target.morale = Math.max(0, target.morale - (lost / target.maxMen) * 100 * moraleWeight * flank * this.stats(target).moraleTaken * steadiness * desperate);
    target.underFire = 2;
  }

  private fire(u: Unit, enemies: Unit[], ordered?: Unit, scale = 1) {
    const def = UNIT_TYPES[u.type];
    if (def.range <= 0 || u.state === 'routing') return;
    const fm = this.stats(u).fire;
    if (fm <= 0) return;
    const range = def.range * (terrainAt(u).hill ? 1.2 : 1);
    const arc = u.type === 'light' ? Math.PI : u.type === 'artillery' ? Math.PI / 4 : Math.PI / 2.6;

    let best: Unit | undefined;
    let bestD = Infinity;
    let bestScore = Infinity;
    const forced = !!ordered && dist(u, ordered) <= range;
    const candidates = forced ? [ordered!] : enemies;
    const smart = this.smarts[u.side].target && !forced;
    for (const e of candidates) {
      if (!e.seen[u.side]) continue;
      const d = dist(u, e);
      if (d > range) continue;
      // The nearest enemy, or with smart targeting the one closest to breaking among those in front: shaken
      // and wavering regiments first, the last target while it is still a good one, nothing that means a long wheel.
      let score = d / range;
      if (smart) {
        score -= 0.6 * (1 - Math.max(0, e.morale) / 100) + (e.state === 'wavering' ? 0.25 : 0) + (e.id === u.shotAt ? 0.15 : 0);
        if (Math.abs(angleDiff(u.facing, Math.atan2(e.y - u.y, e.x - u.x))) > arc) score += 0.5;
        if (e.state === 'routing') score += 0.5;
        // Focused fire: pile onto an enemy others are already shooting, to break it rather than spread the losses.
        if (this.smarts[u.side].focus) score -= 0.12 * Math.min(3, (this.aims.get(e.id) ?? 0) - (u.shotAt === e.id ? 1 : 0));
      }
      if (score >= bestScore) continue;
      best = e;
      bestD = d;
      bestScore = score;
    }
    if (!best) return;
    u.shotAt = best.id;

    const bearing = Math.atan2(best.y - u.y, best.x - u.x);
    if (Math.abs(angleDiff(u.facing, bearing)) > arc) {
      // Holding units wheel to face whoever is shooting at them.
      if (u.order.kind !== 'move') u.facing = this.turnToward(u, bearing);
      return;
    }

    const rangeMod = 1 - 0.7 * (bestD / range);
    const waver = u.state === 'wavering' ? 0.6 : 1;
    const taken = this.fireTaken(best);
    const power = this.firepower(u);
    if (power <= 0) return;
    const cas = u.men * fm * def.lethality * rangeMod * waver * this.cover(best) * taken * scale * power * this.rng.range(0.8, 1.2) * DT;
    this.damage(best, cas, u, u.type === 'artillery' ? 3.2 : 2.6);
    u.ammo = Math.max(0, u.ammo - RULES.ammoUse * scale * DT);
    u.firedAt = this.time;
  }

  private engage(u: Unit, e: Unit) {
    u.meleeWith = e.id;
    if (e.meleeWith === null && e.state !== 'routing') e.meleeWith = u.id;
    if (u.type === 'cavalry' && e.state !== 'routing' && !u.charged.includes(e.id)) {
      u.charged.push(e.id);
      const flank = this.flankMultiplier(u, e);
      const vs = e.type === 'cavalry' ? 1 : this.stats(e).vsCavalry;
      const impact = (16 * flank) / vs;
      e.morale = Math.max(0, e.morale - impact);
      this.damage(e, e.men * 0.025 * (flank / vs), u, 1);
      if (e.type !== 'cavalry' && formationOf(e) === 'fortified') this.damage(u, u.men * 0.08, e, 2);
    } else if ((u.type === 'line' || u.type === 'light') && RULES.chargeImpetus > 0 && e.state !== 'routing' && !u.charged.includes(e.id)) {
      // Infantry going in with the bayonet shakes the enemy on impact, more so from the flank, less against works.
      u.charged.push(e.id);
      const vs = formationOf(e) === 'fortified' ? 1.6 : 1;
      e.morale = Math.max(0, e.morale - (RULES.chargeImpetus * UNIT_TYPES[u.type].shock * this.flankMultiplier(u, e)) / vs);
    }
  }

  private meleePower(u: Unit, vs: Unit): number {
    const def = UNIT_TYPES[u.type];
    let p = u.men * (Math.max(0, u.morale) / 100 + 0.3) * def.shock;
    if (vs.type === 'cavalry' && u.type !== 'cavalry') p *= this.stats(u).vsCavalry;
    if (u.state === 'wavering') p *= 0.6;
    if (u.state === 'routing') p *= 0.1;
    p *= (1 - RULES.fatigueMeleeLoss * u.fatigue / 100) * EXPERIENCE[experienceOf(u)].fire;
    return p * terrainAt(u).cover ** -0.5;
  }

  /**
   * Every pair of blocks in contact fights. A unit fighting several enemies at once splits its strength between
   * them, and takes blows from all of them, so ganging up on a regiment works.
   */
  private resolveMelee() {
    const foes = new Map<number, Unit[]>();
    const link = (a: Unit, b: Unit) => {
      const list = foes.get(a.id) ?? [];
      if (!list.includes(b)) list.push(b);
      foes.set(a.id, list);
    };
    for (const u of this.units) {
      if (u.meleeWith === null) continue;
      const e = this.unit(u.meleeWith);
      if (!e || dist(u, e) > unitRadius(u) + unitRadius(e) + 40 || u.state === 'routing') {
        // Cavalry that has pulled clear can charge the same enemy again.
        if (e && u.charged.includes(e.id)) u.charged = u.charged.filter((id) => id !== e.id);
        u.meleeWith = null;
        continue;
      }
      link(u, e);
      link(e, u);
      if (e.meleeWith === null && e.state !== 'routing') e.meleeWith = u.id;
    }
    for (const u of this.units) {
      for (const e of foes.get(u.id) ?? []) {
        const split = foes.get(e.id)?.length ?? 1;
        if (e.state !== 'routing' && u.state !== 'routing') this.damage(u, (this.meleePower(e, u) / split) * 0.0035 * DT * this.rng.range(0.8, 1.2), e, 3);
        // Nobody fights back while running, so pursuit is where routs turn into heavy losses.
        else if (u.state !== 'routing') this.damage(e, (this.meleePower(u, e) / (foes.get(u.id)!.length)) * 0.006 * DT, u, 0);
      }
    }
  }


  private updateMorale(u: Unit, enemies: Unit[]) {
    // The general and staff do not run: they stand until they are cut down.
    if (u.type === 'general') { u.morale = 100; return; }
    const commanded = this.inCommand(u);
    const nearbyRouting = this.units.some((o) => o.side === u.side && o !== u && o.state === 'routing' && dist(o, u) < 250);
    if (nearbyRouting) u.morale -= 1.2 * DT * this.stats(u).moraleTaken * (commanded ? RULES.commandMoraleTaken : 1);
    if (u.meleeWith === null) {
      // Out of the fight everyone steadies; under fire only the general's presence keeps men's nerve coming back.
      const rate = u.underFire <= 0 ? (commanded ? RULES.commandMoraleRecovery : 1) : commanded ? RULES.commandUnderFireRecovery : 0;
      u.morale = Math.min(100, u.morale + RULES.moraleRecovery * rate * DT);
    }
    if (u.morale <= 0) {
      u.morale = 0;
      u.state = 'routing';
      u.routs += 1;
      u.meleeWith = null;
      u.order = { kind: 'hold' };
      u.waypoints = [];
      // A broken unit abandons its works, its dug-in position and any half-built bridge.
      if (u.formation === 'fortified') u.formation = 'formation';
      u.digIn = 0;
      u.marching = false;
      u.building = 0;
      u.buildKind = null;
      u.fireZone = null;
      for (const e of enemies) if (e.meleeWith === u.id) e.meleeWith = null;
      this.log(u.side, u.routs > 1 ? `${u.name} breaks again: only the general can rally them now` : `${u.name} is routing`);
    } else {
      u.state = u.morale < RULES.waveringAt ? 'wavering' : 'ok';
    }
  }

  private updateRouting(u: Unit, enemies: Unit[]) {
    // Run for the nearest map edge that is not the enemy's side: home, or either flank.
    // They run for the general instead if the general is closer, or within command range, and out of danger.
    const exits = [{ x: homeEdgeX(u.side), y: u.y }, { x: u.x, y: 0 }, { x: u.x, y: MAP.height }];
    let goal: Vec = exits.reduce((a, b) => (dist(u, b) < dist(u, a) ? b : a));
    const g = this.general(u.side);
    const safeGeneral = g && !enemies.some((e) => e.state !== 'routing' && dist(e, g) < RULES.rallySafeDistance);
    const nearGeneral = !!g && dist(u, g) <= RULES.commandRadius;
    if (g && safeGeneral && (nearGeneral || dist(u, g) < dist(u, goal))) {
      goal = dist(u, g) > 120 ? g : u;
    }
    const desired = Math.atan2(goal.y - u.y, goal.x - u.x);
    u.facing = desired;
    const step = goal === u ? 0 : this.speedOf(u) * DT;
    const next = { x: u.x + Math.cos(desired) * step, y: u.y + Math.sin(desired) * step };
    if (crossesRiver(u, next) && !nearCrossing(u) && !nearCrossing(next)) {
      // Routing troops swim for it, losing men on the way.
      this.damage(u, u.men * 0.01 * DT, u, 0);
    }
    u.x = next.x;
    u.y = next.y;
    u.moving = true;
    // The general's presence lets men rally with the enemy closer than they otherwise would.
    const safeFrom = nearGeneral ? RULES.rallySafeNearGeneral : RULES.rallySafeDistance;
    const threat = enemies.some((e) => e.state !== 'routing' && dist(e, u) < safeFrom);
    const atEdge = u.edgeTime > 0;
    if (!threat) u.morale = Math.min(100, u.morale + 1.5 * (nearGeneral ? RULES.generalRallyBoost : atEdge ? RULES.edgeRallyBoost : 1) * DT);
    // A regiment that has broken twice only rallies to the general.
    if ((u.routs === 1 || nearGeneral) && !threat && u.morale >= (nearGeneral ? RULES.rallyAtNearGeneral : RULES.rallyAt)) {
      u.state = 'wavering';
      u.order = { kind: 'hold' };
      u.facing = u.side === 0 ? 0 : Math.PI;
      u.edgeTime = 0;
      this.log(u.side, nearGeneral ? `${u.name} rallies to the general` : `${u.name} rallies`);
      this.sides[u.side].regained += RULES.rallyArmyMorale;
    }
  }

  private separate() {
    for (let i = 0; i < this.units.length; i++) {
      const a = this.units[i];
      for (let j = i + 1; j < this.units.length; j++) {
        const b = this.units[j];
        if (a.side !== b.side || a.state === 'routing' || b.state === 'routing') continue;
        const d = dist(a, b);
        if (d > 260) continue;
        // Two blocks on the very same spot (call-ins arriving together) split apart along a fixed axis.
        const nx = d === 0 ? 1 : (b.x - a.x) / d;
        const ny = d === 0 ? 0 : (b.y - a.y) / d;
        // How far each block reaches towards the other, so long lines keep their full width apart.
        const reach = (u: Unit) => {
          const { w, d: depth } = unitSize(u);
          return Math.abs(nx * Math.cos(u.facing) + ny * Math.sin(u.facing)) * depth / 2
            + Math.abs(-nx * Math.sin(u.facing) + ny * Math.cos(u.facing)) * w / 2;
        };
        const min = (reach(a) + reach(b)) * 0.9;
        if (d >= min) continue;
        const push = Math.min(3, (min - d) * 0.2);
        a.x -= nx * push; a.y -= ny * push;
        b.x += nx * push; b.y += ny * push;
      }
    }
  }

  /** Nobody can leave the map. Shaken units stuck against the border for too long melt away. */
  private keepOnMap() {
    for (const u of this.units) {
      const m = RULES.borderWidth + unitRadius(u);
      u.x = Math.max(m, Math.min(MAP.width - m, u.x));
      u.y = Math.max(m, Math.min(MAP.height - m, u.y));
      const nearEdge = u.x <= m + 60 || u.x >= MAP.width - m - 60 || u.y <= m + 60 || u.y >= MAP.height - m - 60;
      if (nearEdge && u.state === 'routing') u.edgeTime += DT;
      else u.edgeTime = Math.max(0, u.edgeTime - DT * 2);
    }
  }

  private cleanup() {
    const keep: Unit[] = [];
    for (const u of this.units) {
      const atEdge = u.edgeTime >= RULES.edgeDisperseTime;
      const spent = u.men < u.maxMen * 0.15;
      if (atEdge || spent) {
        this.sides[u.side].removed += 1;
        this.sides[1 - u.side].score += 2;
        if (u.type === 'general') {
          const s = this.sides[u.side];
          const lord = this.lords[u.side];
          s.generalLost = true;
          s.objectiveDrain += RULES.generalLossMorale + (lord ? this.lordLossMorale : 0);
          this.log(-1, lord ? `${lord} has fallen! The ${s.nation} army loses heart` : `The ${s.nation} general has fallen!`);
        } else this.log(u.side, spent ? `${u.name} has been destroyed` : `${u.name} has deserted the field`);
        for (const o of this.units) if (o.meleeWith === u.id) o.meleeWith = null;
        continue;
      }
      keep.push(u);
    }
    this.units = keep;
  }

  private objectives() {
    const mult = this.time >= RULES.finalPushAt ? 2 : 1;
    OBJECTIVES.forEach((o, i) => {
      const present = [false, false];
      for (const u of this.units) {
        if (u.state !== 'routing' && !isSupport(u) && dist(u, o) <= RULES.captureRadius) present[u.side] = true;
      }
      const c = this.capture[i];
      if (present[0] !== present[1]) {
        const side: Side = present[0] ? 0 : 1;
        // A town is taken only after a side has held it alone for captureTime (from neutral or from the enemy).
        if (this.owners[i] !== side && RULES.captureTime > 0) {
          if (c.side !== side) {
            c.side = side;
            c.t = 0;
            if (this.owners[i] === 1 - side) this.log((1 - side) as Side, `The enemy is taking ${o.name}`);
          }
          c.t += DT;
        }
        if (this.owners[i] === side) { c.side = -1; c.t = 0; }
        if (this.owners[i] !== side && (RULES.captureTime <= 0 || c.t >= RULES.captureTime)) {
          c.side = -1;
          c.t = 0;
          this.log(side, `${this.sides[side].nation} takes ${o.name}`);
          // Taking a place back from the enemy lifts the whole army.
          if (this.owners[i] === 1 - side) this.sides[side].regained += RULES.recaptureMorale;
          this.owners[i] = side;
        }
      } else if (!present[0] && !present[1] && c.t > 0) {
        // Nobody there: the half-taken town slowly goes back.
        c.t = Math.max(0, c.t - DT);
        if (c.t === 0) c.side = -1;
      }
      const owner = this.owners[i];
      if (owner !== -1) this.sides[owner].score += (mult / 60) * DT;
    });
    for (const side of [0, 1] as Side[]) {
      const mine = this.owners.filter((o) => o === side).length;
      const theirs = this.owners.filter((o) => o === 1 - side).length;
      this.sides[side].objectiveDrain += (RULES.objectiveDrain * Math.max(0, theirs - mine) * mult / 60) * DT;
    }
  }

  private armyMorale() {
    if (this.time > RULES.timePressureAt) {
      // The clock wears on both armies, but less on the one already losing, so a lead can still be overturned.
      const drain = [0, 1].map((side) => (RULES.timePressureRate / 60) * DT * (this.behind(side as Side) ? RULES.timePressureBehind : 1) * this.timePressure[side]);
      this.sides[0].timeDrain += drain[0];
      this.sides[1].timeDrain += drain[1];
    }
    for (const side of [0, 1] as Side[]) {
      const b = this.moraleBreakdown(side);
      this.sides[side].armyMorale = Math.max(0, Math.min(100, 100 - b.losses - b.routing - b.removed - b.objectives - b.time + b.regained));
    }
  }

  /** Where a side's lost army morale has gone. */
  moraleBreakdown(side: Side): MoraleBreakdown {
    const s = this.sides[side];
    const routing = this.units.filter((u) => u.side === side && u.state === 'routing').length;
    return {
      losses: 60 * s.lostMen / Math.max(1, s.fieldedMen),
      routing: RULES.routingMorale * routing,
      removed: RULES.removedMorale * s.removed,
      objectives: s.objectiveDrain,
      time: s.timeDrain,
      regained: s.regained,
    };
  }

  /** What a regiment is doing on its own, if anything, while it still has the order the note belongs to. */
  noteOf(u: Unit): Note | null {
    return u.note && u.noteFor === u.order ? u.note : null;
  }

  private checkEnd() {
    if (!this.autoEnd) return;
    if (this.endWhenWiped && this.phase === 'battle') {
      const fighting = (side: Side) => this.units.some((u) => u.side === side && u.state !== 'routing' && !isSupport(u) && u.type !== 'engineers');
      for (const side of [0, 1] as Side[]) {
        if (!fighting(side)) {
          this.end(fighting((1 - side) as Side) ? ((1 - side) as Side) : -1, `The ${this.sides[side].nation} army has been driven from the field`);
          return;
        }
      }
    }
    // Domination: holding every objective for long enough wins outright.
    for (const side of [0, 1] as Side[]) {
      const held = this.owners.filter((o) => o === side).length;
      if (held === OBJECTIVES.length) this.domination[side] += DT;
      else this.domination[side] = 0;
      if (this.domination[side] >= RULES.dominationHold) {
        this.end(side, `${this.sides[side].nation} dominates the field`);
        return;
      }
    }
    const broken = this.sides.map((s) => s.armyMorale <= 0);
    if (broken[0] || broken[1]) {
      const winner: Side | -1 = broken[0] && broken[1] ? -1 : broken[0] ? 1 : 0;
      const loser = winner === -1 ? null : this.sides[1 - winner];
      this.end(winner, loser ? `The ${loser.nation} army has broken` : 'Both armies have broken');
      return;
    }
    if (this.time >= RULES.matchLength) {
      const [a, b] = this.sides;
      const diff = a.score - b.score;
      const winner: Side | -1 = Math.abs(diff) < 0.5
        ? (a.armyMorale === b.armyMorale ? -1 : a.armyMorale > b.armyMorale ? 0 : 1)
        : diff > 0 ? 0 : 1;
      this.end(winner, 'Time is up: decided on points');
    }
  }

  end(winner: Side | -1, reason: string) {
    this.phase = 'ended';
    this.result = { winner, reason };
    this.log(-1, reason);
  }
}
