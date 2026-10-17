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
}

export interface Circle { x: number; y: number; r: number }

export interface Crossing { x: number; y: number; name: string; ford: boolean }

// The battlefield is laid out on a 3200 x 2000 sketch and scaled up to the real map size.
// A fresh layout is generated for every battle. It is always point-symmetric around the centre
// (whatever one side has, the other has rotated 180 degrees) so neither side has an advantage.
const S = MAP.width / 3200;
const v = (x: number, y: number): Vec => ({ x: x * S, y: y * S });
const c = (x: number, y: number, r: number): Circle => ({ x: x * S, y: y * S, r: r * S });
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

/** Lay out a new battlefield from a seed. The same seed always gives the same map. */
export function generateMap(seed: number) {
  const rng = new Rng(seed * 7919 + 17);

  // River: wanders from the north edge to the centre; the southern half is the mirror image.
  const north = [v(1600 + rng.range(-140, 140), 0), v(1600 + rng.range(-110, 110), rng.range(220, 320)), v(1600 + rng.range(-90, 90), rng.range(560, 680))];
  const centre = v(1600, 1000);
  replace(RIVER, [...north, centre, ...north.slice().reverse().map(mirror)]);

  // Crossings: the bridge in the middle, and a ford or second bridge to the north and south.
  const names = new Set<string>();
  const bridgeName = pick(rng, BRIDGE_NAMES, names);
  const upperFord = rng.next() < 0.75;
  const upper = rng.next() < 0.5 ? north[1] : north[2];
  replace(CROSSINGS, [
    { ...upper, name: upperFord ? 'North ford' : 'North bridge', ford: upperFord },
    { ...centre, name: bridgeName, ford: false },
    { ...mirror(upper), name: upperFord ? 'South ford' : 'South bridge', ford: upperFord },
  ]);

  // Objectives: a village and a depot on each bank, in mirrored spots, plus the bridge.
  const a = v(rng.range(900, 1250), rng.range(330, 720));
  const b = v(rng.range(900, 1250), rng.range(1280, 1670));
  const villageFirst = rng.next() < 0.5;
  const kindA: ObjectiveKind = villageFirst ? 'village' : 'depot';
  const kindB: ObjectiveKind = villageFirst ? 'depot' : 'village';
  const label = (k: ObjectiveKind) => pick(rng, k === 'village' ? VILLAGE_NAMES : DEPOT_NAMES, names);
  replace(OBJECTIVES, [
    { id: 0, name: label(kindA), kind: kindA, ...a },
    { id: 1, name: label(kindB), kind: kindB, ...b },
    { id: 2, name: bridgeName, kind: 'bridge', ...centre },
    { id: 3, name: label(kindB), kind: kindB, ...mirror(b) },
    { id: 4, name: label(kindA), kind: kindA, ...mirror(a) },
  ]);

  // Roads join the objectives through the crossings and run back to both map edges.
  const north3 = OBJECTIVES[3];
  replace(ROADS, [
    [{ x: 0, y: a.y }, a, centre, mirror(a), { x: MAP.width, y: MAP.height - a.y }],
    [{ x: 0, y: b.y }, b, centre, mirror(b), { x: MAP.width, y: MAP.height - b.y }],
    [a, upper, north3],
    [b, mirror(upper), mirror(a)],
  ]);

  // Woods and hills, scattered on the west half and mirrored, kept clear of objectives and crossings.
  const clear = (p: Circle) =>
    p.x > 450 * S && p.x < 1500 * S &&
    OBJECTIVES.every((o) => dist(p, o) > p.r + VILLAGE_RADIUS + 60) &&
    CROSSINGS.every((k) => dist(p, k) > p.r + 120) &&
    [...WOODS, ...HILLS].every((o) => dist(p, o) > p.r + o.r + 40);
  const scatter = (count: number, minR: number, maxR: number, into: Circle[]) => {
    const placed: Circle[] = [];
    for (let tries = 0; placed.length < count && tries < 200; tries++) {
      const p = c(rng.range(350, 1500), rng.range(150, 1850), rng.range(minR, maxR));
      if (!clear(p) || dist(p, mirror(p)) < p.r * 2 + 80) continue;
      placed.push(p);
      into.push(p, { ...mirror(p), r: p.r });
    }
  };
  replace(HILLS, []);
  replace(WOODS, []);
  scatter(1 + Math.floor(rng.next() * 2), 150, 220, HILLS);
  scatter(3 + Math.floor(rng.next() * 3), 80, 140, WOODS);
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
}

export function terrainAt(p: Vec): Terrain {
  const woods = inCircles(p, WOODS);
  const hill = inCircles(p, HILLS);
  const village = OBJECTIVES.some((o) => o.kind !== 'bridge' && dist(p, o) <= VILLAGE_RADIUS);
  const road = ROADS.some((r) => distToPolyline(p, r) <= ROAD_HALF_WIDTH);
  const crossing = nearCrossing(p);
  let cover = 1;
  let speed = 1;
  if (woods) { cover = 0.5; speed = 0.6; }
  if (village) { cover = 0.5; speed = Math.min(speed, 0.8); }
  if (hill) { cover = Math.min(cover, 0.8); speed *= 0.85; }
  if (road) speed = Math.max(speed, 1.35);
  if (crossing?.ford) speed = 0.5;
  return { cover, speed, road, hill, woods, village };
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
