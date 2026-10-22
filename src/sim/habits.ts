import { MAP, UNIT_TYPES } from './config';
import { OBJECTIVES, dist } from './map';
import { Side, World, formationOf } from './world';

/**
 * How a player tends to fight, each from 0 to 1, averaged over their recent battles (the latest counts most).
 * The AI reads these before a battle to pick a plan that beats them.
 */
export interface Habits {
  battles: number;
  guns: number; // share of the army, by cost, that is artillery
  cavalry: number; // share that is cavalry
  dugIn: number; // share of infantry time spent fortified
  centreRush: number; // how often they mass on the centre in the opening minutes
  raids: number; // share of cavalry time spent deep in the enemy's half
  north: number; // share of their forward infantry time spent in the northern third of the field
  south: number; // and in the southern third
}

export const NO_HABITS: Habits = { battles: 0, guns: 0, cavalry: 0, dugIn: 0, centreRush: 0, raids: 0, north: 0, south: 0 };

/** Watches one side through a battle and sums up how it fought. */
export class HabitWatcher {
  private counted = new Set<number>();
  private cost = 0;
  private gunCost = 0;
  private cavCost = 0;
  private foot = 0;
  private dug = 0;
  private horse = 0;
  private deep = 0;
  private rushed = false;
  private bands = [0, 0, 0]; // forward infantry seen in each third of the field, north to south
  private next = 0;

  constructor(readonly side: Side) {}

  /** Call every tick; it samples once a second of battle time. */
  observe(world: World) {
    if (world.phase !== 'battle' || world.time < this.next) return;
    this.next = world.time + 1;
    const centre = OBJECTIVES.find((o) => o.centre);
    let foot = 0;
    let atCentre = 0;
    for (const u of world.units) {
      if (u.side !== this.side) continue;
      if (!this.counted.has(u.id) && u.type !== 'general' && u.type !== 'supply') {
        this.counted.add(u.id);
        const c = UNIT_TYPES[u.type].cost;
        this.cost += c;
        if (u.type === 'artillery') this.gunCost += c;
        if (u.type === 'cavalry') this.cavCost += c;
      }
      if (u.state === 'routing') continue;
      if (u.type === 'line' || u.type === 'light') {
        foot++;
        this.foot++;
        if (formationOf(u) === 'fortified') this.dug++;
        if (centre && dist(u, centre) < 600) atCentre++;
        // Forward: past the first two fifths of the field from their own edge, where they are attacking.
        const forward = this.side === 0 ? u.x > MAP.width * 0.4 : u.x < MAP.width * 0.6;
        if (forward) this.bands[Math.min(2, Math.floor((u.y / MAP.height) * 3))]++;
      }
      if (u.type === 'cavalry') {
        this.horse++;
        // Deep in the enemy's half: well past the middle of the field.
        const ahead = this.side === 0 ? u.x - MAP.width / 2 : MAP.width / 2 - u.x;
        if (ahead > 500) this.deep++;
      }
    }
    // Most of the infantry on the centre within the first four minutes.
    if (world.time < 240 && atCentre >= 3 && atCentre >= foot * 0.6) this.rushed = true;
  }

  /** This battle's habits. */
  result(): Habits {
    return {
      battles: 1,
      guns: this.cost ? this.gunCost / this.cost : 0,
      cavalry: this.cost ? this.cavCost / this.cost : 0,
      dugIn: this.foot ? this.dug / this.foot : 0,
      centreRush: this.rushed ? 1 : 0,
      raids: this.horse ? this.deep / this.horse : 0,
      ...this.flanks(),
    };
  }

  private flanks() {
    const n = this.bands[0] + this.bands[1] + this.bands[2];
    return { north: n ? this.bands[0] / n : 0, south: n ? this.bands[2] / n : 0 };
  }
}

/** Fold one battle into the running record. Recent battles count most, so a change of style shows up quickly. */
export function mergeHabits(h: Habits, battle: Habits): Habits {
  const w = h.battles === 0 ? 1 : 0.4;
  const mix = (a: number, b: number) => a * (1 - w) + b * w;
  return {
    battles: h.battles + 1,
    guns: mix(h.guns, battle.guns),
    cavalry: mix(h.cavalry, battle.cavalry),
    dugIn: mix(h.dugIn, battle.dugIn),
    centreRush: mix(h.centreRush, battle.centreRush),
    raids: mix(h.raids, battle.raids),
    north: mix(h.north, battle.north),
    south: mix(h.south, battle.south),
  };
}

/** Read a saved record back, ignoring anything malformed. */
export function parseHabits(text: string | null): Habits {
  if (!text) return { ...NO_HABITS };
  try {
    const o = JSON.parse(text);
    const out = { ...NO_HABITS };
    for (const k of Object.keys(out) as (keyof Habits)[]) {
      const v = o?.[k];
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = k === 'battles' ? Math.max(0, Math.floor(v)) : Math.min(1, Math.max(0, v));
    }
    return out;
  } catch {
    return { ...NO_HABITS };
  }
}
