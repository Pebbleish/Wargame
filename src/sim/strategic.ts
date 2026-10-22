import { UNIT_TYPES, UnitTypeId } from './config';
import { mapFor } from './fairmaps';
import { Rng } from './rng';
import { ArmyEntry } from './world';

/**
 * The campaign map: a country split into territories, Risk-style, that Valdmark (the player, 0), Ostmark (1) and
 * neutral lords (2) hold. Armies move freely across it, Bannerlord-style. Walking into a territory you do not hold
 * means fighting its garrison; meeting an enemy army means a battle. Territories pay gold each day, gold recruits
 * and refits regiments, and victories bring promotion and a bigger army. Taking Ostmark's capital wins the war.
 *
 * Everything here is plain data and pure functions, so a campaign saves as JSON and can be tested without a screen.
 */

export const WORLD = { width: 1600, height: 1000 };
const CELL = 5;
const COLS = WORLD.width / CELL;
const ROWS = WORLD.height / CELL;

export type Owner = 0 | 1 | 2;
export const OWNER_NAMES = ['Valdmark', 'Ostmark', 'Neutral'];

export interface Territory {
  id: number;
  name: string;
  x: number; // its town
  y: number;
  owner: Owner;
  capital: boolean;
  income: number; // gold a day
  garrison: ArmyEntry[];
  mapSeed: number; // the battlefield fought on here
  neighbours: number[];
}

export interface Army {
  id: number;
  side: 0 | 1;
  name: string;
  x: number;
  y: number;
  target: { x: number; y: number } | null;
  regiments: ArmyEntry[];
  home?: number; // enemy armies: the territory they go back to when spent
  busyUntil?: number; // enemy armies: besieging until this day
}

/** A battle the player has to settle: where, against whom. */
export interface Encounter {
  territory: number;
  enemyArmy: number | null; // null: the territory's garrison
  attacking: boolean; // the player marched in (true) or was caught (false)
}

export interface Campaign {
  version: 1;
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
  log: { day: number; text: string; tone: 'good' | 'bad' | 'info' }[];
  encounter: Encounter | null;
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
const CONTACT = 28; // armies this close meet
const ARRIVE = 24; // an army this close to its target has arrived

const NAMES = ['Aldenburg', 'Brenna', 'Corvin', 'Dravo', 'Eschen', 'Falkmar', 'Grauwitz', 'Holtz', 'Isenau', 'Jarow', 'Kaltbach', 'Lunden', 'Morvay', 'Nesse', 'Orlau', 'Pressa', 'Quentz', 'Rabenau', 'Stelling', 'Tarnow', 'Ulrichs', 'Varnholt'];

// ---------- the land ----------

/** Which territory each cell of the map belongs to (-1 for sea), worked out from the campaign seed. */
export function territoryGrid(c: Pick<Campaign, 'seed' | 'territories'>): Int16Array {
  const rng = new Rng(c.seed * 31 + 7);
  const waves = [0, 1, 2, 3, 4, 5].map(() => ({ fx: rng.range(-1, 1), fy: rng.range(-1, 1), k: (Math.PI * 2) / rng.range(120, 320), ph: rng.range(0, 6.3) }));
  const noise = (x: number, y: number, axis: number) => waves.reduce((s, w, i) => s + Math.sin((x * w.fx + y * w.fy) * w.k + w.ph + axis * (i + 1)), 0);
  const grid = new Int16Array(COLS * ROWS);
  for (let gy = 0; gy < ROWS; gy++) {
    for (let gx = 0; gx < COLS; gx++) {
      const x = (gx + 0.5) * CELL;
      const y = (gy + 0.5) * CELL;
      // The coast: a rough oval with ragged edges.
      const ex = (x - WORLD.width / 2) / (WORLD.width * 0.47);
      const ey = (y - WORLD.height / 2) / (WORLD.height * 0.45);
      const land = ex * ex + ey * ey < 1 + noise(x, y, 3) * 0.06;
      if (!land) { grid[gy * COLS + gx] = -1; continue; }
      // Borders wander: measure distance from a point nudged by the noise.
      const wx = x + noise(x, y, 0) * 14;
      const wy = y + noise(x, y, 1) * 14;
      let best = 0;
      let bd = Infinity;
      for (const t of c.territories) {
        const d = (t.x - wx) ** 2 + (t.y - wy) ** 2;
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

/** A new campaign: the west for Valdmark, the east for Ostmark, neutral lords between. */
export function newCampaign(slot: number, seed: number): Campaign {
  const rng = new Rng(seed);
  const territories: Territory[] = [];
  const cols = 6;
  const rows = 3;
  const names = NAMES.slice();
  for (let cx = 0; cx < cols; cx++) {
    for (let cy = 0; cy < rows; cy++) {
      const x = WORLD.width * (0.12 + (cx / (cols - 1)) * 0.76) + rng.range(-45, 45);
      const y = WORLD.height * (0.22 + (cy / (rows - 1)) * 0.56) + rng.range(-50, 50) + (cx % 2 ? 40 : -40);
      const name = names.splice(Math.floor(rng.next() * names.length), 1)[0];
      const owner: Owner = cx <= 1 ? 0 : cx >= 4 ? 1 : 2;
      territories.push({
        id: territories.length, name, x, y, owner, capital: false,
        income: 15 + Math.floor(rng.next() * 3) * 5, garrison: [], mapSeed: 1 + Math.floor(rng.next() * 100000), neighbours: [],
      });
    }
  }
  // Capitals: the middle territory of each end.
  const capital = (side: 0 | 1) => territories.filter((t) => t.owner === side).sort((a, b) => (side === 0 ? a.x - b.x : b.x - a.x) || Math.abs(a.y - WORLD.height / 2) - Math.abs(b.y - WORLD.height / 2))[0];
  for (const side of [0, 1] as const) {
    const t = capital(side);
    t.capital = true;
    t.income = 40;
    t.name = side === 0 ? 'Valdhaven' : 'Ostgard';
  }
  for (const t of territories) t.garrison = garrisonFor(t);
  const c: Campaign = {
    version: 1, seed, slot, day: 0, gold: 250, wins: 0, rank: 0, tutorialDone: false,
    territories, armies: [], nextArmyId: 1, enemyGold: 0, lastRaise: 0, log: [], encounter: null, over: null, rolls: 0,
  };
  // Neighbours: territories that share a border on the grid.
  const grid = territoryGrid(c);
  const pairs = new Set<string>();
  for (let gy = 0; gy < ROWS; gy++) {
    for (let gx = 0; gx < COLS; gx++) {
      const a = grid[gy * COLS + gx];
      if (a < 0) continue;
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
  const home = capital(0);
  c.armies.push({ id: c.nextArmyId++, side: 0, name: 'Your army', x: home.x + 30, y: home.y + 20, target: null, regiments: [] });
  for (const k of [0, 1]) raiseEnemyArmy(c, k === 0 ? 6 : 5);
  note(c, 'The war with Ostmark has begun. Ostmark holds the east; neutral lords hold the middle.', 'info');
  return c;
}

function garrisonFor(t: Territory): ArmyEntry[] {
  const reg = (type: UnitTypeId, xp = 10): ArmyEntry => ({ type, men: UNIT_TYPES[type].men, xp });
  if (t.capital) return [reg('line', 30), reg('line', 30), reg('line', 30), reg('artillery', 30), reg('light', 30)];
  if (t.owner === 2) return [reg('line'), reg('light')];
  if (t.owner === 1) return [reg('line', 20), reg('line', 20), reg('artillery', 20)];
  return [reg('line'), reg('light')];
}

// ---------- helpers ----------

export function playerArmy(c: Campaign): Army {
  return c.armies.find((a) => a.side === 0)!;
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

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

export function ownedBy(c: Campaign, side: Owner): Territory[] {
  return c.territories.filter((t) => t.owner === side);
}

/** The territory under a point (by nearest town if the point is at sea). */
export function territoryUnder(c: Campaign, grid: Int16Array, p: { x: number; y: number }): Territory {
  const id = territoryAt(grid, p.x, p.y);
  return id >= 0 ? c.territories[id] : c.territories.slice().sort((a, b) => dist(a, p) - dist(b, p))[0];
}

// ---------- time passing ----------

/**
 * Move the campaign on by dt days: armies march, Ostmark plans, gold comes in at each new day. Stops early, with
 * c.encounter set, when the player meets a garrison or an enemy army.
 */
export function advance(c: Campaign, grid: Int16Array, dt: number) {
  if (c.over || c.encounter) return;
  const me = playerArmy(c);
  const before = Math.floor(c.day);
  c.day += dt;
  if (Math.floor(c.day) > before) newDay(c);
  // March.
  for (const a of c.armies) {
    if (a.busyUntil !== undefined && c.day < a.busyUntil) continue;
    if (!a.target || !a.regiments.length) continue;
    const goal = a.target;
    const d = dist(a, goal);
    const step = MARCH_SPEED * dt * (a.side === 1 ? 0.85 : 1);
    const onLand = territoryAt(grid, a.x, a.y) >= 0;
    if (d <= step) { a.x = goal.x; a.y = goal.y; if (a.side === 0) a.target = null; }
    else { a.x += ((goal.x - a.x) / d) * step; a.y += ((goal.y - a.y) / d) * step; }
    // The land ends at the coast (an army camped just off it can still walk ashore).
    if (onLand && territoryAt(grid, a.x, a.y) < 0) { a.x -= ((goal.x - a.x) / Math.max(d, 1)) * step; a.y -= ((goal.y - a.y) / Math.max(d, 1)) * step; a.target = null; }
  }
  // The player meets an enemy army.
  if (me.regiments.length) {
    const foe = c.armies.find((a) => a.side === 1 && a.regiments.length && dist(a, me) < CONTACT);
    if (foe) {
      c.encounter = { territory: territoryUnder(c, grid, me).id, enemyArmy: foe.id, attacking: !!me.target && dist(me.target, foe) < dist(me.target, me) + CONTACT };
      me.target = null;
      return;
    }
    // The player reaches a town it does not hold.
    const t = territoryUnder(c, grid, me);
    if (t.owner !== 0 && dist(me, t) < ARRIVE) {
      me.target = null;
      if (t.garrison.length) { c.encounter = { territory: t.id, enemyArmy: null, attacking: true }; return; }
      capture(c, t, 0);
    }
  }
  thinkEnemy(c, grid);
}

function newDay(c: Campaign) {
  c.gold += ownedBy(c, 0).reduce((s, t) => s + t.income, 0);
  c.enemyGold += ownedBy(c, 1).reduce((s, t) => s + t.income, 0);
  const day = Math.floor(c.day);
  // Garrisons slowly fill back up, every few days.
  if (day % 5 === 0) {
    for (const t of c.territories) {
      const full = garrisonFor(t).length;
      if (t.garrison.length < full) t.garrison.push({ type: 'line', men: UNIT_TYPES.line.men, xp: 0 });
    }
  }
  // Armies resting in their own land get men back.
  for (const a of c.armies) {
    const home = a.side === 1 && c.territories.some((t) => t.owner === 1 && dist(t, a) < 60);
    if (home) for (const r of a.regiments) r.men = Math.min(UNIT_TYPES[r.type].men, r.men + UNIT_TYPES[r.type].men * 0.1);
  }
  // Ostmark raises a new army when it can afford one and has few in the field.
  const field = c.armies.filter((a) => a.side === 1 && a.regiments.length).length;
  if (c.enemyGold >= 500 && field < 2 + Math.floor(c.day / 20) && c.day - c.lastRaise > 6 && ownedBy(c, 1).some((t) => t.capital)) {
    c.enemyGold -= 500;
    raiseEnemyArmy(c, 6 + Math.min(4, Math.floor(c.day / 12)));
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

function raiseEnemyArmy(c: Campaign, size: number) {
  const cap = c.territories.find((t) => t.capital && t.owner === 1) ?? ownedBy(c, 1)[0];
  if (!cap) return;
  const types: UnitTypeId[] = ['line', 'line', 'light', 'cavalry', 'artillery', 'line', 'line', 'cavalry', 'artillery', 'line'];
  const n = c.armies.filter((a) => a.side === 1).length + 1;
  const ord = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'][Math.min(7, n - 1)];
  c.armies.push({
    id: c.nextArmyId++, side: 1, name: `Ostmark ${ord} Army`, x: cap.x - 20, y: cap.y + (n % 2 ? 25 : -25), target: null, home: cap.id,
    regiments: types.slice(0, size).map((type) => ({ type, men: UNIT_TYPES[type].men, xp: 15 })),
  });
  c.lastRaise = c.day;
  if (c.day > 0) note(c, `Ostmark has raised its ${ord} Army at ${cap.name}.`, 'bad');
}

/** Ostmark's armies: chase a weaker player army that comes near, otherwise march on the nearest town they do not hold. */
function thinkEnemy(c: Campaign, grid: Int16Array) {
  const me = playerArmy(c);
  const mine = strength(me.regiments);
  for (const a of c.armies) {
    if (a.side !== 1 || !a.regiments.length) continue;
    if (a.busyUntil !== undefined) {
      if (c.day < a.busyUntil) continue;
      a.busyUntil = undefined;
      // The siege is over: the garrison fights it out with the besiegers.
      const t = territoryUnder(c, grid, a);
      if (t.owner !== 1 && dist(a, t) < ARRIVE * 2) siegeResolve(c, a, t);
      continue;
    }
    const mineNow = strength(a.regiments);
    const full = a.regiments.reduce((s, r) => s + UNIT_TYPES[r.type].men, 0);
    const men = a.regiments.reduce((s, r) => s + r.men, 0);
    if (men < full * 0.45) {
      const home = ownedBy(c, 1).sort((p, q) => dist(p, a) - dist(q, a))[0];
      a.target = home ? { x: home.x + 20, y: home.y } : null;
      continue;
    }
    if (me.regiments.length && dist(me, a) < 220 && mineNow > mine * 1.15) { a.target = { x: me.x, y: me.y }; continue; }
    // The nearest town it does not hold that borders its own land.
    const ours = new Set(ownedBy(c, 1).map((t) => t.id));
    const goals = c.territories.filter((t) => t.owner !== 1 && t.neighbours.some((n) => ours.has(n)));
    const goal = goals.sort((p, q) => dist(p, a) * (p.owner === 0 ? 0.8 : 1) - dist(q, a) * (q.owner === 0 ? 0.8 : 1))[0];
    if (!goal) continue;
    if (dist(a, goal) < ARRIVE) {
      // Arrived: sit down before the town for a day, then storm it.
      a.busyUntil = c.day + 1;
      a.target = null;
      if (goal.owner === 0) note(c, `${a.name} is besieging ${goal.name}!`, 'bad');
    } else a.target = { x: goal.x, y: goal.y };
  }
}

function siegeResolve(c: Campaign, a: Army, t: Territory) {
  const won = autoBattle(c, a.regiments, t.garrison);
  if (won) {
    t.garrison = [];
    capture(c, t, 1);
  } else if (t.owner === 0) note(c, `${t.name} held out against ${a.name}.`, 'good');
}

export function capture(c: Campaign, t: Territory, side: 0 | 1) {
  const was = t.owner;
  t.owner = side;
  t.garrison = side === 0 ? [{ type: 'line', men: 1200, xp: 0 }] : [{ type: 'line', men: 1200, xp: 10 }];
  if (side === 0) note(c, `${t.name} is ours${t.capital ? ': Ostmark\'s capital has fallen!' : '.'}`, 'good');
  else note(c, `Ostmark has taken ${t.name}${was === 0 && t.capital ? ', our capital!' : '.'}`, 'bad');
  if (t.capital && was === 1 && side === 0) c.over = 'won';
  if (t.capital && was === 0 && side === 1) c.over = 'lost';
}

/**
 * Settle a fight without playing it: the stronger side usually wins, and the loser is broken. Both lists are
 * changed in place (casualties, the beaten side's lost regiments). True if the first side wins.
 */
export function autoBattle(c: Campaign, a: ArmyEntry[], b: ArmyEntry[]): boolean {
  const sa = strength(a);
  const sb = strength(b);
  const r = sa / Math.max(0.001, sa + sb);
  const p = r ** 2.5 / (r ** 2.5 + (1 - r) ** 2.5);
  const aWins = roll(c) < p;
  const hurt = (list: ArmyEntry[], share: number) => {
    for (const reg of list) reg.men = Math.round(reg.men * (1 - share * (0.6 + roll(c) * 0.8)));
    for (let i = list.length - 1; i >= 0; i--) if (list[i].men < UNIT_TYPES[list[i].type].men * 0.15) list.splice(i, 1);
  };
  const winnerShare = 0.35 * (aWins ? 1 - r : r);
  hurt(aWins ? a : b, winnerShare);
  hurt(aWins ? b : a, 0.6);
  for (const reg of aWins ? a : b) reg.xp = Math.min(100, reg.xp + 8);
  return aWins;
}

// ---------- the player's battles ----------

/** The two sides of the battle the player faces: the player's regiments and the enemy's. */
export function encounterSides(c: Campaign): [ArmyEntry[], ArmyEntry[]] {
  const e = c.encounter!;
  const enemy = e.enemyArmy !== null ? c.armies.find((a) => a.id === e.enemyArmy)!.regiments : c.territories[e.territory].garrison;
  return [playerArmy(c).regiments, enemy];
}

export function encounterTitle(c: Campaign): string {
  const e = c.encounter!;
  const t = c.territories[e.territory];
  if (e.enemyArmy === null) return `The garrison of ${t.name}`;
  return c.armies.find((a) => a.id === e.enemyArmy)!.name;
}

/** The battlefield for the current encounter. */
export function encounterMap(c: Campaign): number {
  return mapFor(c.territories[c.encounter!.territory].mapSeed);
}

/** Write a battle's outcome back: the survivors on each side, and what winning or losing means. */
export function settleEncounter(c: Campaign, won: boolean, survivors: [ArmyEntry[], ArmyEntry[]]) {
  const e = c.encounter!;
  const me = playerArmy(c);
  const t = c.territories[e.territory];
  const foe = e.enemyArmy !== null ? c.armies.find((a) => a.id === e.enemyArmy)! : null;
  me.regiments = survivors[0];
  if (foe) foe.regiments = survivors[1];
  else t.garrison = survivors[1];
  c.encounter = null;
  if (won) {
    c.wins++;
    note(c, `Victory over ${foe ? foe.name : `the garrison of ${t.name}`}!`, 'good');
    if (foe) {
      // A beaten army falls back to its own land to recover, or melts away if little is left.
      if (strength(foe.regiments) < 4) { foe.regiments = []; note(c, `${foe.name} has been destroyed.`, 'good'); }
      else {
        const home = ownedBy(c, 1).sort((p, q) => dist(p, foe) - dist(q, foe))[0];
        foe.target = home ? { x: home.x + 20, y: home.y } : null;
      }
    } else {
      t.garrison = [];
      capture(c, t, 0);
    }
    promote(c);
  } else {
    note(c, foe ? `${foe.name} has beaten us.` : `The garrison of ${t.name} has thrown us back.`, 'bad');
    // Fall back towards home.
    const home = ownedBy(c, 0).sort((p, q) => dist(p, me) - dist(q, me))[0];
    if (home) { me.x += (home.x - me.x) * 0.25; me.y += (home.y - me.y) * 0.25; }
  }
  if (!me.regiments.length) {
    me.busyUntil = c.day + 3;
    note(c, 'Your army has been destroyed. You will raise a new one at the capital in a few days.', 'bad');
  }
}

/** Fight it out without playing: true if the player wins. */
export function autoResolveEncounter(c: Campaign): boolean {
  const [mine, theirs] = encounterSides(c).map((l) => structuredClone(l)) as [ArmyEntry[], ArmyEntry[]];
  const won = autoBattle(c, mine, theirs);
  settleEncounter(c, won, [mine, theirs]);
  return won;
}

/** Back away from a fight: everyone loses a little in the rearguard, and the army steps back. */
export function retreat(c: Campaign) {
  const e = c.encounter!;
  const me = playerArmy(c);
  for (const r of me.regiments) r.men = Math.round(r.men * 0.9);
  const from = e.enemyArmy !== null ? c.armies.find((a) => a.id === e.enemyArmy)! : c.territories[e.territory];
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
  me.regiments = [...survivors.map((r) => ({ ...r, men: Math.max(r.men, UNIT_TYPES[r.type].men * 0.6) })), { type: 'line', men: UNIT_TYPES.line.men, xp: 0 }, { type: 'cavalry', men: UNIT_TYPES.cavalry.men, xp: 0 }];
  me.regiments = me.regiments.slice(0, RANKS[1].regiments);
  note(c, 'You have been promoted to Captain and given command of a small army. Take the war to Ostmark.', 'good');
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
    return c && c.version === 1 ? c : null;
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
