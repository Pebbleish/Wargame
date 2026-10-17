import {
  CAVALRY_SIZE, FORMATION, Formation, MAP, RULES, UNIT_TYPES, UnitTypeId,
} from './config';
import {
  OBJECTIVES, Vec, clampToMap, crossesRiver, dist, nearCrossing, planRoute, terrainAt,
} from './map';
import { Rng } from './rng';

export type Side = 0 | 1;
export type UnitState = 'ok' | 'wavering' | 'routing';

export type Order =
  | { kind: 'hold' }
  | { kind: 'move'; x: number; y: number; facing?: number }
  | { kind: 'attack'; target: number };

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
  limberTimer: number;
  underFire: number; // seconds of "recently hit" left
  firedAt: number; // battle time of last volley, for smoke
  meleeWith: number | null;
  charged: number[]; // targets this cavalry unit already hit with a charge
  moving: boolean;
  marching: boolean; // temporarily in column for a long march, back to its formation on arrival
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
  | { kind: 'ready'; side: Side };

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

/** The formation a unit is actually in right now: long marches are made in column automatically. */
export function formationOf(u: Pick<Unit, 'formation'> & { marching?: boolean }): Formation {
  return u.marching ? 'column' : u.formation;
}

export function unitSize(u: Pick<Unit, 'type' | 'formation'> & { marching?: boolean }): { w: number; d: number } {
  if (u.type === 'cavalry') return CAVALRY_SIZE;
  return FORMATION[formationOf(u)];
}

export function unitRadius(u: Pick<Unit, 'type' | 'formation'> & { marching?: boolean }): number {
  const s = unitSize(u);
  return (s.w + s.d) / 4;
}

export function inZone(side: Side, p: Vec): boolean {
  if (p.y < 0 || p.y > MAP.height) return false;
  return side === 0 ? p.x >= 0 && p.x <= RULES.zoneDepth : p.x >= MAP.width - RULES.zoneDepth && p.x <= MAP.width;
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
  };
}

export class World {
  phase: 'deploy' | 'battle' | 'ended' = 'deploy';
  deployLeft = RULES.deploymentTime;
  time = 0;
  units: Unit[] = [];
  sides: [SideState, SideState];
  owners: (Side | -1)[] = OBJECTIVES.map(() => -1);
  events: GameEvent[] = [];
  result: Result | null = null;
  impacts: Impact[] = [];
  rng: Rng;
  private nextId = 1;
  private nextGroup = 1;
  private groupSpeed = new Map<number, number>();

  constructor(seed = 1, nations: [string, string] = ['Valdmark', 'Ostmark']) {
    this.rng = new Rng(seed);
    this.sides = [newSide(nations[0]), newSide(nations[1])];
    for (const side of [0, 1] as Side[]) this.placeCore(side);
  }

  // ---------- setup ----------

  private placeCore(side: Side) {
    const core: UnitTypeId[] = ['line', 'line', 'light', 'line', 'line', 'line', 'cavalry', 'artillery'];
    const ys = [600, 975, 1275, 1500, 1725, 2025, 2550, 1500];
    const xs = [300, 300, 340, 320, 300, 300, 200, 150];
    core.forEach((type, i) => {
      const x = side === 0 ? xs[i] : MAP.width - xs[i];
      const y = side === 0 ? ys[i] : MAP.height - ys[i];
      this.spawn(side, type, x, y);
    });
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
      formation: def.formations[0] === 'limbered' ? 'unlimbered' : def.formations[0],
      order: { kind: 'hold' },
      waypoints: [],
      state: 'ok',
      routs: 0,
      limberTimer: 0,
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
            if (!inZone(u.side, p)) continue;
            u.x = p.x;
            u.y = p.y;
            if (cmd.facing !== undefined) u.facing = cmd.facing;
            continue;
          }
          u.order = { kind: 'move', x: p.x, y: p.y, facing: cmd.facing };
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
            // Guns never charge: attacking with artillery means shelling where the target stands.
            u.fireZone = { x: target.x, y: target.y };
            continue;
          }
          u.order = { kind: 'attack', target: target.id };
          u.waypoints = planRoute(u, target);
          u.group = 0;
        }
        break;
      }
      case 'bombard': {
        if (this.phase !== 'battle') break;
        for (const id of cmd.ids) {
          const u = own(id);
          if (u?.type === 'artillery') u.fireZone = clampToMap({ x: cmd.x, y: cmd.y });
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
        }
        break;
      }
      case 'formation': {
        for (const id of cmd.ids) {
          const u = own(id);
          if (!u) continue;
          const options: Formation[] = UNIT_TYPES[u.type].formations.filter((f) => f !== 'limbered' && f !== 'unlimbered');
          if (options.length < 2) continue;
          const next = cmd.formation && options.includes(cmd.formation)
            ? cmd.formation
            : options[(options.indexOf(u.formation) + 1) % options.length];
          u.formation = next;
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
    }
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
    this.updateGroupSpeeds();
    this.updateVisibility();
    this.economy();
    this.arrivals();
    for (const u of this.units) this.updateUnit(u);
    this.resolveMelee();
    this.separate();
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
        e.seen[side] = this.units.some((o) => o.side === side && dist(o, e) <= sight.get(o.id)!);
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
        if (u.type === 'line' || u.type === 'engineers') u.formation = 'column';
        if (u.type === 'artillery') u.formation = 'limbered';
        u.order = { kind: 'move', x: c.x, y: c.y };
        u.waypoints = [{ x: c.x, y: c.y }];
        this.log(c.side, `${u.name} arrives`);
      }
    }
  }

  /** Speed on open ground, before terrain and keeping pace with the group. */
  private baseSpeed(u: Unit): number {
    const def = UNIT_TYPES[u.type];
    const fm = u.type === 'cavalry' ? 1 : FORMATION[formationOf(u)].speed;
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
    if (formationOf(u) === 'line') return 1.5;
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
      if (!target || (target.state === 'routing' && u.type !== 'cavalry')) {
        u.order = { kind: 'hold' };
      } else {
        const d = dist(u, target);
        const standOff = def.range > 0 && u.type !== 'line' ? def.range * 0.8 : 0;
        if (standOff > 0 && d <= standOff) goal = null;
        else {
          if (u.waypoints.length === 0 || dist(u.waypoints[u.waypoints.length - 1], target) > 60) u.waypoints = planRoute(u, target);
          goal = u.waypoints[0];
        }
      }
    }

    // Artillery has to limber before it moves and unlimber before it fires.
    if (u.type === 'artillery') {
      const wantsMove = goal !== null;
      if (wantsMove && u.formation === 'unlimbered') {
        u.limberTimer += DT;
        if (u.limberTimer >= RULES.limberTime) { u.formation = 'limbered'; u.limberTimer = 0; }
        goal = null;
      } else if (!wantsMove && u.formation === 'limbered') {
        u.limberTimer += DT;
        if (u.limberTimer >= RULES.limberTime) { u.formation = 'unlimbered'; u.limberTimer = 0; }
      } else {
        u.limberTimer = 0;
      }
    }

    u.marching = this.shouldMarch(u, goal, enemies);
    u.moving = false;
    if (goal && u.meleeWith === null) this.moveToward(u, goal, enemies, target);

    if (u.type === 'artillery') this.bombard(u);
    else if (!u.moving && u.meleeWith === null) this.fire(u, enemies, target);
    else if (u.type === 'light' && u.formation === 'skirmish' && u.meleeWith === null) this.fire(u, enemies, target, 0.5);

    this.updateMorale(u, enemies);
  }

  private shouldMarch(u: Unit, goal: Vec | null, enemies: Unit[]): boolean {
    if (!goal || u.order.kind !== 'move' || u.formation === 'column' || u.meleeWith !== null) return false;
    if (u.type !== 'line' && u.type !== 'light' && u.type !== 'engineers') return false;
    const final = u.waypoints[u.waypoints.length - 1] ?? goal;
    const enemyNear = enemies.some((e) => e.seen[u.side] && e.state !== 'routing' && dist(e, u) < 700);
    return !enemyNear && dist(u, final) > 250 + (u.marching ? 0 : 100);
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
    if (!zone || u.formation !== 'unlimbered' || u.moving || u.meleeWith !== null) return;
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
      const taken = t.type === 'cavalry' ? 1.1 : FORMATION[formationOf(t)].fireTaken;
      const cas = RULES.shellDamage * strength * falloff * taken * terrainAt(t).cover * this.rng.range(0.7, 1.3);
      this.damage(t, cas, u, 3.5);
    }
  }

  private flankMultiplier(attacker: Vec, target: Unit): number {
    const toAttacker = Math.atan2(attacker.y - target.y, attacker.x - target.x);
    const off = Math.abs(angleDiff(target.facing, toAttacker));
    if (target.formation === 'square') return 1;
    if (off < Math.PI / 3) return 1;
    if (off < (2 * Math.PI) / 3) return 2;
    return 3;
  }

  private damage(target: Unit, casualties: number, from: Vec, moraleWeight: number) {
    const lost = Math.min(target.men, casualties);
    target.men -= lost;
    this.sides[target.side].lostMen += lost;
    const flank = this.flankMultiplier(from, target);
    target.morale -= (lost / target.maxMen) * 100 * moraleWeight * flank;
    target.underFire = 2;
  }

  private fire(u: Unit, enemies: Unit[], ordered?: Unit, scale = 1) {
    const def = UNIT_TYPES[u.type];
    if (def.range <= 0 || u.state === 'routing') return;
    if (u.type === 'artillery' && u.formation !== 'unlimbered') return;
    const fm = FORMATION[formationOf(u)].fire;
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
    const taken = best.type === 'cavalry' ? 1.1 : FORMATION[formationOf(best)].fireTaken;
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
      const vs = e.type === 'cavalry' ? 1 : FORMATION[formationOf(e)].vsCavalry;
      const impact = (22 * flank) / vs;
      e.morale -= impact;
      this.damage(e, e.men * 0.03 * (flank / vs), u, 1);
      if (e.formation === 'square') this.damage(u, u.men * 0.08, e, 2);
    }
  }

  private meleePower(u: Unit, vs: Unit): number {
    const def = UNIT_TYPES[u.type];
    let p = u.men * (u.morale / 100 + 0.3) * def.shock;
    if (vs.type === 'cavalry' && u.type !== 'cavalry') p *= FORMATION[formationOf(u)].vsCavalry;
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
    if (nearbyRouting) u.morale -= 1.2 * DT;
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

  private cleanup() {
    const keep: Unit[] = [];
    for (const u of this.units) {
      const atEdge = u.state === 'routing' && (u.side === 0 ? u.x <= 5 : u.x >= MAP.width - 5);
      const spent = u.men < u.maxMen * 0.15;
      if (atEdge || spent) {
        this.sides[u.side].removed += 1;
        this.sides[1 - u.side].score += 2;
        this.log(u.side, spent ? `${u.name} has been destroyed` : `${u.name} has fled the field`);
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
      const timePressure = this.time > 18 * 60 ? (2 * (this.time - 18 * 60)) / 60 : 0;
      s.armyMorale = Math.max(0, 100 - 60 * lossFrac - 4 * routing - 4 * s.removed - s.objectiveDrain - timePressure);
    }
  }

  private checkEnd() {
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
