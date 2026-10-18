import { describe, expect, it } from 'vitest';
import { MAP, RULES, UNIT_TYPES } from '../src/sim/config';
import { EARTHWORKS, OBJECTIVES, RIVER, generateMap, terrainAt } from '../src/sim/map';
import { AI } from '../src/sim/ai';
import { World } from '../src/sim/world';

function playOut(seed: number) {
  const world = new World(seed);
  const ais = [new AI(0), new AI(1)];
  let ticks = 0;
  while (world.phase !== 'ended' && ticks < 40 * 60 * RULES.tickRate) {
    for (const ai of ais) for (const c of ai.update(world)) world.apply(c);
    world.step();
    ticks++;
  }
  return world;
}

describe('battle simulation', () => {
  it('always ends by the 30 minute cap', () => {
    for (const seed of [1, 2, 3]) {
      const w = playOut(seed);
      expect(w.phase).toBe('ended');
      expect(w.time).toBeLessThanOrEqual(RULES.matchLength + 0.2);
      expect(w.units.every((u) => Number.isFinite(u.x) && Number.isFinite(u.men))).toBe(true);
    }
  });

  it('is deterministic for the same seed', () => {
    const a = playOut(7);
    const b = playOut(7);
    expect(a.time).toBe(b.time);
    expect(a.sides[0].score).toBe(b.sides[0].score);
    expect(a.units.map((u) => [u.x, u.y, u.men])).toEqual(b.units.map((u) => [u.x, u.y, u.men]));
  });

  it('never exceeds the field cap', () => {
    const w = playOut(3);
    for (const side of [0, 1] as const) expect(w.fieldCount(side)).toBeLessThanOrEqual(RULES.fieldCap);
  });

  it('keeps every unit inside the border', () => {
    const w = playOut(5);
    for (const u of w.units) {
      expect(u.x).toBeGreaterThanOrEqual(RULES.borderWidth);
      expect(u.x).toBeLessThanOrEqual(MAP.width - RULES.borderWidth);
      expect(u.y).toBeGreaterThanOrEqual(RULES.borderWidth);
      expect(u.y).toBeLessThanOrEqual(MAP.height - RULES.borderWidth);
    }
  });

  it('ends the battle when a side resigns', () => {
    const w = new World(1);
    w.apply({ kind: 'resign', side: 0 });
    expect(w.phase).toBe('ended');
    expect(w.result?.winner).toBe(1);
  });

  it('moves artillery into range when the target is too far', () => {
    const w = new World(1);
    w.apply({ kind: 'ready', side: 0 });
    w.apply({ kind: 'ready', side: 1 });
    const gun = w.units.find((u) => u.side === 0 && u.type === 'artillery')!;
    w.apply({ kind: 'bombard', side: 0, ids: [gun.id], x: gun.x + 3000, y: gun.y });
    expect(gun.order.kind).toBe('move');
    for (let i = 0; i < 4000 && gun.formation !== 'fortified'; i++) w.step();
    expect(gun.formation).toBe('fortified');
    expect(Math.hypot(gun.fireZone!.x - gun.x, gun.fireZone!.y - gun.y)).toBeLessThanOrEqual(UNIT_TYPES.artillery.range);
  });

  it('lets engineers build earthworks', () => {
    const w = new World(1);
    w.apply({ kind: 'ready', side: 0 });
    w.apply({ kind: 'ready', side: 1 });
    const eng = w.spawn(0, 'engineers', 400, 1500);
    w.apply({ kind: 'build', side: 0, ids: [eng.id] });
    for (let i = 0; i < (RULES.buildTime + 1) * RULES.tickRate; i++) w.step();
    expect(EARTHWORKS.length).toBe(1);
    expect(terrainAt(eng).cover).toBeLessThan(1);
  });

  it('generates point-symmetric maps, some without a river', () => {
    let open = 0;
    for (let seed = 1; seed <= 20; seed++) {
      generateMap(seed);
      if (RIVER.length === 0) open++;
      for (const o of OBJECTIVES) {
        const twin = OBJECTIVES.find((p) => Math.abs(p.x - (MAP.width - o.x)) < 1e-6 && Math.abs(p.y - (MAP.height - o.y)) < 1e-6);
        expect(twin).toBeDefined();
      }
    }
    expect(open).toBeGreaterThan(0);
  });
});
