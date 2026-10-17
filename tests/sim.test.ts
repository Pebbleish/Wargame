import { describe, expect, it } from 'vitest';
import { RULES } from '../src/sim/config';
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
});
