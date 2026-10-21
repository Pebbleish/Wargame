import { MapData } from '../sim/map';

/** Maps made in the editor, kept in this browser. */
const MAPS_KEY = 'wargame.maps';

export function savedMaps(): MapData[] {
  try {
    const list = JSON.parse(localStorage.getItem(MAPS_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter(isMapData) : [];
  } catch {
    return [];
  }
}

/** Save a map under its name, replacing any saved map of the same name. False if storage is blocked or full. */
export function saveMap(map: MapData): boolean {
  const list = savedMaps().filter((m) => m.name !== map.name);
  list.push(map);
  list.sort((a, b) => a.name.localeCompare(b.name));
  try {
    localStorage.setItem(MAPS_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function deleteMap(name: string) {
  try {
    localStorage.setItem(MAPS_KEY, JSON.stringify(savedMaps().filter((m) => m.name !== name)));
  } catch {
    // Storage blocked: nothing was saved to delete.
  }
}

/** A map shared as text: compact JSON, so it can be pasted into a message and back. */
export function mapToCode(map: MapData): string {
  const round = (_k: string, v: unknown) => (typeof v === 'number' ? Math.round(v) : v);
  return JSON.stringify(map, round);
}

export function mapFromCode(code: string): MapData | null {
  try {
    const m = JSON.parse(code.trim());
    return isMapData(m) ? m : null;
  } catch {
    return null;
  }
}

function isMapData(m: unknown): m is MapData {
  const d = m as MapData;
  return !!d && d.version === 1 && typeof d.name === 'string' && [d.river, d.crossings, d.objectives, d.woods, d.hills, d.marshes, d.roads].every(Array.isArray);
}
