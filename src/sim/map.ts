import { MAP } from './config';
import { Rng } from './rng';

export interface Vec { x: number; y: number }

export type ObjectiveKind = 'village' | 'depot' | 'bridge';

export interface ObjectiveDef {
  id: number;
  name: string;
  kind: ObjectiveKind;
  x: number;
  y: number;
  home?: 0 | 1; // a starting town of this side
  centre?: boolean;
}

export interface Circle { x: number; y: number; r: number }

export interface Crossing { x: number; y: number; name: string; ford: boolean; pontoon?: boolean }

export interface Earthwork extends Circle { side: 0 | 1 }

// The battlefield is laid out on a 3200 x 2000 sketch and scaled up to the real map size.
// A fresh layout is generated for every battle. It is always point-symmetric around the centre
// (whatever one side has, the other has rotated 180 degrees) so neither side has an advantage.
// The sketch was drawn for a 4800 m long field; the empty ground behind each deployment strip is trimmed off.
const S = MAP.height / 2000;
const TRIM = (3200 * S - MAP.width) / 2;
const v = (x: number, y: number): Vec => ({ x: x * S - TRIM, y: y * S });
const c = (x: number, y: number, r: number): Circle => ({ x: x * S - TRIM, y: y * S, r: r * S });
const mirror = (p: Vec): Vec => ({ x: MAP.width - p.x, y: MAP.height - p.y });

export const RIVER_WIDTH = 40;
export const CROSSING_RADIUS = 70;
export const VILLAGE_RADIUS = 110;

// These are filled in place by generateMap, so every module sees the current battlefield.
export const RIVER: Vec[] = [];
export const CROSSINGS: Crossing[] = [];
export const OBJECTIVES: ObjectiveDef[] = [];
export const WOODS: Circle[] = [];
export const HILLS: Circle[] = [];
export const ROADS: Vec[][] = [];
export const MARSHES: Circle[] = [];
// Built during the battle by engineers.
export const EARTHWORKS: Earthwork[] = [];
export const EARTHWORK_RADIUS = 90;

const VILLAGE_NAMES = ['Westbrook', 'Kessel', 'Hollin', 'Marrau', 'Dornach', 'Aschfeld', 'Felden', 'Brackwitz', 'Ulmen', 'Sorau'];
const DEPOT_NAMES = ['Linden Depot', 'Ostrava Depot', 'Gorse Depot', 'Halden Depot', 'Pellau Depot', 'Rothen Depot', 'Kreuz Depot', 'Marl Depot', 'Tessin Depot', 'Wendel Depot'];
const BRIDGE_NAMES = ['Mill Bridge', 'Stone Bridge', 'Toll Bridge', 'Abbey Bridge', 'Weir Bridge', 'Cart Bridge', 'Kings Bridge'];
const FORD_NAMES = ['Shallow Ford', 'Cattle Ford', 'Ferry Ford', 'Ash Ford'];

function pick<T>(rng: Rng, list: T[], taken: Set<T>): T {
  const free = list.filter((x) => !taken.has(x));
  const choice = free[Math.floor(rng.next() * free.length)];
  taken.add(choice);
  return choice;
}

function replace<T>(target: T[], items: T[]) {
  target.splice(0, target.length, ...items);
}

export type MapKind = 'river' | 'open';
export let mapKind: MapKind = 'river';

/** Lay out a new battlefield from a seed. The same seed always gives the same map. */
export function generateMap(seed: number) {
  const rng = new Rng(seed * 7919 + 17);
  const names = new Set<string>();
  replace(EARTHWORKS, []);
  mapKind = rng.next() < 0.25 ? 'open' : 'river';
  const centre = v(1600, 1000);

  // River: wanders from the north edge to the centre; the southern half is the mirror image.
  // It has a bridge in the middle and two more crossings on each half: a bridge near the centre, so a force held
  // at the middle bridge can go round, and an outer bridge or ford that is an objective of its own.
  let crossingsNorth: Crossing[] = [];
  if (mapKind === 'river') {
    const north = [0, 210, 420, 630, 830].map((y, i) => v(1600 + rng.range(-150, 150) * (1 - i * 0.15), i === 0 ? 0 : y + rng.range(-50, 50)));
    replace(RIVER, [...north, centre, ...north.slice().reverse().map(mirror)]);
    const outer = rng.next() < 0.5 ? 1 : 2;
    crossingsNorth = [outer, 3].map((i, k) => {
      const ford = k === 0 && rng.next() < 0.3;
      return { ...north[i], name: k === 0 ? pick(rng, ford ? FORD_NAMES : BRIDGE_NAMES, names) : 'Bridge', ford };
    });
  } else {
    replace(RIVER, []);
  }
  const centreName = mapKind === 'river' ? pick(rng, BRIDGE_NAMES, names) : pick(rng, VILLAGE_NAMES, names);
  replace(CROSSINGS, mapKind === 'river' ? [
    ...crossingsNorth,
    { ...centre, name: centreName, ford: false },
    ...crossingsNorth.map((c, k) => ({ ...c, ...mirror(c), name: k === 0 ? pick(rng, c.ford ? FORD_NAMES : BRIDGE_NAMES, names) : c.name })),
  ] : []);

  // Objectives: two on each side in mirrored spots, plus the centre (a bridge, or a village on open maps).
  // Home towns sit well back, so the armies have a march to make before they meet.
  const a = v(rng.range(650, 1000), rng.range(250, 760));
  const b = v(rng.range(650, 1000), rng.range(1240, 1750));
  const kind = (): ObjectiveKind => (rng.next() < 0.5 ? 'village' : 'depot');
  const kindA = kind();
  const kindB = rng.next() < 0.7 ? (kindA === 'village' ? 'depot' : 'village') : kindA;
  const label = (k: ObjectiveKind) => pick(rng, k === 'village' ? VILLAGE_NAMES : DEPOT_NAMES, names);
  // Some maps add one or two more towns between each side's home towns and the centre.
  const extras: Vec[] = [];
  const extraCount = [0, 1, 1, 2][Math.floor(rng.next() * 4)];
  for (let tries = 0; extras.length < extraCount && tries < 200; tries++) {
    const p = v(rng.range(1050, 1420), rng.range(250, 1750));
    const river = nearestRiverPoint(p);
    if (river && (river.d < 260 || riverSide(p) !== -1)) continue;
    if ([a, b, centre, ...crossingsNorth, ...extras].some((q) => dist(p, q) < 520) || dist(p, mirror(p)) < 900) continue;
    // Its road to the centre must reach the bridge without clipping a bend of the river first.
    const toBridge = dist(p, centre) - CROSSING_RADIUS - 10;
    const nearBridge = { x: p.x + ((centre.x - p.x) / dist(p, centre)) * toBridge, y: p.y + ((centre.y - p.y) / dist(p, centre)) * toBridge };
    if (RIVER.length && crossesRiver(p, nearBridge)) continue;
    extras.push(p);
  }
  const extraKinds = extras.map(() => (rng.next() < 0.75 ? 'village' : 'depot') as ObjectiveKind);
  const west: Omit<ObjectiveDef, 'id'>[] = [
    { name: label(kindA), kind: kindA, ...a, home: 0 },
    { name: label(kindB), kind: kindB, ...b, home: 0 },
    ...extras.map((p, i) => ({ name: label(extraKinds[i]), kind: extraKinds[i], ...p })),
  ];
  const east = west.map((o) => ({ ...o, ...mirror(o), name: label(o.kind), home: o.home === 0 ? (1 as const) : undefined }));
  // The outer crossing on each half is worth holding too, so the fighting spreads along the river.
  const sideBridge = crossingsNorth[0];
  if (sideBridge) {
    const southCrossing = CROSSINGS[CROSSINGS.length - crossingsNorth.length];
    const north = { name: sideBridge.name, kind: 'bridge' as const, x: sideBridge.x, y: sideBridge.y };
    const south = { name: southCrossing.name, kind: 'bridge' as const, x: southCrossing.x, y: southCrossing.y };
    replace(OBJECTIVES, [...west, north, { name: centreName, kind: 'bridge' as const, ...centre, centre: true }, south, ...east.reverse()].map((o, id) => ({ ...o, id })));
  } else {
    replace(OBJECTIVES, [
      ...west,
      { name: centreName, kind: mapKind === 'river' ? 'bridge' as const : 'village' as const, ...centre, centre: true },
      ...east.reverse(),
    ].map((o, id) => ({ ...o, id })));
  }

  // Roads join the objectives through the centre and run back to both map edges, with side roads
  // over the other crossings (or straight across on open maps).
  const northObj = OBJECTIVES.find((o) => o.home === 1 && o.y === MAP.height - b.y)!;
  const upper = crossingsNorth[0];
  replace(ROADS, [
    [{ x: 0, y: a.y }, a, centre, mirror(a), { x: MAP.width, y: MAP.height - a.y }],
    [{ x: 0, y: b.y }, b, centre, mirror(b), { x: MAP.width, y: MAP.height - b.y }],
    upper ? [a, upper, northObj] : [a, northObj],
    upper ? [b, mirror(upper), mirror(a)] : [b, mirror(a)],
    ...extras.flatMap((p) => {
      const home = dist(p, a) < dist(p, b) ? a : b;
      return [[home, p, centre], [mirror(home), mirror(p), centre]];
    }),
  ]);

  // Hills, woods and marshes, scattered on the west half and mirrored, clear of objectives and crossings.
  replace(HILLS, []);
  replace(WOODS, []);
  replace(MARSHES, []);
  const clear = (p: Circle) =>
    p.x > 650 * S - TRIM && p.x < 1520 * S - TRIM &&
    OBJECTIVES.every((o) => dist(p, o) > p.r + VILLAGE_RADIUS + 60) &&
    CROSSINGS.every((k) => dist(p, k) > p.r + 120) &&
    (nearestRiverPoint(p)?.d ?? Infinity) > p.r + 40 &&
    [...WOODS, ...HILLS, ...MARSHES].every((o) => dist(p, o) > p.r + o.r + 40);
  const scatter = (count: number, minR: number, maxR: number, into: Circle[]) => {
    const placed: Circle[] = [];
    for (let tries = 0; placed.length < count && tries < 300; tries++) {
      const p = c(rng.range(650, 1520), rng.range(150, 1850), rng.range(minR, maxR));
      if (!clear(p) || dist(p, mirror(p)) < p.r * 2 + 80) continue;
      placed.push(p);
      into.push(p, { ...mirror(p), r: p.r });
    }
  };
  scatter(Math.floor(rng.next() * 4), 140, 230, HILLS);
  // How wooded the map is varies from a few copses to thick forest.
  const woodland = [[0, 2], [2, 4], [3, 6], [6, 10]][Math.floor(rng.next() * 4)];
  scatter(woodland[0] + Math.floor(rng.next() * (woodland[1] - woodland[0] + 1)), 70, 150, WOODS);
  // Give each wood an irregular outline: extra lobes around its core, mirrored like the rest.
  const addLobes = (list: Circle[], min: number, max: number) => {
    const cores = list.filter((_, i) => i % 2 === 0);
    for (const core of cores) {
      const lobes = min + Math.floor(rng.next() * (max - min + 1));
      let heading = rng.range(0, Math.PI * 2);
      for (let k = 0; k < lobes; k++) {
        heading += rng.range(-1.2, 1.2);
        const r = core.r * rng.range(0.45, 0.85);
        const d = core.r * rng.range(0.6, 1.1);
        const lobe = { x: core.x + Math.cos(heading) * d, y: core.y + Math.sin(heading) * d, r };
        if (OBJECTIVES.some((o) => dist(lobe, o) < r + VILLAGE_RADIUS + 30) || CROSSINGS.some((k2) => dist(lobe, k2) < r + 90)) continue;
        if ((nearestRiverPoint(lobe)?.d ?? Infinity) < r + 40) continue;
        if (lobe.x < 600 * S - TRIM || lobe.x > MAP.width / 2 - r) continue;
        list.push(lobe, { ...mirror(lobe), r });
      }
    }
  };
  addLobes(WOODS, 2, 5);
  // Marshes vary too: none to several, each a spread of boggy lobes rather than a neat circle.
  scatter(Math.floor(rng.next() * 4), 70, 140, MARSHES);
  addLobes(MARSHES, 1, 4);
  windRoads(rng);
  bakeTerrain();
}

/**
 * Turn the straight road legs into country roads: they wander gently, bend around woods and marshes, and
 * still run through every town and crossing they join. The bends mirror across the centre like the rest of the map.
 */
function windRoads(rng: Rng) {
  const waves = [0, 1, 2, 3].map(() => ({ fx: rng.range(-1, 1), fy: rng.range(-1, 1), k: (Math.PI * 2) / rng.range(700, 1400), phase: rng.range(0, Math.PI * 2) }));
  const noise = (p: Vec, axis: number) => waves.reduce((sum, w, i) => sum + Math.sin((p.x * w.fx + p.y * w.fy) * w.k + w.phase + axis * (i + 1) * 1.7), 0) / 2;
  // Subtracting the mirrored value keeps the bends point-symmetric: the far side's roads mirror ours.
  const drift = (p: Vec): Vec => {
    const m = mirror(p);
    return { x: (noise(p, 0) - noise(m, 0)) * 80, y: (noise(p, 1) - noise(m, 1)) * 80 };
  };
  // Every town, crossing and road end, so roads that share a stretch bend the same way along it.
  const knots = ROADS.flat();
  const wind = (route: Vec[]): Vec[] => {
    const pts: Vec[] = [];
    for (let i = 0; i < route.length - 1; i++) {
      const a = route[i];
      const b = route[i + 1];
      const n = Math.max(1, Math.round(dist(a, b) / 40));
      for (let k = i === 0 ? 0 : 1; k <= n; k++) pts.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
    }
    const bent = pts.map((p) => {
      // Fixed at the towns and crossings it joins, free to wander in between.
      const near = Math.min(...knots.map((q) => dist(p, q)));
      const ease = Math.min(1, near / 300) ** 2;
      const d = drift(p);
      let q = { x: p.x + d.x * ease, y: p.y + d.y * ease };
      // Lean away from marshes; roads are happy to run through woods.
      for (const o of MARSHES) {
        const gap = dist(q, o);
        const want = o.r + 120;
        if (gap < want && gap > 0) {
          const push = (want - gap) * 0.7 * ease;
          q = { x: q.x + ((q.x - o.x) / gap) * push, y: q.y + ((q.y - o.y) / gap) * push };
        }
      }
      // Never wander over (or right up to) the river away from a crossing.
      return RIVER.length && (riverSide(q) !== riverSide(p) || nearestRiverPoint(q)!.d < 80) ? p : q;
    });
    // Round off the corners.
    let line = bent;
    for (let it = 0; it < 2; it++) {
      const next = [line[0]];
      for (let i = 0; i < line.length - 1; i++) {
        const a = line[i];
        const b = line[i + 1];
        next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 }, { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
      }
      next.push(line[line.length - 1]);
      line = next;
    }
    return line;
  };
  replace(ROADS, ROADS.map(wind));
}

export function addEarthwork(side: 0 | 1, p: Vec) {
  EARTHWORKS.push({ x: p.x, y: p.y, r: EARTHWORK_RADIUS, side });
}

/** The closest point on the river to p, or null on maps without one. */
export function nearestRiverPoint(p: Vec): { point: Vec; d: number } | null {
  let best: { point: Vec; d: number } | null = null;
  for (let i = 0; i < RIVER.length - 1; i++) {
    const a = RIVER[i];
    const b = RIVER[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    const d = dist(p, q);
    if (!best || d < best.d) best = { point: q, d };
  }
  return best;
}

export function addPontoon(p: Vec) {
  CROSSINGS.push({ x: p.x, y: p.y, name: 'Pontoon bridge', ford: false, pontoon: true });
}


const ROAD_HALF_WIDTH = 25;

// The fixed terrain is baked onto a fine grid when the map is made, so a terrain lookup is a single read.
// Earthworks are dug during the battle and are still checked directly.
const CELL = 10;
const COLS = Math.ceil(MAP.width / CELL);
const ROWS = Math.ceil(MAP.height / CELL);
const GRID = new Uint8Array(COLS * ROWS);
const WOODS_BIT = 1, HILL_BIT = 2, MARSH_BIT = 4, VILLAGE_BIT = 8, ROAD_BIT = 16, FORD_BIT = 32;

function bakeTerrain() {
  GRID.fill(0);
  // Mark every cell whose centre passes the test, within the box the shape covers.
  const mark = (bit: number, x0: number, y0: number, x1: number, y1: number, inside: (q: Vec) => boolean) => {
    for (let gx = Math.max(0, Math.floor(x0 / CELL)); gx <= Math.min(COLS - 1, Math.floor(x1 / CELL)); gx++) {
      for (let gy = Math.max(0, Math.floor(y0 / CELL)); gy <= Math.min(ROWS - 1, Math.floor(y1 / CELL)); gy++) {
        if (inside({ x: (gx + 0.5) * CELL, y: (gy + 0.5) * CELL })) GRID[gy * COLS + gx] |= bit;
      }
    }
  };
  const circle = (bit: number, c: Vec, r: number) => mark(bit, c.x - r, c.y - r, c.x + r, c.y + r, (q) => dist(q, c) <= r);
  for (const c of WOODS) circle(WOODS_BIT, c, c.r);
  for (const c of HILLS) circle(HILL_BIT, c, c.r);
  for (const c of MARSHES) circle(MARSH_BIT, c, c.r);
  for (const o of OBJECTIVES) if (o.kind !== 'bridge') circle(VILLAGE_BIT, o, VILLAGE_RADIUS);
  for (const c of CROSSINGS) if (c.ford) circle(FORD_BIT, c, CROSSING_RADIUS);
  for (const r of ROADS) for (let i = 0; i < r.length - 1; i++) {
    const p = r[i];
    const q = r[i + 1];
    mark(ROAD_BIT, Math.min(p.x, q.x) - ROAD_HALF_WIDTH, Math.min(p.y, q.y) - ROAD_HALF_WIDTH,
      Math.max(p.x, q.x) + ROAD_HALF_WIDTH, Math.max(p.y, q.y) + ROAD_HALF_WIDTH, (c) => distToSegment(c, p, q) <= ROAD_HALF_WIDTH);
  }
}

function cellAt(p: Vec): number {
  const gx = Math.floor(p.x / CELL);
  const gy = Math.floor(p.y / CELL);
  return gx >= 0 && gy >= 0 && gx < COLS && gy < ROWS ? GRID[gy * COLS + gx] : 0;
}

export function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distToSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function inCircles(p: Vec, circles: Circle[]): boolean {
  return circles.some((c) => dist(p, c) <= c.r);
}

export function nearCrossing(p: Vec): Crossing | undefined {
  return CROSSINGS.find((c) => dist(p, c) <= CROSSING_RADIUS);
}

export interface Terrain {
  cover: number; // multiplier on casualties taken (lower is better cover)
  speed: number; // multiplier on movement
  road: boolean;
  hill: boolean;
  woods: boolean;
  village: boolean;
  marsh: boolean;
  works: boolean;
}

// One shared, read-only Terrain object per combination, so lookups allocate nothing.
const TERRAIN_CACHE = new Map<number, Terrain>();

export function terrainAt(p: Vec): Terrain {
  const key = cellAt(p) | (EARTHWORKS.length && inCircles(p, EARTHWORKS) ? 64 : 0);
  let t = TERRAIN_CACHE.get(key);
  if (!t) TERRAIN_CACHE.set(key, (t = Object.freeze(terrainFor(key))));
  return t;
}

function terrainFor(key: number): Terrain {
  const woods = (key & WOODS_BIT) !== 0;
  const hill = (key & HILL_BIT) !== 0;
  const village = (key & VILLAGE_BIT) !== 0;
  const road = (key & ROAD_BIT) !== 0;
  const marsh = (key & MARSH_BIT) !== 0;
  const works = (key & 64) !== 0;
  const ford = (key & FORD_BIT) !== 0;
  let cover = 1;
  let speed = 1;
  if (woods) { cover = 0.5; speed = 0.6; }
  if (village) { cover = 0.5; speed = Math.min(speed, 0.8); }
  if (hill) { cover = Math.min(cover, 0.8); speed *= 0.85; }
  if (marsh) speed *= 0.5;
  if (works) cover = Math.min(cover, 0.5);
  if (road) speed = Math.max(speed, 1.35);
  if (ford) speed = 0.5;
  return { cover, speed, road, hill, woods, village, marsh, works };
}

function segmentsIntersect(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const cross = (o: Vec, p: Vec, q: Vec) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  // Passing exactly through a bend point of the river still counts as crossing it.
  return d1 * d2 < 0 && d3 * d4 <= 0;
}

/** Which bank of the river a point is on: -1 west, +1 east. */
export function riverSide(p: Vec): number {
  for (let i = 0; i < RIVER.length - 1; i++) {
    const a = RIVER[i];
    const b = RIVER[i + 1];
    if (p.y >= a.y && p.y <= b.y) {
      const t = (p.y - a.y) / (b.y - a.y || 1);
      return p.x < a.x + t * (b.x - a.x) ? -1 : 1;
    }
  }
  return p.x < MAP.width / 2 ? -1 : 1;
}

export function crossesRiver(a: Vec, b: Vec): boolean {
  for (let i = 0; i < RIVER.length - 1; i++) {
    if (segmentsIntersect(a, b, RIVER[i], RIVER[i + 1])) return true;
  }
  return false;
}

/** The direction straight across the river at p (unit vector), from the nearest stretch of it. */
function acrossRiver(p: Vec): Vec {
  let best = { x: 1, y: 0 };
  let bestD = Infinity;
  for (let i = 0; i < RIVER.length - 1; i++) {
    const a = RIVER[i];
    const b = RIVER[i + 1];
    const d = distToSegment(p, a, b);
    if (d < bestD) {
      bestD = d;
      const len = dist(a, b) || 1;
      best = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
    }
  }
  return best;
}

/**
 * Waypoints from a to b. If the river is in the way, the shortest route over a crossing, walking round
 * any bends on the way: a small graph of the crossings (a landing on each bank) and points along both banks.
 * crossingCost adds a detour cost to a crossing (crowded, or held by the enemy) in metres.
 */
export function planRoute(a: Vec, b: Vec, crossingCost?: (c: Crossing) => number): Vec[] {
  if (nearCrossing(a) || !crossesRiver(a, b)) return [b];
  const nodes: Vec[] = [a, b];
  const links: [number, number, number][] = []; // free hops over a crossing, with their extra cost
  for (const c of CROSSINGS) {
    const n = acrossRiver(c);
    const off = CROSSING_RADIUS - 15;
    nodes.push({ x: c.x + n.x * off, y: c.y + n.y * off }, { x: c.x - n.x * off, y: c.y - n.y * off });
    links.push([nodes.length - 2, nodes.length - 1, (c.ford ? 150 : 0) + (crossingCost?.(c) ?? 0)]);
  }
  for (let i = 1; i < RIVER.length - 1; i++) {
    const n = acrossRiver(RIVER[i]);
    const off = RIVER_WIDTH / 2 + 60;
    for (const sgn of [1, -1]) nodes.push(clampToMap({ x: RIVER[i].x + n.x * off * sgn, y: RIVER[i].y + n.y * off * sgn }, 10));
  }
  // Dijkstra from a; any two nodes connect if the straight walk between them stays on one bank.
  const cost = nodes.map(() => Infinity);
  const prev = nodes.map(() => -1);
  const done = nodes.map(() => false);
  cost[0] = 0;
  for (;;) {
    let i = -1;
    for (let k = 0; k < nodes.length; k++) if (!done[k] && cost[k] < Infinity && (i === -1 || cost[k] < cost[i])) i = k;
    if (i === -1 || i === 1) break;
    done[i] = true;
    for (let j = 0; j < nodes.length; j++) {
      if (done[j]) continue;
      const hop = links.find(([p, q]) => (p === i && q === j) || (p === j && q === i));
      if (!hop && crossesRiver(nodes[i], nodes[j])) continue;
      const c = cost[i] + dist(nodes[i], nodes[j]) + (hop ? hop[2] : 0);
      if (c < cost[j]) { cost[j] = c; prev[j] = i; }
    }
  }
  if (prev[1] === -1) return [b];
  const path: Vec[] = [];
  for (let k = 1; k !== 0; k = prev[k]) path.unshift(nodes[k]);
  return path.map((p) => ({ x: p.x, y: p.y }));
}

export function clampToMap(p: Vec, margin = 80): Vec {
  return {
    x: Math.max(margin, Math.min(MAP.width - margin, p.x)),
    y: Math.max(margin, Math.min(MAP.height - margin, p.y)),
  };
}

generateMap(1);
