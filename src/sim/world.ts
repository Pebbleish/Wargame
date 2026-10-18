import {
  CAVALRY_FORMATION_SPEED, FORMATION, FORMATIONS, Formation, MAP, RULES, UNIT_SIZE, UNIT_TYPES, UnitTypeId,
} from './config';
import {
  CROSSINGS, EARTHWORKS, OBJECTIVES, Vec, addEarthwork, addPontoon, clampToMap, crossesRiver, dist, generateMap, nearCrossing,
  nearestRiverPoint, planRoute, terrainAt,
} from './map';
import { Rng } from './rng';

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
}

export interface Impact {
  x: number;
  y: number;
  t: number;
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
  lostMen: number;
  fieldedMen: number;
  removed: number;
  armyMorale: number;
  score: number;
  ready: boolean;
  nameCounters: Record<UnitTypeId, number>;
  works: number;
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
  | { kind: 'callIn'; side: Side; type: UnitTypeId; x: number; y: number }
  | { kind: 'requisition'; side: Side }
  | { kind: 'ready'; side: Side }
  | { kind: 'resign'; side: Side }
  | { kind: 'build'; side: Side; ids: number[] };

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
};

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
  const zero = { line: 0, light: 0, cavalry: 0, artillery: 0, engineers: 0 };
  return {
    nation,
    manpower: RULES.startingBudget,
    cooldowns: { ...zero },
    queue: [],
    requisitionUsed: false,
    objectiveDrain: 0,
    lostMen: 0,
    fieldedMen: 0,
    removed: 0,
    armyMorale: 100,
    score: 0,
    ready: false,
    nameCounters: { ...zero },
    works: 0,
  };
}

export class World {
  phase: 'deploy' | 'battle' | 'ended' = 'deploy';
  deployLeft = RULES.deploymentTime;
  domination: [number, number] = [0, 0]; // seconds each side has held every objective
  time = 0;
  units: Unit[] = [];
  sides: [SideState, SideState];
  owners: (Side | -1)[] = [];
  events: GameEvent[] = [];
  result: Result | null = null;
  impacts: Impact[] = [];
  rng: Rng;
  private nextId = 1;
  private nextGroup = 1;
  private groupSpeed = new Map<number, number>();

  constructor(seed = 1, nations: [string, string] = ['Valdmark', 'Ostmark']) {
    generateMap(seed);
    this.owners = OBJECTIVES.map(() => -1);
    this.rng = new Rng(seed);
    this.sides = [newSide(nations[0]), newSide(nations[1])];
    for (const side of [0, 1] as Side[]) this.placeCore(side);
  }

  // ---------- setup ----------

  /** The two towns on a side's own half, where its starting army stands. */
  homeTowns(side: Side): Vec[] {
    return OBJECTIVES.filter((o) => o.home === side);
  }

  /** The starting army garrisons its two home towns; guns and horse wait between them. */
  private placeCore(side: Side) {
    const [a, b] = this.homeTowns(side);
    const dir = side === 0 ? 1 : -1;
    const at = (t: Vec, dx: number, dy: number) => ({ x: t.x + dx * dir, y: t.y + dy * dir });
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const spots: [UnitTypeId, Vec][] = [
      ['line', at(a, 170, -190)], ['line', at(a, 170, 190)], ['light', at(a, 300, 0)],
      ['line', at(b, 170, -190)], ['line', at(b, 170, 190)], ['line', at(b, -150, 0)],
      ['artillery', at(mid, -60, 0)], ['cavalry', at(mid, -320, 0)],
    ];
    for (const [type, p] of spots) {
      const q = clampToMap(p, RULES.borderWidth + 80);
      this.spawn(side, type, q.x, q.y);
    }
  }

  /** During deployment, regiments can be placed in the deployment strip or around their home towns. */
  canDeployAt(side: Side, p: Vec): boolean {
    return inZone(side, p) || this.homeTowns(side).some((t) => dist(t, p) <= RULES.townDeployRadius);
  }

  spawn(side: Side, type: UnitTypeId, x: number, y: number): Unit {
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
    };
    s.fieldedMen += def.men;
    this.units.push(unit);
    return unit;
  }

  unit(id: number): Unit | undefined {
    return this.units.find((u) => u.id === id);
  }

  fieldCount(side: Side): number {
    return this.units.filter((u) => u.side === side).length + this.sides[side].queue.length;
  }

  private log(side: Side | -1, text: string) {
    this.events.push({ t: this.time, side, text });
    if (this.events.length > 60) this.events.shift();
  }

  // ---------- commands ----------

  /** Why a call-in would be refused right now, or null if it is allowed. */
  callInBlocker(side: Side, type: UnitTypeId): string | null {
    const s = this.sides[side];
    const def = UNIT_TYPES[type];
    if (this.phase === 'ended') return 'Battle over';
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
          u.waypoints = planRoute(u, p);
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
          if (!u) continue;
          if (u.type === 'artillery') {
            // Guns never charge: attacking with artillery means stopping and shelling where the target stands.
            this.aimGuns(u, target);
            continue;
          }
          u.order = { kind: 'attack', target: target.id };
          u.holdPosition = false;
          u.waypoints = planRoute(u, target);
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
      u.waypoints = planRoute(u, p);
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
    this.economy();
    this.arrivals();
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
    for (const side of [0, 1] as Side[]) {
      const s = this.sides[side];
      const other = this.sides[1 - side];
      let perMinute = RULES.baseIncome;
      OBJECTIVES.forEach((o, i) => {
        if (this.owners[i] === side) perMinute += o.kind === 'depot' ? RULES.depotIncome : RULES.objectiveIncome;
      });
      if (s.armyMorale <= other.armyMorale - RULES.catchUpGap) perMinute *= 1 + RULES.catchUpBonus;
      s.manpower = Math.min(RULES.stockpileCap, s.manpower + (perMinute / 60) * DT);
    }
  }

  incomePerMinute(side: Side): number {
    const s = this.sides[side];
    let perMinute = RULES.baseIncome;
    OBJECTIVES.forEach((o, i) => {
      if (this.owners[i] === side) perMinute += o.kind === 'depot' ? RULES.depotIncome : RULES.objectiveIncome;
    });
    if (s.armyMorale <= this.sides[1 - side].armyMorale - RULES.catchUpGap) perMinute *= 1 + RULES.catchUpBonus;
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
    const fm = u.type === 'cavalry' && f === 'formation' ? CAVALRY_FORMATION_SPEED : this.stats(u).speed;
    let s = def.speed * RULES.moveSpeedScale * fm;
    if (u.state === 'wavering') s *= 0.7;
    return s;
  }

  private speedOf(u: Unit): number {
    const def = UNIT_TYPES[u.type];
    const t = terrainAt(u);
    if (u.state === 'routing') return def.speed * RULES.moveSpeedScale * 1.1 * Math.max(0.6, t.speed);
    const pace = this.groupSpeed.get(u.group);
    return Math.min(this.baseSpeed(u), pace ?? Infinity) * t.speed;
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
          if (u.waypoints.length === 0 || dist(u.waypoints[u.waypoints.length - 1], target) > 60) u.waypoints = planRoute(u, target);
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
    if (goal && u.meleeWith === null) this.moveToward(u, goal, enemies, target);
    // Leaving prepared positions gives up the fortification.
    if (u.moving && u.formation === 'fortified') u.formation = 'formation';

    if (u.type === 'artillery') this.bombard(u);
    else if (!u.moving && u.meleeWith === null) this.fire(u, enemies, target);
    else if (u.type === 'light' && formationOf(u) === 'formation' && u.meleeWith === null) this.fire(u, enemies, target, 0.5);

    this.updateMorale(u, enemies);
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
    if (u.holdPosition || u.formation === 'fortified' || u.building > 0) return;
    u.order = { kind: 'attack', target: a.id, retaliate: true };
    u.waypoints = planRoute(u, a);
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
    const desired = Math.atan2(goal.y - u.y, goal.x - u.x);
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
      u.waypoints = planRoute(u, final);
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
    if (u.reload > 0) return;
    u.reload = RULES.shellInterval * (u.state === 'wavering' ? 1.5 : 1);
    u.firedAt = this.time;
    const a = this.rng.range(0, Math.PI * 2);
    const r = Math.sqrt(this.rng.next()) * RULES.bombardRadius;
    const hit = { x: zone.x + Math.cos(a) * r, y: zone.y + Math.sin(a) * r };
    this.impacts.push({ ...hit, t: this.time });
    const strength = u.men / u.maxMen;
    for (const t of this.units) {
      const d = dist(t, hit) - unitRadius(t) * 0.6;
      if (d > RULES.shellBlast) continue;
      const falloff = 1 - Math.max(0, d) / RULES.shellBlast;
      let taken = this.fireTaken(t);
      if (formationOf(t) === 'fortified') taken *= RULES.shellVsFortified;
      if (t.side === u.side) taken *= RULES.friendlyFire;
      const cas = RULES.shellDamage * strength * falloff * taken * terrainAt(t).cover * this.rng.range(0.7, 1.3);
      this.damage(t, cas, u, 3.5);
    }
  }

  private fireTaken(t: Unit): number {
    const f = formationOf(t);
    let taken = this.stats(t).fireTaken;
    if (t.type === 'cavalry') taken *= 1.1;
    if (t.type === 'light' && f !== 'marching') taken *= 0.6; // skirmishers are spread out
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
    const lost = Math.min(target.men, casualties);
    target.men -= lost;
    this.sides[target.side].lostMen += lost;
    const flank = this.flankMultiplier(from, target);
    target.morale -= (lost / target.maxMen) * 100 * moraleWeight * flank * this.stats(target).moraleTaken;
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
    const candidates = ordered && dist(u, ordered) <= range ? [ordered] : enemies;
    for (const e of candidates) {
      if (!e.seen[u.side]) continue;
      const d = dist(u, e);
      if (d > range || d >= bestD) continue;
      best = e;
      bestD = d;
    }
    if (!best) return;

    const bearing = Math.atan2(best.y - u.y, best.x - u.x);
    if (Math.abs(angleDiff(u.facing, bearing)) > arc) {
      // Holding units wheel to face whoever is shooting at them.
      if (u.order.kind !== 'move') u.facing = this.turnToward(u, bearing);
      return;
    }

    const rangeMod = 1 - 0.7 * (bestD / range);
    const waver = u.state === 'wavering' ? 0.6 : 1;
    const t = terrainAt(best);
    const taken = this.fireTaken(best);
    const cas = u.men * fm * def.lethality * rangeMod * waver * t.cover * taken * scale * this.rng.range(0.8, 1.2) * DT;
    this.damage(best, cas, u, u.type === 'artillery' ? 3.2 : 2.6);
    u.firedAt = this.time;
  }

  private engage(u: Unit, e: Unit) {
    u.meleeWith = e.id;
    if (e.meleeWith === null && e.state !== 'routing') e.meleeWith = u.id;
    if (u.type === 'cavalry' && !u.charged.includes(e.id)) {
      u.charged.push(e.id);
      const flank = this.flankMultiplier(u, e);
      const vs = e.type === 'cavalry' ? 1 : this.stats(e).vsCavalry;
      const impact = (22 * flank) / vs;
      e.morale -= impact;
      this.damage(e, e.men * 0.03 * (flank / vs), u, 1);
      if (e.type !== 'cavalry' && formationOf(e) === 'fortified') this.damage(u, u.men * 0.08, e, 2);
    }
  }

  private meleePower(u: Unit, vs: Unit): number {
    const def = UNIT_TYPES[u.type];
    let p = u.men * (u.morale / 100 + 0.3) * def.shock;
    if (vs.type === 'cavalry' && u.type !== 'cavalry') p *= this.stats(u).vsCavalry;
    if (u.state === 'wavering') p *= 0.6;
    if (u.state === 'routing') p *= 0.1;
    return p * terrainAt(u).cover ** -0.5;
  }

  private resolveMelee() {
    for (const u of this.units) {
      if (u.meleeWith === null) continue;
      const e = this.unit(u.meleeWith);
      if (!e || dist(u, e) > unitRadius(u) + unitRadius(e) + 40 || u.state === 'routing') {
        u.meleeWith = null;
        continue;
      }
      const pe = this.meleePower(e, u);
      this.damage(u, pe * 0.0035 * DT * this.rng.range(0.8, 1.2), e, 3);
      // Nobody fights back while running, so pursuit is where routs turn into heavy losses.
      if (e.state === 'routing') this.damage(e, this.meleePower(u, e) * 0.006 * DT, u, 0);
      if (e.meleeWith !== u.id && e.state !== 'routing') e.meleeWith = u.id;
    }
  }

  private updateMorale(u: Unit, enemies: Unit[]) {
    const nearbyRouting = this.units.some((o) => o.side === u.side && o !== u && o.state === 'routing' && dist(o, u) < 250);
    if (nearbyRouting) u.morale -= 1.2 * DT * this.stats(u).moraleTaken;
    if (u.underFire <= 0 && u.meleeWith === null) {
      u.morale = Math.min(100, u.morale + RULES.moraleRecovery * DT);
    }
    if (u.morale <= 0) {
      u.morale = 0;
      u.state = 'routing';
      u.routs += 1;
      u.meleeWith = null;
      u.order = { kind: 'hold' };
      u.waypoints = [];
      for (const e of enemies) if (e.meleeWith === u.id) e.meleeWith = null;
      this.log(u.side, u.routs > 1 ? `${u.name} breaks for good` : `${u.name} is routing`);
    } else {
      u.state = u.morale < RULES.waveringAt ? 'wavering' : 'ok';
    }
  }

  private updateRouting(u: Unit, enemies: Unit[]) {
    const edge = homeEdgeX(u.side);
    const goal = { x: edge, y: u.y };
    const desired = Math.atan2(goal.y - u.y, goal.x - u.x);
    u.facing = desired;
    const step = this.speedOf(u) * DT;
    const next = { x: u.x + Math.cos(desired) * step, y: u.y };
    if (crossesRiver(u, next) && !nearCrossing(u) && !nearCrossing(next)) {
      // Routing troops swim for it, losing men on the way.
      this.damage(u, u.men * 0.01 * DT, u, 0);
    }
    u.x = next.x;
    u.moving = true;
    const threat = enemies.some((e) => e.state !== 'routing' && dist(e, u) < RULES.rallySafeDistance);
    if (!threat) u.morale += 1.5 * DT;
    if (u.routs === 1 && !threat && u.morale >= RULES.rallyAt) {
      u.state = 'wavering';
      u.order = { kind: 'hold' };
      u.facing = u.side === 0 ? 0 : Math.PI;
      this.log(u.side, `${u.name} rallies`);
    }
  }

  private separate() {
    for (let i = 0; i < this.units.length; i++) {
      const a = this.units[i];
      for (let j = i + 1; j < this.units.length; j++) {
        const b = this.units[j];
        if (a.side !== b.side || a.state === 'routing' || b.state === 'routing') continue;
        const d = dist(a, b);
        if (d === 0 || d > 260) continue;
        const nx = (b.x - a.x) / d;
        const ny = (b.y - a.y) / d;
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
      if (nearEdge && u.state !== 'ok') u.edgeTime += DT;
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
        this.log(u.side, spent ? `${u.name} has been destroyed` : `${u.name} has deserted the field`);
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
        if (u.state !== 'routing' && dist(u, o) <= RULES.captureRadius) present[u.side] = true;
      }
      if (present[0] !== present[1]) {
        const side: Side = present[0] ? 0 : 1;
        if (this.owners[i] !== side) this.log(side, `${this.sides[side].nation} takes ${o.name}`);
        this.owners[i] = side;
      }
      const owner = this.owners[i];
      if (owner !== -1) this.sides[owner].score += (mult / 60) * DT;
    });
    for (const side of [0, 1] as Side[]) {
      const mine = this.owners.filter((o) => o === side).length;
      const theirs = this.owners.filter((o) => o === 1 - side).length;
      this.sides[side].objectiveDrain += (0.3 * Math.max(0, theirs - mine) * mult / 60) * DT;
    }
  }

  private armyMorale() {
    for (const side of [0, 1] as Side[]) {
      const s = this.sides[side];
      const routing = this.units.filter((u) => u.side === side && u.state === 'routing').length;
      const lossFrac = s.lostMen / Math.max(1, s.fieldedMen);
      const timePressure = this.time > RULES.timePressureAt ? (4 * (this.time - RULES.timePressureAt)) / 60 : 0;
      s.armyMorale = Math.max(0, 100 - 60 * lossFrac - 4 * routing - 4 * s.removed - s.objectiveDrain - timePressure);
    }
  }

  private checkEnd() {
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

  private end(winner: Side | -1, reason: string) {
    this.phase = 'ended';
    this.result = { winner, reason };
    this.log(-1, reason);
  }
}
