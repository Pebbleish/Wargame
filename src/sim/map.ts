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
const DEPOT_NAMES = ['Linden Depot', 'Ostrava Depot', 'Gorse Depot', 'Halden Depot', 'Pellau Depot', 'Rothen Depot'];
const BRIDGE_NAMES = ['Mill Bridge', 'Stone Bridge', 'Toll Bridge', 'Abbey Bridge'];

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
  // It has a bridge in the middle and one or two more bridges or fords on each half.
  let crossingsNorth: Crossing[] = [];
  if (mapKind === 'river') {
    const north = [0, 210, 420, 630, 830].map((y, i) => v(1600 + rng.range(-150, 150) * (1 - i * 0.15), i === 0 ? 0 : y + rng.range(-50, 50)));
    replace(RIVER, [...north, centre, ...north.slice().reverse().map(mirror)]);
    const spots = [1, 2, 3].sort(() => rng.next() - 0.5).slice(0, 1 + Math.floor(rng.next() * 2)).sort();
    crossingsNorth = spots.map((i, k) => {
      const ford = rng.next() < 0.6;
      return { ...north[i], name: `${ford ? 'Ford' : 'Bridge'} ${k + 1}`, ford };
    });
  } else {
    replace(RIVER, []);
  }
  const centreName = mapKind === 'river' ? pick(rng, BRIDGE_NAMES, names) : pick(rng, VILLAGE_NAMES, names);
  replace(CROSSINGS, mapKind === 'river' ? [
    ...crossingsNorth,
    { ...centre, name: centreName, ford: false },
    ...crossingsNorth.map((c) => ({ ...c, ...mirror(c) })),
  ] : []);

  // Objectives: two on each side in mirrored spots, plus the centre (a bridge, or a village on open maps).
  const a = v(rng.range(850, 1300), rng.range(250, 760));
  const b = v(rng.range(850, 1300), rng.range(1240, 1750));
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
    if ([a, b, centre, ...extras].some((q) => dist(p, q) < 520) || dist(p, mirror(p)) < 900) continue;
    extras.push(p);
  }
  const extraKinds = extras.map(() => (rng.next() < 0.75 ? 'village' : 'depot') as ObjectiveKind);
  const west: Omit<ObjectiveDef, 'id'>[] = [
    { name: label(kindA), kind: kindA, ...a, home: 0 },
    { name: label(kindB), kind: kindB, ...b, home: 0 },
    ...extras.map((p, i) => ({ name: label(extraKinds[i]), kind: extraKinds[i], ...p })),
  ];
  const east = west.map((o) => ({ ...o, ...mirror(o), name: label(o.kind), home: o.home === 0 ? (1 as const) : undefined }));
  replace(OBJECTIVES, [
    ...west,
    { name: centreName, kind: mapKind === 'river' ? 'bridge' as const : 'village' as const, ...centre, centre: true },
    ...east.reverse(),
  ].map((o, id) => ({ ...o, id })));

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
  // Give each wood an irregular outline: extra lobes of trees around its core, mirrored like the rest.
  const cores = WOODS.filter((_, i) => i % 2 === 0);
  for (const core of cores) {
    const lobes = 2 + Math.floor(rng.next() * 4);
    let heading = rng.range(0, Math.PI * 2);
    for (let k = 0; k < lobes; k++) {
      heading += rng.range(-1.2, 1.2);
      const r = core.r * rng.range(0.45, 0.85);
      const d = core.r * rng.range(0.6, 1.1);
      const lobe = { x: core.x + Math.cos(heading) * d, y: core.y + Math.sin(heading) * d, r };
      if (OBJECTIVES.some((o) => dist(lobe, o) < r + VILLAGE_RADIUS + 30) || CROSSINGS.some((k2) => dist(lobe, k2) < r + 90)) continue;
      if (lobe.x < 600 * S - TRIM || lobe.x > MAP.width / 2 - r) continue;
      WOODS.push(lobe, { ...mirror(lobe), r });
    }
  }
  scatter(Math.floor(rng.next() * 3), 90, 150, MARSHES);
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

generateMap(1);

const ROAD_HALF_WIDTH = 25;

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

function distToPolyline(p: Vec, line: Vec[]): number {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) best = Math.min(best, distToSegment(p, line[i], line[i + 1]));
  return best;
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

export function terrainAt(p: Vec): Terrain {
  const woods = inCircles(p, WOODS);
  const hill = inCircles(p, HILLS);
  const village = OBJECTIVES.some((o) => o.kind !== 'bridge' && dist(p, o) <= VILLAGE_RADIUS);
  const road = ROADS.some((r) => distToPolyline(p, r) <= ROAD_HALF_WIDTH);
  const crossing = nearCrossing(p);
  const marsh = inCircles(p, MARSHES);
  const works = inCircles(p, EARTHWORKS);
  let cover = 1;
  let speed = 1;
  if (woods) { cover = 0.5; speed = 0.6; }
  if (village) { cover = 0.5; speed = Math.min(speed, 0.8); }
  if (hill) { cover = Math.min(cover, 0.8); speed *= 0.85; }
  if (marsh) speed *= 0.5;
  if (works) cover = Math.min(cover, 0.5);
  if (road) speed = Math.max(speed, 1.35);
  if (crossing?.ford) speed = 0.5;
  return { cover, speed, road, hill, woods, village, marsh, works };
}

function segmentsIntersect(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const cross = (o: Vec, p: Vec, q: Vec) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
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

/** Waypoints from a to b, detouring over the cheapest crossing if the river is in the way. */
export function planRoute(a: Vec, b: Vec): Vec[] {
  if (riverSide(a) === riverSide(b) || nearCrossing(a) || nearCrossing(b)) return [b];
  if (!crossesRiver(a, b)) return [b];
  let best = CROSSINGS[0];
  let bestCost = Infinity;
  for (const c of CROSSINGS) {
    const cost = dist(a, c) + dist(c, b) + (c.ford ? 150 : 0);
    if (cost < bestCost) { bestCost = cost; best = c; }
  }
  return [{ x: best.x, y: best.y }, b];
}

export function clampToMap(p: Vec, margin = 80): Vec {
  return {
    x: Math.max(margin, Math.min(MAP.width - margin, p.x)),
    y: Math.max(margin, Math.min(MAP.height - margin, p.y)),
  };
}
