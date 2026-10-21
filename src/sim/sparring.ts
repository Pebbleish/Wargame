import { MAP, RULES } from './config';
import { AI, DOCTRINES } from './ai';
import { OBJECTIVES, Vec, clampToMap, dist } from './map';
import { Command, Side, Unit, World, isSupport } from './world';

/**
 * Sparring partners for testing the AI: scripted opponents that fight the way people tend to, rather than the way
 * the AI does. Each runs a normal AI underneath for the guns, the general, the wagons and buying, and takes over
 * the regiments its style is about.
 *  - rush: masses every infantry regiment on one flank and rolls up the towns there one by one, leaving the rest empty.
 *  - raid: buys horse and sends it round the far edge of the map after guns, wagons and the general.
 *  - turtle: digs in on what it holds and never goes over to the attack.
 *  - centre: throws everything at the centre in the first four minutes, then fights like the normal AI.
 */
export type BotKind = 'rush' | 'raid' | 'turtle' | 'centre';
export const BOTS: BotKind[] = ['rush', 'raid', 'turtle', 'centre'];

export class SparringBot {
  private inner: AI;
  private lastThink = -999;
  private flank: number; // rush: the band of the map (0 north, 1 middle, 2 south) it attacks along

  constructor(readonly side: Side, seed: number, readonly kind: BotKind, flank?: 0 | 2) {
    const h = Math.imul(seed * 2654435761 + side * 977, 2246822519) >>> 0;
    this.flank = flank ?? [0, 2][h & 1];
    const turtle = { attackRatio: 99, moraleLead: 999, comeback: 0, pressRange: 0, pounceRange: 0, counter: 0, helpers: 0 };
    const doctrine = kind === 'raid' ? { ...DOCTRINES[4], cavalry: 4 } : kind === 'turtle' ? DOCTRINES[0] : kind === 'rush' ? DOCTRINES[1] : undefined;
    // The AI underneath keeps the round 8 style (garrisons, no massed column), so the bots stay the same yardstick.
    this.inner = new AI(side, seed, { doctrine, params: { mass: 0, centralReserve: 0, ...(kind === 'turtle' ? turtle : {}) } });
  }

  update(world: World): Command[] {
    const cmds = this.inner.update(world);
    if (world.phase !== 'battle' || this.kind === 'turtle') return cmds;
    if (this.kind === 'centre' && world.time > 240) return cmds;
    if (world.time - this.lastThink < 2) return cmds;
    this.lastThink = world.time;
    const mine = world.units.filter((u) => u.side === this.side && u.state !== 'routing');
    const enemies = world.units.filter((u) => u.side !== this.side && u.seen[this.side] && u.state !== 'routing');
    const mineCmds: Command[] = [];
    const taken = new Set<number>();
    if (this.kind === 'raid') this.raid(world, mine, mineCmds, taken);
    else this.rush(world, mine, enemies, mineCmds, taken);
    return [...withoutUnits(cmds, taken), ...mineCmds];
  }

  private dir() {
    return this.side === 0 ? 1 : -1;
  }

  /** The objective the mass goes for next: the nearest not ours along its flank (rush), or the centre. */
  private target(world: World, mine: Unit[]): Vec | null {
    const foot = mine.filter((u) => u.type === 'line' || u.type === 'light');
    const at = foot.length ? { x: foot.reduce((a, u) => a + u.x, 0) / foot.length, y: foot.reduce((a, u) => a + u.y, 0) / foot.length } : { x: this.side === 0 ? 300 : MAP.width - 300, y: MAP.height / 2 };
    if (this.kind === 'centre') return OBJECTIVES.find((o) => o.centre) ?? null;
    const band = (o: Vec) => Math.min(2, Math.floor((o.y / MAP.height) * 3));
    const open = OBJECTIVES.map((o, i) => ({ o, i })).filter(({ i }) => world.owners[i] !== this.side);
    const along = open.filter(({ o }) => band(o) === this.flank || band(o) === 1);
    const pool = along.length ? along : open;
    // Roll along the flank: the nearest to our end of the field first.
    pool.sort((a, b) => (a.o.x - b.o.x) * this.dir() + (dist(a.o, at) - dist(b.o, at)) * 0.3);
    return pool[0]?.o ?? null;
  }

  private rush(world: World, mine: Unit[], enemies: Unit[], cmds: Command[], taken: Set<number>) {
    const t = this.target(world, mine);
    if (!t) return;
    const foot = mine.filter((u) => u.type === 'line' || u.type === 'light').sort((a, b) => a.id - b.id);
    foot.forEach((u, n) => {
      if (u.meleeWith !== null) { taken.add(u.id); return; }
      taken.add(u.id);
      if (u.formation === 'fortified') cmds.push({ kind: 'formation', side: this.side, ids: [u.id], formation: 'formation' });
      // Anything in the way gets attacked; otherwise on to the town.
      const foe = enemies.filter((e) => !isSupport(e) && dist(e, u) < 300).sort((a, b) => dist(a, u) - dist(b, u))[0];
      if (foe) {
        if (u.order.kind !== 'attack' || u.order.target !== foe.id) cmds.push({ kind: 'attack', side: this.side, ids: [u.id], target: foe.id });
        return;
      }
      const p = clampToMap({ x: t.x + ((n * 37) % 160) - 80, y: t.y + ((n * 53) % 200) - 100 }, RULES.borderWidth + 80);
      const current = u.order.kind === 'move' ? { x: u.order.x, y: u.order.y } : u;
      if (dist(current, p) > 120) cmds.push({ kind: 'move', side: this.side, moves: [{ id: u.id, x: p.x, y: p.y }] });
    });
  }

  private raid(world: World, mine: Unit[], cmds: Command[], taken: Set<number>) {
    const prey = world.units.filter((u) => u.side !== this.side && u.seen[this.side] && (u.type === 'artillery' || u.type === 'supply' || u.type === 'general'));
    for (const u of mine.filter((m) => m.type === 'cavalry')) {
      if (u.meleeWith !== null) { taken.add(u.id); continue; }
      taken.add(u.id);
      const home = { x: this.side === 0 ? RULES.zoneStart + 200 : MAP.width - RULES.zoneStart - 200, y: u.y };
      if (u.morale < 45 || u.fatigue > 85) {
        if (dist(u, home) > 150) cmds.push({ kind: 'move', side: this.side, moves: [{ id: u.id, x: home.x, y: home.y }] });
        continue;
      }
      const t = prey.sort((a, b) => dist(a, u) - dist(b, u))[0];
      // With nothing seen, ride round a flank deep into their half to look.
      const edge = u.y < MAP.height / 2 ? 150 : MAP.height - 150;
      const goal = t ?? { x: this.side === 0 ? MAP.width - 600 : 600, y: edge };
      if (dist(u, goal) < 500 && t) {
        if (u.order.kind !== 'attack' || u.order.target !== t.id) cmds.push({ kind: 'attack', side: this.side, ids: [u.id], target: t.id });
        continue;
      }
      // Go round: out to the near edge of the map first, level with the target, then in.
      const way = Math.abs(u.y - edge) > 250 && Math.abs(u.x - goal.x) > 600 ? { x: u.x + this.dir() * 300, y: edge } : { x: goal.x, y: Math.abs(u.x - goal.x) > 600 ? edge : goal.y };
      const current = u.order.kind === 'move' ? { x: u.order.x, y: u.order.y } : u;
      if (dist(current, way) > 120) cmds.push({ kind: 'move', side: this.side, moves: [{ id: u.id, x: way.x, y: way.y }] });
    }
  }
}

/** The same commands with the given regiments taken out of them. */
function withoutUnits(cmds: Command[], ids: Set<number>): Command[] {
  const out: Command[] = [];
  for (const c of cmds) {
    if (c.kind === 'move') {
      const moves = c.moves.filter((m) => !ids.has(m.id));
      if (moves.length) out.push({ ...c, moves });
    } else if ('ids' in c) {
      const keep = c.ids.filter((id) => !ids.has(id));
      if (keep.length) out.push({ ...c, ids: keep } as Command);
    } else out.push(c);
  }
  return out;
}
