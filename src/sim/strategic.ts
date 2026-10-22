import { UNIT_TYPES, UnitTypeId } from './config';
import { mapFor } from './fairmaps';
import { Rng } from './rng';
import { ArmyEntry } from './world';

/**
 * The campaign map: a war of defence. Ostmark has crossed the border into Valdmark, and the two countries' territories
 * meet along a front. Armies move freely across the country, Bannerlord-style: yours, your allies' (lords of Valdmark
 * with armies of their own) and Ostmark's. Ostmark's lords strike at your towns once or twice a day, and every attack
 * is announced, so you can ride to the town's defence. Walk into a town Ostmark holds to storm it, or catch one of its
 * armies in the field. Each Ostmark army is led by a lord in person: kill the general in battle and the army breaks.
 * Territories pay gold each day; gold recruits and refits regiments; victories bring promotion and a bigger army.
 * Taking Ostgard, Ostmark's capital, wins the war; losing Valdhaven loses it.
 *
 * Everything here is plain data and pure functions, so a campaign saves as JSON and can be tested without a screen.
 */

export const WORLD = { width: 1600, height: 1000 };
const CELL = 5;
const COLS = WORLD.width / CELL;
const ROWS = WORLD.height / CELL;

export type Owner = 0 | 1;
export const OWNER_NAMES = ['Valdmark', 'Ostmark'];

export interface Territory {
  id: number;
  name: string;
  x: number; // its town
  y: number;
  owner: Owner;
  capital: boolean;
  weight: number; // how far its land reaches: bigger territories have bigger weights
  income: number; // gold a day
  garrison: ArmyEntry[];
  mapSeed: number; // the battlefield fought on here
  neighbours: number[];
}

export interface Army {
  id: number;
  side: 0 | 1;
  name: string;
  lord: string; // who leads it
  player?: boolean; // the army you lead
  x: number;
  y: number;
  target: { x: number; y: number } | null;
  regiments: ArmyEntry[];
  mission?: number; // the town it is marching to attack (Ostmark) or relieve (allies)
  siege?: number; // the town it is besieging, until busyUntil
  busyUntil?: number; // besieging until this day (Ostmark); raising a new army until this day (yours)
  resting?: boolean; // gone home to fill its ranks
  wander?: number; // the day it picks a new place to stand
}

export type BattleKind = 'field' | 'assault' | 'relief' | 'holdout';

/** A battle the player has to settle: where, of what kind, and who is in it. */
export interface Encounter {
  territory: number;
  kind: BattleKind;
  enemies: number[]; // Ostmark armies fighting (the first one is the one we met)
  allies: number[]; // allied armies near enough to join us
  garrison: 0 | 1 | null; // which side the town's garrison fights on, if it fights
  attacking: boolean; // we marched in (true) or were caught or besieged (false)
  relief: { army: number | null; name: string; regiments: ArmyEntry[] } | null; // holdout: who is coming to help
}

/** Something the player must hear about at once: Ostmark is marching on one of our towns. */
export interface Alert {
  territory: number;
  army: number;
}

export interface Campaign {
  version: 2;
  seed: number;
  slot: number;
  day: number;
  gold: number;
  wins: number;
  rank: number; // index into RANKS
  tutorialDone: boolean;
  territories: Territory[];
  armies: Army[];
  nextArmyId: number;
  enemyGold: number;
  lastRaise: number; // day Ostmark last raised an army
  attacksToday: number; // town attacks Ostmark has launched today
  attackCap: number; // and how many it will launch today (1 or 2)
  lordsUsed: number;
  log: { day: number; text: string; tone: 'good' | 'bad' | 'info' }[];
  encounter: Encounter | null;
  alert: Alert | null;
  over: 'won' | 'lost' | null;
  rolls: number; // how many random rolls have been made, so loading a save carries on the same sequence
}

export const RANKS = [
  { name: 'Lieutenant', wins: -1, regiments: 4 },
  { name: 'Captain', wins: 0, regiments: 6 },
  { name: 'Major', wins: 2, regiments: 8 },
  { name: 'Colonel', wins: 5, regiments: 10 },
  { name: 'General', wins: 9, regiments: 14 },
];

export const RECRUIT_COST: Partial<Record<UnitTypeId, number>> = { line: 100, light: 80, cavalry: 130, artillery: 150, engineers: 70 };
export const REFIT_PER_MAN = 0.05;
export const MARCH_SPEED = 90; // map units a day
export const RELIEF_SECONDS = 300; // how long a besieged town must hold before the relief arrives
const CONTACT = 28; // armies this close meet
const ARRIVE = 24; // an army this close to its target has arrived
const JOIN = 90; // armies this close to a battle join it
const SIEGE_DAYS = 2;
const RANSOM = 250; // gold for a captured enemy lord

const NAMES = ['Aldenburg', 'Brenna', 'Corvin', 'Dravo', 'Eschen', 'Falkmar', 'Grauwitz', 'Holtz', 'Isenau', 'Jarow', 'Kaltbach', 'Lunden', 'Morvay', 'Nesse', 'Orlau', 'Pressa', 'Quentz', 'Rabenau', 'Stelling', 'Tarnow', 'Ulrichs', 'Varnholt', 'Wendel', 'Zellin'];
const ENEMY_LORDS = ['Duke Konrad', 'Margrave Ottokar', 'Count Leopold', 'Baron Ruprecht', 'Graf Dietrich', 'Lady Hedwig', 'Count Albrecht', 'Baron Siegmund', 'Margravine Kunigunde', 'Duke Friedrich'];
const ALLY_LORDS = ['Count Aldric', 'Baroness Ilse', 'Lord Matthias', 'Countess Elsbeth'];

// ---------- the land ----------

function landNoise(seed: number) {
  const rng = new Rng(seed * 31 + 7);
  const waves = [0, 1, 2, 3, 4, 5].map(() => ({ fx: rng.range(-1, 1), fy: rng.range(-1, 1), k: (Math.PI * 2) / rng.range(120, 320), ph: rng.range(0, 6.3) }));
  return (x: number, y: number, axis: number) => waves.reduce((s, w, i) => s + Math.sin((x * w.fx + y * w.fy) * w.k + w.ph + axis * (i + 1)), 0);
}

function isLand(noise: (x: number, y: number, a: number) => number, x: number, y: number, margin = 0): boolean {
  const ex = (x - WORLD.width / 2) / (WORLD.width * 0.47 - margin);
  const ey = (y - WORLD.height / 2) / (WORLD.height * 0.45 - margin);
  return ex * ex + ey * ey < 1 + noise(x, y, 3) * 0.06;
}

/** Which territory each cell of the map belongs to (-1 for sea), worked out from the campaign seed. */
export function territoryGrid(c: Pick<Campaign, 'seed' | 'territories'>): Int16Array {
  const noise = landNoise(c.seed);
  const grid = new Int16Array(COLS * ROWS);
  for (let gy = 0; gy < ROWS; gy++) {
    for (let gx = 0; gx < COLS; gx++) {
      const x = (gx + 0.5) * CELL;
      const y = (gy + 0.5) * CELL;
      if (!isLand(noise, x, y)) { grid[gy * COLS + gx] = -1; continue; }
      // Borders wander: measure distance from a point nudged by the noise. Weighted, so territories differ in size.
      const wx = x + noise(x, y, 0) * 14;
      const wy = y + noise(x, y, 1) * 14;
      let best = 0;
      let bd = Infinity;
      for (const t of c.territories) {
        const d = Math.hypot(t.x - wx, t.y - wy) / t.weight;
        if (d < bd) { bd = d; best = t.id; }
      }
      grid[gy * COLS + gx] = best;
    }
  }
  return grid;
}

export function territoryAt(grid: Int16Array, x: number, y: number): number {
  const gx = Math.floor(x / CELL);
  const gy = Math.floor(y / CELL);
  if (gx < 0 || gy < 0 || gx >= COLS || gy >= ROWS) return -1;
  return grid[gy * COLS + gx];
}

export const GRID_SIZE = { cols: COLS, rows: ROWS, cell: CELL };

/** The front line between the two countries: Valdmark west of it, Ostmark east. */
function frontX(seed: number, y: number): number {
  const ph = (seed % 1000) / 159;
  return WORLD.width * (0.53 + 0.06 * Math.sin(y / 170 + ph) + 0.03 * Math.sin(y / 61 + ph * 2));
}

/** A new campaign: Valdmark in the west, Ostmark in the east, the two meeting along a front. */
export function newCampaign(slot: number, seed: number): Campaign {
  const rng = new Rng(seed);
  const noise = landNoise(seed);
  const names = NAMES.slice();
  // Towns scattered over the land, some with a lot of room round them and some crowded: territories of all sizes.
  const sites: { x: number; y: number; weight: number }[] = [];
  for (let tries = 0; sites.length < 22 && tries < 6000; tries++) {
    const x = rng.range(0.05, 0.95) * WORLD.width;
    const y = rng.range(0.08, 0.92) * WORLD.height;
    if (!isLand(noise, x, y, 50)) continue;
    const weight = rng.range(0.75, 1.45);
    if (sites.some((s) => Math.hypot(s.x - x, s.y - y) < 120 * Math.max(s.weight, weight))) continue;
    sites.push({ x, y, weight });
  }
  const territories: Territory[] = sites.map((s, id) => ({
    id, name: names.splice(Math.floor(rng.next() * names.length), 1)[0], x: s.x, y: s.y, weight: s.weight,
    owner: s.x < frontX(seed, s.y) ? 0 : 1, capital: false, income: 0, garrison: [], mapSeed: 1 + Math.floor(rng.next() * 100000), neighbours: [],
  }));
  // Capitals: the town deepest in each country, near the middle.
  const capital = (side: Owner) => territories.filter((t) => t.owner === side).sort((a, b) => (side === 0 ? a.x - b.x : b.x - a.x) + Math.abs(a.y - WORLD.height / 2) * 0.8 - Math.abs(b.y - WORLD.height / 2) * 0.8)[0];
  for (const side of [0, 1] as const) {
    const t = capital(side);
    t.capital = true;
    t.name = side === 0 ? 'Valdhaven' : 'Ostgard';
  }
  const c: Campaign = {
    version: 2, seed, slot, day: 0, gold: 250, wins: 0, rank: 0, tutorialDone: false,
    territories, armies: [], nextArmyId: 1, enemyGold: 0, lastRaise: 0, attacksToday: 0, attackCap: 1, lordsUsed: 0,
    log: [], encounter: null, alert: null, over: null, rolls: 0,
  };
  // Neighbours share a border on the grid; income follows the size of the land.
  const grid = territoryGrid(c);
  const area = new Array(territories.length).fill(0);
  const pairs = new Set<string>();
  for (let gy = 0; gy < ROWS; gy++) {
    for (let gx = 0; gx < COLS; gx++) {
      const a = grid[gy * COLS + gx];
      if (a < 0) continue;
      area[a]++;
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        if (gx + dx >= COLS || gy + dy >= ROWS) continue;
        const b = grid[(gy + dy) * COLS + gx + dx];
        if (b >= 0 && b !== a) pairs.add(a < b ? `${a},${b}` : `${b},${a}`);
      }
    }
  }
  for (const p of pairs) {
    const [a, b] = p.split(',').map(Number);
    territories[a].neighbours.push(b);
    territories[b].neighbours.push(a);
  }
  const mean = area.reduce((s, v) => s + v, 0) / territories.length;
  for (const t of territories) {
    t.income = t.capital ? 40 : Math.max(10, Math.round((8 + 14 * (area[t.id] / mean)) / 5) * 5);
    t.garrison = garrisonFor(t);
  }
  const home = territories.find((t) => t.capital && t.owner === 0)!;
  c.armies.push({ id: c.nextArmyId++, side: 0, name: 'Your army', lord: 'You', player: true, x: home.x + 30, y: home.y + 20, target: null, regiments: [] });
  // Two lords of Valdmark hold the line with you; three of Ostmark's armies stand on the border.
  const front = (side: Owner) => territories.filter((t) => t.owner === side && t.neighbours.some((n) => territories[n].owner !== side));
  for (let i = 0; i < 2; i++) {
    const at = front(0)[Math.floor(rng.next() * front(0).length)] ?? home;
    c.armies.push({ id: c.nextArmyId++, side: 0, name: `${ALLY_LORDS[i]}'s army`, lord: ALLY_LORDS[i], x: at.x - 25, y: at.y + 20, target: null, regiments: makeRegiments(6, 15) });
  }
  for (let i = 0; i < 3; i++) {
    const at = front(1)[i % Math.max(1, front(1).length)];
    raiseEnemyArmy(c, 6, at);
  }
  note(c, 'Ostmark has crossed the border. Its armies stand on our frontier; our lords are holding the line.', 'bad');
  return c;
}

function makeRegiments(size: number, xp: number): ArmyEntry[] {
  const types: UnitTypeId[] = ['line', 'line', 'light', 'cavalry', 'artillery', 'line', 'line', 'cavalry', 'artillery', 'line', 'light', 'line'];
  return types.slice(0, size).map((type) => ({ type, men: UNIT_TYPES[type].men, xp }));
}

function garrisonFor(t: Territory): ArmyEntry[] {
  const reg = (type: UnitTypeId, xp = 10): ArmyEntry => ({ type, men: UNIT_TYPES[type].men, xp });
  if (t.capital) return [reg('line', 30), reg('line', 30), reg('line', 30), reg('artillery', 30), reg('light', 30)];
  if (t.owner === 1) return [reg('line', 20), reg('line', 20), reg('artillery', 20)];
  return [reg('line'), reg('line'), reg('light')];
}

// ---------- helpers ----------

export function playerArmy(c: Campaign): Army {
  return c.armies.find((a) => a.player)!;
}

export function armyById(c: Campaign, id: number): Army | undefined {
  return c.armies.find((a) => a.id === id);
}

export function rankOf(c: Campaign) {
  return RANKS[c.rank];
}

export function note(c: Campaign, text: string, tone: 'good' | 'bad' | 'info' = 'info') {
  c.log.push({ day: Math.floor(c.day), text, tone });
  if (c.log.length > 40) c.log.shift();
}

function roll(c: Campaign): number {
  const r = new Rng(c.seed * 977 + c.rolls * 7919 + 13);
  c.rolls++;
  return r.next();
}

/** How much a body of troops is worth in a fight. */
export function strength(regs: ArmyEntry[]): number {
  const w: Record<UnitTypeId, number> = { line: 1, light: 0.8, cavalry: 1.2, artillery: 1.5, engineers: 0.4, supply: 0, general: 0 };
  return regs.reduce((s, r) => s + (r.men / 100) * w[r.type] * (1 + r.xp / 200), 0);
}

/** The chance that the first body of troops beats the second, as the settle-at-once rules see it. */
export function winChance(a: ArmyEntry[], b: ArmyEntry[]): number {
  const sa = strength(a);
  const sb = strength(b);
  if (sa + sb <= 0) return 0.5;
  const r = sa / (sa + sb);
  return r ** 2.5 / (r ** 2.5 + (1 - r) ** 2.5);
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

export function ownedBy(c: Campaign, side: Owner): Territory[] {
  return c.territories.filter((t) => t.owner === side);
}

/** The territory under a point (by nearest town if the point is at sea). */
export function territoryUnder(c: Campaign, grid: Int16Array, p: { x: number; y: number }): Territory {
  const id = territoryAt(grid, p.x, p.y);
  return id >= 0 ? c.territories[id] : c.territories.slice().sort((a, b) => dist(a, p) - dist(b, p))[0];
}

function fielded(c: Campaign, side: 0 | 1): Army[] {
  return c.armies.filter((a) => a.side === side && a.regiments.length && !(a.player && a.busyUntil !== undefined));
}

function allies(c: Campaign): Army[] {
  return fielded(c, 0).filter((a) => !a.player);
}

function nearestOwn(c: Campaign, side: Owner, p: { x: number; y: number }): Territory | undefined {
  return ownedBy(c, side).sort((a, b) => dist(a, p) - dist(b, p))[0];
}

function frontTowns(c: Campaign, side: Owner): Territory[] {
  return ownedBy(c, side).filter((t) => t.neighbours.some((n) => c.territories[n].owner !== side));
}

function full(a: Army): number {
  const men = a.regiments.reduce((s, r) => s + r.men, 0);
  const max = a.regiments.reduce((s, r) => s + UNIT_TYPES[r.type].men, 0);
  return max ? men / max : 0;
}

/** Is Ostmark attacking this town right now (marching on it or besieging it)? */
export function attackersOf(c: Campaign, t: Territory): Army[] {
  return fielded(c, 1).filter((a) => a.mission === t.id || a.siege === t.id);
}

// ---------- time passing ----------

/**
 * Move the campaign on by dt days: armies march, lords on both sides decide what to do, gold comes in at each new day.
 * Stops early, with c.encounter or c.alert set, when the player has a battle to fight or news to hear.
 */
export function advance(c: Campaign, grid: Int16Array, dt: number) {
  if (c.over || c.encounter || c.alert) return;
  const me = playerArmy(c);
  const before = Math.floor(c.day);
  c.day += dt;
  if (Math.floor(c.day) > before) newDay(c);
  // March.
  for (const a of c.armies) {
    if (a.siege !== undefined || !a.target || !a.regiments.length) continue;
    const goal = a.target;
    const d = dist(a, goal);
    const step = MARCH_SPEED * dt * (a.side === 1 ? 0.85 : a.player ? 1 : 0.9);
    const onLand = territoryAt(grid, a.x, a.y) >= 0;
    if (d <= step) { a.x = goal.x; a.y = goal.y; if (a.player) a.target = null; }
    else { a.x += ((goal.x - a.x) / d) * step; a.y += ((goal.y - a.y) / d) * step; }
    // The land ends at the coast (an army camped just off it can still walk ashore).
    if (onLand && territoryAt(grid, a.x, a.y) < 0) { a.x -= ((goal.x - a.x) / Math.max(d, 1)) * step; a.y -= ((goal.y - a.y) / Math.max(d, 1)) * step; a.target = null; }
  }
  if (me.regiments.length && me.busyUntil === undefined && playerMeets(c, grid, me)) return;
  thinkEnemy(c, dt);
  if (c.encounter || c.alert) return;
  thinkAllies(c);
  lordsClash(c, grid);
}

/** The player's army runs into something: an Ostmark army, an Ostmark town, or one of our towns under siege. */
function playerMeets(c: Campaign, grid: Int16Array, me: Army): boolean {
  const foe = fielded(c, 1).find((a) => dist(a, me) < CONTACT);
  if (foe) {
    // Meeting the besiegers of one of our towns is a battle to relieve it.
    const sieged = foe.siege !== undefined ? c.territories[foe.siege] : null;
    if (sieged) { startRelief(c, sieged); return true; }
    const attacking = !!me.target && dist(me.target, foe) < dist(me.target, me) + CONTACT;
    c.encounter = {
      territory: territoryUnder(c, grid, me).id, kind: 'field', attacking, garrison: null, relief: null,
      enemies: [foe.id, ...fielded(c, 1).filter((a) => a !== foe && dist(a, foe) < JOIN && a.siege === undefined).map((a) => a.id)],
      allies: alliesNear(c, me),
    };
    me.target = null;
    return true;
  }
  const t = territoryUnder(c, grid, me);
  if (dist(me, t) >= ARRIVE) return false;
  if (t.owner === 1) {
    me.target = null;
    const defenders = fielded(c, 1).filter((a) => dist(a, t) < JOIN && a.siege === undefined);
    if (!t.garrison.length && !defenders.length) { capture(c, t, 0); return false; }
    c.encounter = { territory: t.id, kind: 'assault', attacking: true, garrison: t.garrison.length ? 1 : null, enemies: defenders.map((a) => a.id), allies: alliesNear(c, t), relief: null };
    return true;
  }
  if (fielded(c, 1).some((a) => a.siege === t.id)) { startRelief(c, t); return true; }
  return false;
}

function alliesNear(c: Campaign, p: { x: number; y: number }): number[] {
  return allies(c).filter((a) => dist(a, p) < JOIN && !a.resting).map((a) => a.id);
}

function startRelief(c: Campaign, t: Territory) {
  const me = playerArmy(c);
  me.target = null;
  c.encounter = {
    territory: t.id, kind: 'relief', attacking: true, garrison: t.garrison.length ? 0 : null, relief: null,
    enemies: fielded(c, 1).filter((a) => a.siege === t.id).map((a) => a.id), allies: alliesNear(c, t),
  };
}

/** Ostmark storms a town the player is standing in: hold out until help comes. */
function startHoldout(c: Campaign, t: Territory, besiegers: Army[]) {
  const me = playerArmy(c);
  me.target = null;
  const joined = alliesNear(c, t);
  // The relief: the nearest allied army not already here, or failing that the militia of the nearest other town.
  const helper = allies(c).filter((a) => !joined.includes(a.id)).sort((a, b) => dist(a, t) - dist(b, t))[0];
  const militiaTown = ownedBy(c, 0).filter((o) => o !== t).sort((a, b) => dist(a, t) - dist(b, t))[0];
  const relief = helper
    ? { army: helper.id, name: helper.name, regiments: helper.regiments.map((r) => ({ ...r, army: helper.id })) }
    : militiaTown ? { army: null, name: `The militia of ${militiaTown.name}`, regiments: [{ type: 'line' as UnitTypeId, men: 1600, xp: 0, town: t.id }, { type: 'light' as UnitTypeId, men: 700, xp: 0, town: t.id }] } : null;
  c.encounter = { territory: t.id, kind: 'holdout', attacking: false, garrison: t.garrison.length ? 0 : null, enemies: besiegers.map((a) => a.id), allies: joined, relief };
}

function newDay(c: Campaign) {
  c.gold += ownedBy(c, 0).reduce((s, t) => s + t.income, 0);
  c.enemyGold += ownedBy(c, 1).reduce((s, t) => s + t.income, 0);
  const day = Math.floor(c.day);
  // Ostmark strikes at our towns once or twice a day, no more.
  c.attacksToday = 0;
  c.attackCap = roll(c) < 0.5 ? 1 : 2;
  // Garrisons slowly fill back up, every few days.
  if (day % 4 === 0) {
    for (const t of c.territories) {
      const want = garrisonFor(t).length;
      if (t.garrison.length < want && !c.armies.some((a) => a.siege === t.id)) t.garrison.push({ type: 'line', men: UNIT_TYPES.line.men, xp: 0 });
    }
  }
  // Lords' armies resting in their own land get men back, and allied lords slowly recruit.
  for (const a of c.armies) {
    if (a.player || !a.regiments.length) continue;
    const home = nearestOwn(c, a.side, a);
    if (home && dist(home, a) < 70) for (const r of a.regiments) r.men = Math.min(UNIT_TYPES[r.type].men, r.men + UNIT_TYPES[r.type].men * 0.12);
    if (a.side === 0 && day % 4 === 0 && a.regiments.length < 7) a.regiments.push({ type: 'line', men: UNIT_TYPES.line.men, xp: 0 });
  }
  // A beaten allied lord raises a new army after a while.
  for (const a of c.armies) {
    if (a.side === 0 && !a.player && !a.regiments.length && a.busyUntil !== undefined && c.day >= a.busyUntil) {
      const home = nearestOwn(c, 0, a);
      if (home) { a.x = home.x - 20; a.y = home.y + 20; a.regiments = makeRegiments(4, 0); a.busyUntil = undefined; a.target = null; note(c, `${a.lord} has raised a new army at ${home.name}.`, 'info'); }
    }
  }
  c.armies = c.armies.filter((a) => a.side === 0 || a.regiments.length);
  // Ostmark raises a new army when it can afford one and has few in the field.
  if (c.enemyGold >= 500 && fielded(c, 1).length < 3 + Math.floor(c.day / 20) && c.day - c.lastRaise > 5) {
    c.enemyGold -= 500;
    raiseEnemyArmy(c, 6 + Math.min(4, Math.floor(c.day / 10)));
  }
  // A destroyed player army is raised again at the capital after a few days.
  const me = playerArmy(c);
  if (!me.regiments.length && me.busyUntil !== undefined && c.day >= me.busyUntil) {
    const cap = c.territories.find((t) => t.capital && t.owner === 0) ?? ownedBy(c, 0)[0];
    if (cap) {
      me.x = cap.x + 30;
      me.y = cap.y + 20;
      me.regiments = [{ type: 'line', men: UNIT_TYPES.line.men, xp: 0 }, { type: 'line', men: UNIT_TYPES.line.men, xp: 0 }, { type: 'light', men: UNIT_TYPES.light.men, xp: 0 }];
      me.busyUntil = undefined;
      note(c, `You have escaped and raised a new force at ${cap.name}.`, 'info');
    }
  }
}

function raiseEnemyArmy(c: Campaign, size: number, at?: Territory) {
  const from = at ?? c.territories.find((t) => t.capital && t.owner === 1) ?? ownedBy(c, 1)[0];
  if (!from) return;
  const alive = new Set(fielded(c, 1).map((a) => a.lord));
  let lord = ENEMY_LORDS[c.lordsUsed++ % ENEMY_LORDS.length];
  for (let i = 0; i < ENEMY_LORDS.length && alive.has(lord); i++) lord = ENEMY_LORDS[c.lordsUsed++ % ENEMY_LORDS.length];
  c.armies.push({ id: c.nextArmyId++, side: 1, name: `${lord}'s army`, lord, x: from.x + 22, y: from.y + 18, target: null, regiments: makeRegiments(size, 15), wander: c.day + 1 });
  c.lastRaise = c.day;
  if (c.day > 0) note(c, `${lord} has raised an army at ${from.name}.`, 'bad');
}

/**
 * Ostmark's lords: storm towns they are besieging when the siege is up; go home to recover when spent; chase a weaker
 * army of ours that comes close; strike at our towns (no more than the day's one or two attacks, each announced); and
 * otherwise stand on the frontier, moving about from town to town.
 */
function thinkEnemy(c: Campaign, dt: number) {
  const me = playerArmy(c);
  for (const a of fielded(c, 1)) {
    if (a.siege !== undefined) {
      const t = c.territories[a.siege];
      if (t.owner === 1) { a.siege = undefined; continue; }
      if (c.day < (a.busyUntil ?? 0)) continue;
      siegeResolve(c, a, t);
      continue;
    }
    if (a.resting) {
      if (full(a) > 0.85) a.resting = false;
      else { const home = nearestOwn(c, 1, a); a.target = home ? { x: home.x + 22, y: home.y + 18 } : null; continue; }
    }
    if (full(a) < 0.45) { a.resting = true; a.mission = undefined; continue; }
    // Arrived at a town it was sent against: sit down before it, then storm it.
    if (a.mission !== undefined) {
      const t = c.territories[a.mission];
      if (t.owner === 1) { a.mission = undefined; continue; }
      if (dist(a, t) < ARRIVE * 1.5) {
        a.mission = undefined;
        a.siege = t.id;
        a.busyUntil = c.day + SIEGE_DAYS;
        a.target = null;
        const besiegers = fielded(c, 1).filter((b) => b.siege === t.id);
        if (me.regiments.length && me.busyUntil === undefined && dist(me, t) < JOIN * 0.6) { startHoldout(c, t, besiegers); return; }
        note(c, `${a.lord} is besieging ${t.name}! It will be stormed in two days unless relieved.`, 'bad');
        continue;
      }
      a.target = { x: t.x + 14, y: t.y - 10 };
      continue;
    }
    // A weaker army of ours close by is worth chasing.
    const prey = fielded(c, 0).filter((b) => dist(a, b) < 200 && strength(a.regiments) > strength(b.regiments) * 1.2).sort((p, q) => dist(p, a) - dist(q, a))[0];
    if (prey) { a.target = { x: prey.x, y: prey.y }; continue; }
    // Strike at one of our towns: spread over the day, at most the day's quota.
    if (c.attacksToday < c.attackCap && roll(c) < dt * 1.6) {
      const goals = frontTowns(c, 0).filter((t) => !attackersOf(c, t).length);
      const goal = goals.sort((p, q) => dist(p, a) * (p.garrison.length + 1) - dist(q, a) * (q.garrison.length + 1))[0];
      if (goal && dist(goal, a) < 500) {
        c.attacksToday++;
        a.mission = goal.id;
        a.target = { x: goal.x + 14, y: goal.y - 10 };
        c.alert = { territory: goal.id, army: a.id };
        return;
      }
    }
    // Stand on the frontier, moving from place to place now and then.
    if (a.wander === undefined || c.day >= a.wander || !a.target) {
      const spots = frontTowns(c, 1);
      const spot = spots[Math.floor(roll(c) * spots.length)];
      if (spot) a.target = { x: spot.x + (roll(c) - 0.5) * 60, y: spot.y + (roll(c) - 0.5) * 60 };
      a.wander = c.day + 2 + roll(c) * 3;
    }
  }
}

function siegeResolve(c: Campaign, a: Army, t: Territory) {
  const besiegers = fielded(c, 1).filter((b) => b.siege === t.id);
  const helpers = allies(c).filter((b) => dist(b, t) < JOIN && !b.resting);
  const att = besiegers.flatMap((b) => b.regiments.map((r) => ({ ...r, army: b.id })));
  const def = [...t.garrison.map((r) => ({ ...r, town: t.id })), ...helpers.flatMap((b) => b.regiments.map((r) => ({ ...r, army: b.id })))];
  const won = autoBattle(c, att, def);
  distribute(c, att, besiegers.map((b) => b.id), []);
  distribute(c, def, helpers.map((b) => b.id), [t.id]);
  for (const b of besiegers) { b.siege = undefined; b.busyUntil = undefined; }
  if (won) {
    capture(c, t, 1);
  } else {
    note(c, `${t.name} held out against ${a.lord}${helpers.length ? ` with help from ${helpers.map((h) => h.lord).join(' and ')}` : ''}.`, 'good');
    for (const b of besiegers) b.resting = true;
  }
}

/**
 * Valdmark's lords: rebuild when spent; ride to the help of a town Ostmark is attacking if they are near enough to
 * matter; fall on a weaker Ostmark army close by; otherwise keep watch from one frontier town after another.
 */
function thinkAllies(c: Campaign) {
  const me = playerArmy(c);
  for (const a of allies(c)) {
    if (a.resting) {
      if (full(a) > 0.85) a.resting = false;
      else { const home = nearestOwn(c, 0, a); a.target = home ? { x: home.x - 20, y: home.y + 20 } : null; continue; }
    }
    if (full(a) < 0.5) { a.resting = true; a.mission = undefined; continue; }
    const mine = strength(a.regiments);
    // A town under attack nearby.
    const threatened = ownedBy(c, 0).map((t) => ({ t, foes: attackersOf(c, t) })).filter(({ t, foes }) => foes.length && dist(t, a) < 450 && mine > strength(foes.flatMap((f) => f.regiments)) * 0.6)
      .sort((p, q) => dist(p.t, a) - dist(q.t, a))[0];
    if (threatened) {
      const t = threatened.t;
      // Arrived before a besieged town: fall on the besiegers at once (unless the player is about to).
      const besieger = threatened.foes.find((f) => f.siege === t.id);
      if (besieger && dist(a, t) < JOIN * 0.7 && !(me.regiments.length && dist(me, t) < JOIN * 2)) { siegeResolve(c, besieger, t); continue; }
      if (a.mission !== t.id) note(c, `${a.lord} rides to the help of ${t.name}.`, 'info');
      a.mission = t.id;
      a.target = { x: t.x - 16, y: t.y + 14 };
      continue;
    }
    a.mission = undefined;
    const prey = fielded(c, 1).filter((b) => dist(a, b) < 200 && b.siege === undefined && strength(b.regiments) < mine * 0.9).sort((p, q) => dist(p, a) - dist(q, a))[0];
    if (prey) { a.target = { x: prey.x, y: prey.y }; continue; }
    if (a.wander === undefined || c.day >= a.wander || !a.target) {
      const spots = frontTowns(c, 0);
      const spot = spots[Math.floor(roll(c) * spots.length)];
      if (spot) a.target = { x: spot.x - 20 + (roll(c) - 0.5) * 40, y: spot.y + 20 + (roll(c) - 0.5) * 40 };
      a.wander = c.day + 2 + roll(c) * 3;
    }
  }
}

/** Allied and Ostmark armies that meet fight it out, unless the player is close enough to be part of it. */
function lordsClash(c: Campaign, grid: Int16Array) {
  const me = playerArmy(c);
  for (const a of allies(c)) {
    const foe = fielded(c, 1).find((b) => dist(a, b) < CONTACT && b.siege === undefined);
    if (!foe) continue;
    if (me.regiments.length && dist(me, a) < JOIN * 1.5) continue;
    const ours = [a, ...allies(c).filter((b) => b !== a && dist(b, a) < JOIN)];
    const theirs = [foe, ...fielded(c, 1).filter((b) => b !== foe && dist(b, foe) < JOIN && b.siege === undefined)];
    const mineList = ours.flatMap((b) => b.regiments.map((r) => ({ ...r, army: b.id })));
    const theirList = theirs.flatMap((b) => b.regiments.map((r) => ({ ...r, army: b.id })));
    const won = autoBattle(c, mineList, theirList);
    distribute(c, mineList, ours.map((b) => b.id), []);
    distribute(c, theirList, theirs.map((b) => b.id), []);
    const where = territoryUnder(c, grid, a).name;
    if (won) note(c, `${a.lord} has beaten ${foe.lord} near ${where}.`, 'good');
    else note(c, `${foe.lord} has beaten ${a.lord} near ${where}.`, 'bad');
    for (const b of won ? theirs : ours) b.resting = true;
    for (const b of [...ours, ...theirs]) if (b.regiments.length && strength(b.regiments) < 4) b.regiments = [];
    for (const b of ours) if (!b.regiments.length) { b.busyUntil = c.day + 6; note(c, `${b.lord}'s army has been scattered.`, 'bad'); }
    for (const b of theirs) if (!b.regiments.length) note(c, `${b.lord}'s army has been destroyed.`, 'good');
  }
}

export function capture(c: Campaign, t: Territory, side: Owner) {
  const was = t.owner;
  t.owner = side;
  t.garrison = side === 0 ? [{ type: 'line', men: 1200, xp: 0 }] : [{ type: 'line', men: 1200, xp: 10 }];
  for (const a of c.armies) if (a.mission === t.id) a.mission = undefined;
  if (side === 0) note(c, `${t.name} is ours${t.capital ? ': Ostmark\'s capital has fallen!' : '.'}`, 'good');
  else note(c, `Ostmark has taken ${t.name}${was === 0 && t.capital ? ', our capital!' : '.'}`, 'bad');
  if (t.capital && was === 1 && side === 0) c.over = 'won';
  if (t.capital && was === 0 && side === 1) c.over = 'lost';
}

/**
 * Settle a fight without playing: the stronger side usually wins, and the loser is broken. Both lists are
 * changed in place (casualties, the beaten side's lost regiments). True if the first side wins.
 */
export function autoBattle(c: Campaign, a: ArmyEntry[], b: ArmyEntry[]): boolean {
  const r = strength(a) / Math.max(0.001, strength(a) + strength(b));
  const aWins = roll(c) < winChance(a, b);
  const hurt = (list: ArmyEntry[], share: number) => {
    for (const reg of list) reg.men = Math.round(reg.men * (1 - share * (0.6 + roll(c) * 0.8)));
    for (let i = list.length - 1; i >= 0; i--) if (list[i].men < UNIT_TYPES[list[i].type].men * 0.15) list.splice(i, 1);
  };
  hurt(aWins ? a : b, 0.35 * (aWins ? 1 - r : r));
  hurt(aWins ? b : a, 0.6);
  for (const reg of aWins ? a : b) reg.xp = Math.min(100, reg.xp + 8);
  return aWins;
}

/**
 * Hand the survivors of a battle back to whoever they belong to: each army its tagged regiments, each town its
 * garrison, and the untagged ones to the player's army. Armies and towns that fought and have no survivors are left empty.
 */
function distribute(c: Campaign, survivors: ArmyEntry[], armyIds: number[], townIds: number[], player = false) {
  const strip = (r: ArmyEntry): ArmyEntry => ({ type: r.type, men: r.men, xp: r.xp });
  for (const id of armyIds) { const a = armyById(c, id); if (a) a.regiments = survivors.filter((r) => r.army === id).map(strip); }
  for (const id of townIds) c.territories[id].garrison = survivors.filter((r) => r.town === id).map(strip);
  if (player) playerArmy(c).regiments = survivors.filter((r) => r.army === undefined && r.town === undefined).map(strip);
}

// ---------- the player's battles ----------

/** The two sides of the battle the player faces, each regiment tagged with the army or town it belongs to. */
export function encounterSides(c: Campaign): [ArmyEntry[], ArmyEntry[]] {
  const e = c.encounter!;
  const t = c.territories[e.territory];
  const tag = (ids: number[]) => ids.flatMap((id) => (armyById(c, id)?.regiments ?? []).map((r) => ({ ...r, army: id })));
  const garrison = t.garrison.map((r) => ({ ...r, town: t.id }));
  const mine = [...playerArmy(c).regiments.map((r) => ({ ...r })), ...tag(e.allies), ...(e.garrison === 0 ? garrison : [])];
  const theirs = [...tag(e.enemies), ...(e.garrison === 1 ? garrison : [])];
  return [mine, theirs];
}

/** What the player would face attacking an army or a town right now, with the allies who would join: for the odds. */
export function previewAttack(c: Campaign, target: Army | Territory): { mine: ArmyEntry[]; theirs: ArmyEntry[]; allies: Army[]; chance: number } {
  const me = playerArmy(c);
  const near = allies(c).filter((a) => (dist(a, target) < JOIN || dist(a, me) < JOIN) && !a.resting);
  const isArmy = 'side' in target;
  const foes = isArmy ? [target, ...fielded(c, 1).filter((a) => a !== target && dist(a, target) < JOIN)] : fielded(c, 1).filter((a) => dist(a, target) < JOIN);
  const mine = [...me.regiments, ...near.flatMap((a) => a.regiments)];
  const theirs = [...foes.flatMap((a) => a.regiments), ...(isArmy ? [] : (target as Territory).garrison)];
  return { mine, theirs, allies: near, chance: winChance(mine, theirs) };
}

export function encounterTitle(c: Campaign): string {
  const e = c.encounter!;
  const t = c.territories[e.territory];
  const lead = e.enemies.length ? armyById(c, e.enemies[0]) : undefined;
  if (e.kind === 'assault') return lead ? `${t.name} and ${lead.name}` : `The garrison of ${t.name}`;
  return lead?.name ?? `The garrison of ${t.name}`;
}

/** The lord leading the enemy in person, if there is one. */
export function encounterLord(c: Campaign): string | null {
  const e = c.encounter!;
  return e.enemies.length ? armyById(c, e.enemies[0])?.lord ?? null : null;
}

/** The battlefield for the current encounter. */
export function encounterMap(c: Campaign): number {
  return mapFor(c.territories[c.encounter!.territory].mapSeed);
}

export interface BattleOutcome {
  won: boolean;
  survivors: [ArmyEntry[], ArmyEntry[]];
  generalKilled?: boolean; // the enemy lord fell in the battle
  reliefArrived?: boolean; // holdout: the relief reached the field before the end
}

/** Write a battle's outcome back: the survivors on each side, and what winning or losing means. */
export function settleEncounter(c: Campaign, o: BattleOutcome) {
  const e = c.encounter!;
  const me = playerArmy(c);
  const t = c.territories[e.territory];
  const lead = e.enemies.length ? armyById(c, e.enemies[0]) : undefined;
  const ourArmies = [...e.allies, ...(o.reliefArrived && e.relief?.army != null ? [e.relief.army] : [])];
  const reliefTown = o.reliefArrived && e.relief && e.relief.army === null;
  distribute(c, o.survivors[0], ourArmies, e.garrison === 0 || reliefTown ? [t.id] : [], true);
  distribute(c, o.survivors[1], e.enemies, e.garrison === 1 ? [t.id] : []);
  c.encounter = null;
  for (const id of e.enemies) { const a = armyById(c, id); if (a) { a.siege = undefined; a.busyUntil = undefined; a.mission = undefined; } }
  if (o.won) {
    c.wins++;
    const what = e.kind === 'assault' ? `${t.name} has been stormed` : e.kind === 'holdout' ? `${t.name} has held` : e.kind === 'relief' ? `${t.name} is relieved` : `Victory over ${lead?.name ?? 'the enemy'}`;
    note(c, `${what}!`, 'good');
    if (lead && o.generalKilled) {
      // Their lord fell or was taken: the army loses heart and most of it goes home.
      c.gold += RANSOM;
      lead.regiments = lead.regiments.filter((_, i) => i % 2 === 0);
      note(c, `${lead.lord} has been taken! The army breaks up, and the ransom brings us ${RANSOM} gold.`, 'good');
    }
    for (const id of e.enemies) {
      const a = armyById(c, id);
      if (!a) continue;
      if (strength(a.regiments) < 4) { if (a.regiments.length || o.generalKilled) note(c, `${a.name} has been destroyed.`, 'good'); a.regiments = []; }
      else a.resting = true;
    }
    if (e.kind === 'assault') { t.garrison = []; capture(c, t, 0); }
    promote(c);
  } else {
    note(c, e.kind === 'assault' ? `The defenders of ${t.name} have thrown us back.` : `${lead?.name ?? 'The enemy'} has beaten us.`, 'bad');
    if (e.kind === 'holdout' || e.kind === 'relief') { t.garrison = []; capture(c, t, 1); }
    // Fall back towards home.
    const home = nearestOwn(c, 0, me);
    if (home) { me.x += (home.x - me.x) * 0.3; me.y += (home.y - me.y) * 0.3; }
    for (const id of e.enemies) { const a = armyById(c, id); if (a) a.wander = c.day + 1; }
  }
  for (const id of ourArmies) { const a = armyById(c, id); if (a && !a.regiments.length) { a.busyUntil = c.day + 6; note(c, `${a.lord}'s army has been scattered.`, 'bad'); } }
  if (!me.regiments.length) {
    me.busyUntil = c.day + 3;
    note(c, 'Your army has been destroyed. You will raise a new one at the capital in a few days.', 'bad');
  }
}

/** Fight it out without playing. In a holdout the relief always arrives in time. True if the player wins. */
export function autoResolveEncounter(c: Campaign): boolean {
  const e = c.encounter!;
  const [mine, theirs] = encounterSides(c).map((l) => structuredClone(l)) as [ArmyEntry[], ArmyEntry[]];
  if (e.relief) mine.push(...structuredClone(e.relief.regiments));
  const won = autoBattle(c, mine, theirs);
  settleEncounter(c, { won, survivors: [mine, theirs], reliefArrived: !!e.relief, generalKilled: won && e.enemies.length > 0 && roll(c) < 0.2 });
  return won;
}

/** Back away from a fight: everyone loses a little in the rearguard, and the army steps back. A holdout cannot be fled. */
export function retreat(c: Campaign) {
  const e = c.encounter!;
  const me = playerArmy(c);
  for (const r of me.regiments) r.men = Math.round(r.men * 0.9);
  const lead = e.enemies.length ? armyById(c, e.enemies[0]) : undefined;
  const from = lead ?? c.territories[e.territory];
  const d = Math.max(1, dist(me, from));
  me.x += ((me.x - from.x) / d) * 70;
  me.y += ((me.y - from.y) / d) * 70;
  me.target = null;
  c.encounter = null;
  note(c, 'We fell back without giving battle.', 'info');
}

function promote(c: Campaign) {
  while (c.rank < RANKS.length - 1 && c.wins >= RANKS[c.rank + 1].wins) {
    c.rank++;
    note(c, `You have been promoted to ${RANKS[c.rank].name}! You may now lead ${RANKS[c.rank].regiments} regiments.`, 'good');
  }
}

/** The tutorial is done: promoted to Captain, with the regiments that came through it and two more. */
export function finishTutorial(c: Campaign, survivors: ArmyEntry[]) {
  c.tutorialDone = true;
  c.rank = 1;
  const me = playerArmy(c);
  me.regiments = [...survivors.map((r) => ({ type: r.type, xp: r.xp, men: Math.max(r.men, UNIT_TYPES[r.type].men * 0.6) })), { type: 'line', men: UNIT_TYPES.line.men, xp: 0 }, { type: 'cavalry', men: UNIT_TYPES.cavalry.men, xp: 0 }];
  me.regiments = me.regiments.slice(0, RANKS[1].regiments);
  note(c, 'You have been promoted to Captain and given a small army. Ostmark will strike at our towns: ride to their defence, and take the war back over the border.', 'good');
}

/** Hear the alert: true to ride to the threatened town's defence. */
export function answerAlert(c: Campaign, ride: boolean) {
  const al = c.alert;
  if (!al) return;
  c.alert = null;
  const t = c.territories[al.territory];
  const me = playerArmy(c);
  if (ride && me.regiments.length) me.target = { x: t.x, y: t.y };
}

// ---------- recruiting ----------

/** Where the player's army stands, if that is land the player holds (recruiting and refitting happen there). */
export function friendlyGround(c: Campaign, grid: Int16Array): Territory | null {
  const t = territoryUnder(c, grid, playerArmy(c));
  return t.owner === 0 ? t : null;
}

export function recruit(c: Campaign, type: UnitTypeId): string | null {
  const cost = RECRUIT_COST[type] ?? 0;
  const me = playerArmy(c);
  if (me.regiments.length >= rankOf(c).regiments) return `A ${rankOf(c).name} may lead ${rankOf(c).regiments} regiments`;
  if (c.gold < cost) return 'Not enough gold';
  c.gold -= cost;
  me.regiments.push({ type, men: UNIT_TYPES[type].men, xp: 0 });
  return null;
}

export function refitCost(c: Campaign): number {
  return Math.ceil(playerArmy(c).regiments.reduce((s, r) => s + (UNIT_TYPES[r.type].men - r.men), 0) * REFIT_PER_MAN);
}

export function refit(c: Campaign): string | null {
  const cost = refitCost(c);
  if (!cost) return 'Every regiment is at full strength';
  if (c.gold < cost) return 'Not enough gold';
  c.gold -= cost;
  for (const r of playerArmy(c).regiments) r.men = UNIT_TYPES[r.type].men;
  return null;
}

export function dismiss(c: Campaign, index: number) {
  playerArmy(c).regiments.splice(index, 1);
}

// ---------- saves ----------

const SAVE_KEY = (slot: number) => `wargame.save.${slot}`;
export const SLOTS = 2;

export function loadCampaign(slot: number): Campaign | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY(slot));
    const c = raw ? (JSON.parse(raw) as Campaign) : null;
    return c && c.version === 2 ? c : null;
  } catch {
    return null;
  }
}

export function saveCampaign(c: Campaign): boolean {
  try {
    localStorage.setItem(SAVE_KEY(c.slot), JSON.stringify(c));
    return true;
  } catch {
    return false;
  }
}

export function deleteCampaign(slot: number) {
  try {
    localStorage.removeItem(SAVE_KEY(slot));
  } catch {
    // Storage blocked: nothing was saved.
  }
}
