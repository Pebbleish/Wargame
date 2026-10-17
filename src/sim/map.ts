import { MAP } from './config';

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
// It is point-symmetric around the centre so neither side has an advantage.
const S = MAP.width / 3200;
const v = (x: number, y: number): Vec => ({ x: x * S, y: y * S });
const c = (x: number, y: number, r: number): Circle => ({ x: x * S, y: y * S, r: r * S });

export const RIVER: Vec[] = [
  v(1560, 0), v(1590, 260), v(1630, 600), v(1600, 1000), v(1570, 1400), v(1610, 1740), v(1640, 2000),
];
export const RIVER_WIDTH = 40;

export const CROSSINGS: Crossing[] = [
  { ...v(1590, 260), name: 'North ford', ford: true },
  { ...v(1600, 1000), name: 'Mill Bridge', ford: false },
  { ...v(1610, 1740), name: 'South ford', ford: true },
];
export const CROSSING_RADIUS = 70;

export const OBJECTIVES: ObjectiveDef[] = [
  { id: 0, name: 'Westbrook', kind: 'village', ...v(1150, 520) },
  { id: 1, name: 'Linden Depot', kind: 'depot', ...v(1150, 1480) },
  { id: 2, name: 'Mill Bridge', kind: 'bridge', ...v(1600, 1000) },
  { id: 3, name: 'Ostrava Depot', kind: 'depot', ...v(2050, 520) },
  { id: 4, name: 'Kessel', kind: 'village', ...v(2050, 1480) },
];

export const WOODS: Circle[] = [
  c(1350, 790, 110), c(1850, 1210, 110),
  c(880, 1130, 130), c(2320, 870, 130),
  c(1820, 290, 100), c(1380, 1710, 100),
  c(620, 380, 90), c(2580, 1620, 90),
];

export const HILLS: Circle[] = [
  c(1280, 1230, 190), c(1920, 770, 190),
];

export const VILLAGE_RADIUS = 110;

export const ROADS: Vec[][] = [
  [v(0, 520), v(1150, 520), v(1600, 1000), v(2050, 1480), v(3200, 1480)],
  [v(0, 1480), v(1150, 1480), v(1600, 1000), v(2050, 520), v(3200, 520)],
  [v(1150, 520), v(1590, 260), v(2050, 520)],
  [v(1150, 1480), v(1610, 1740), v(2050, 1480)],
];
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

export function clampToMap(p: Vec, margin = 10): Vec {
  return {
    x: Math.max(margin, Math.min(MAP.width - margin, p.x)),
    y: Math.max(margin, Math.min(MAP.height - margin, p.y)),
  };
}
