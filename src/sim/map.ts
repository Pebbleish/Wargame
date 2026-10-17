import { MAP } from './config';

export interface Vec { x: number; y: number }

export type ObjectiveKind = 'village' | 'station' | 'bridge';

export interface ObjectiveDef {
  id: number;
  name: string;
  kind: ObjectiveKind;
  x: number;
  y: number;
}

export interface Circle { x: number; y: number; r: number }

export interface Crossing { x: number; y: number; name: string; ford: boolean }

// The first battlefield. It is point-symmetric around the centre so neither side has an advantage.
export const RIVER: Vec[] = [
  { x: 1560, y: 0 }, { x: 1590, y: 260 }, { x: 1630, y: 600 }, { x: 1600, y: 1000 },
  { x: 1570, y: 1400 }, { x: 1610, y: 1740 }, { x: 1640, y: 2000 },
];
export const RIVER_WIDTH = 34;

export const CROSSINGS: Crossing[] = [
  { x: 1590, y: 260, name: 'North ford', ford: true },
  { x: 1600, y: 1000, name: 'Mill Bridge', ford: false },
  { x: 1610, y: 1740, name: 'South ford', ford: true },
];
export const CROSSING_RADIUS = 60;

export const OBJECTIVES: ObjectiveDef[] = [
  { id: 0, name: 'Westbrook', kind: 'village', x: 1150, y: 520 },
  { id: 1, name: 'Linden Station', kind: 'station', x: 1150, y: 1480 },
  { id: 2, name: 'Mill Bridge', kind: 'bridge', x: 1600, y: 1000 },
  { id: 3, name: 'Ostrava Station', kind: 'station', x: 2050, y: 520 },
  { id: 4, name: 'Kessel', kind: 'village', x: 2050, y: 1480 },
];

export const WOODS: Circle[] = [
  { x: 1350, y: 790, r: 120 }, { x: 1850, y: 1210, r: 120 },
  { x: 880, y: 1130, r: 150 }, { x: 2320, y: 870, r: 150 },
  { x: 1820, y: 290, r: 110 }, { x: 1380, y: 1710, r: 110 },
];

export const HILLS: Circle[] = [
  { x: 1280, y: 1230, r: 210 }, { x: 1920, y: 770, r: 210 },
];

export const VILLAGE_RADIUS = 95;

export const ROADS: Vec[][] = [
  [{ x: 0, y: 520 }, { x: 1150, y: 520 }, { x: 1600, y: 1000 }, { x: 2050, y: 1480 }, { x: MAP.width, y: 1480 }],
  [{ x: 0, y: 1480 }, { x: 1150, y: 1480 }, { x: 1600, y: 1000 }, { x: 2050, y: 520 }, { x: MAP.width, y: 520 }],
  [{ x: 1150, y: 520 }, { x: 1590, y: 260 }, { x: 2050, y: 520 }],
  [{ x: 1150, y: 1480 }, { x: 1610, y: 1740 }, { x: 2050, y: 1480 }],
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
