import { MAP, RULES, UNIT_TYPES, UnitTypeId } from './config';
import { OBJECTIVES, Vec, dist } from './map';
import { Command, Side, Unit, World } from './world';

/**
 * A simple layered AI: it decides which objectives each regiment should go for,
 * then gives orders through the same commands a human player uses.
 */
export class AI {
  private lastThink = -999;
  private calls = 0;
  private slots = new Map<number, number>();

  constructor(private side: Side) {}

  update(world: World): Command[] {
    if (world.phase === 'deploy') return this.deploy(world);
    if (world.phase !== 'battle' || world.time - this.lastThink < 2) return [];
    this.lastThink = world.time;
    return [...this.orders(world), ...this.reinforce(world)];
  }

  private homeX(offset: number): number {
    return this.side === 0 ? offset : MAP.width - offset;
  }

  private deploy(world: World): Command[] {
    if (world.sides[this.side].ready) return [];
    const buys: [UnitTypeId, number][] = [['line', 800], ['line', 1200], ['artillery', 1000]];
    const cmds: Command[] = buys.map(([type, y]) => ({
      kind: 'callIn', side: this.side, type, x: this.homeX(type === 'artillery' ? 200 : 320), y: this.side === 0 ? y : MAP.height - y,
    }));
    cmds.push({ kind: 'ready', side: this.side });
    return cmds;
  }

  /** Objectives in order of how much this side wants them, with how many regiments each needs. */
  private needs(world: World): { pos: Vec; need: number }[] {
    return OBJECTIVES.map((o, i) => {
      const enemyNear = world.units.filter((u) => u.side !== this.side && u.seen[this.side] && u.state !== 'routing' && dist(u, o) < 600).length;
      const owned = world.owners[i] === this.side;
      let need = o.kind === 'bridge' ? 3 : 2;
      if (owned && enemyNear === 0) need = 1;
      need += Math.min(2, enemyNear);
      return { pos: { x: o.x, y: o.y }, need };
    });
  }

  private orders(world: World): Command[] {
    const cmds: Command[] = [];
    const mine = world.units.filter((u) => u.side === this.side && u.state !== 'routing');
    const visibleEnemies = world.units.filter((u) => u.side !== this.side && u.seen[this.side]);
    const needs = this.needs(world);

    // Greedy assignment: each regiment takes the nearest objective that still needs troops.
    const assigned = new Map<number, Vec>();
    const infantry = mine.filter((u) => u.type === 'line' || u.type === 'light' || u.type === 'engineers');
    for (const u of infantry.sort((a, b) => a.id - b.id)) {
      let best = -1;
      let bestScore = Infinity;
      needs.forEach((n, i) => {
        if (n.need <= 0) return;
        const score = dist(u, n.pos) - n.need * 150;
        if (score < bestScore) { bestScore = score; best = i; }
      });
      if (best === -1) best = 2;
      needs[best].need -= 1;
      assigned.set(u.id, needs[best].pos);
    }

    for (const u of mine) {
      if (u.meleeWith !== null) continue;
      const nearest = this.nearest(u, visibleEnemies);
      const nd = nearest ? dist(u, nearest) : Infinity;

      if (u.type === 'cavalry') {
        const prey = visibleEnemies
          .filter((e) => dist(u, e) < 800 && e.formation !== 'square' && (e.state !== 'ok' || e.type === 'artillery' || e.type === 'light'))
          .sort((a, b) => dist(u, a) - dist(u, b))[0];
        if (prey) {
          if (u.order.kind !== 'attack' || u.order.target !== prey.id) cmds.push({ kind: 'attack', side: this.side, ids: [u.id], target: prey.id });
        } else {
          const anchor = this.frontAnchor(mine);
          this.moveIfFar(cmds, u, { x: anchor.x - this.dir() * 250, y: anchor.y + this.dir() * (this.slot(u.id) % 2 ? 300 : -300) });
        }
        continue;
      }

      if (u.type === 'artillery') {
        const anchor = this.frontAnchor(mine);
        this.moveIfFar(cmds, u, { x: anchor.x - this.dir() * 350, y: anchor.y }, 120);
        continue;
      }

      const goal = assigned.get(u.id)!;
      const enemyWeak = nearest && nd < 380 && (nearest.state !== 'ok' || (u.morale > 65 && nearest.morale < u.morale - 20));
      if (u.type === 'line' && enemyWeak && nearest) {
        if (u.formation !== 'line') cmds.push({ kind: 'formation', side: this.side, ids: [u.id], formation: 'line' });
        if (u.order.kind !== 'attack') cmds.push({ kind: 'attack', side: this.side, ids: [u.id], target: nearest.id });
        continue;
      }
      if (u.type === 'line') {
        const cavThreat = visibleEnemies.some((e) => e.type === 'cavalry' && e.state === 'ok' && dist(e, u) < 250);
        const wanted = cavThreat ? 'square' : nd > 700 && dist(u, goal) > 600 ? 'column' : 'line';
        if (u.formation !== wanted) cmds.push({ kind: 'formation', side: this.side, ids: [u.id], formation: wanted });
      }
      if (u.type === 'light' && u.formation !== 'skirmish' && nd < 900) {
        cmds.push({ kind: 'formation', side: this.side, ids: [u.id], formation: 'skirmish' });
      }
      // Spread regiments around the objective, mirrored so both sides behave the same way.
      const n = this.slot(u.id);
      const spot = { x: goal.x + this.dir() * (((n * 37) % 160) - 120), y: goal.y + this.dir() * (((n * 53) % 200) - 100) };
      if (nd < UNIT_TYPES[u.type].range * 0.9 && u.order.kind === 'hold') continue; // in a firefight, stand
      this.moveIfFar(cmds, u, spot, 90);
    }
    return cmds;
  }

  private reinforce(world: World): Command[] {
    const s = world.sides[this.side];
    const count = (t: UnitTypeId) => world.units.filter((u) => u.side === this.side && u.type === t).length;
    let wanted: UnitTypeId = 'line';
    if (this.calls % 4 === 3) wanted = 'artillery';
    else if (count('cavalry') < 2) wanted = 'cavalry';
    else if (this.calls % 5 === 1) wanted = 'light';
    if (world.callInBlocker(this.side, wanted) || s.manpower < UNIT_TYPES[wanted].cost) return [];
    const needs = this.needs(world).sort((a, b) => b.need - a.need);
    this.calls += 1;
    const y = Math.max(100, Math.min(MAP.height - 100, needs[0].pos.y));
    return [{ kind: 'callIn', side: this.side, type: wanted, x: this.homeX(RULES.zoneDepth - 120), y }];
  }

  /** A per-side running number for each regiment, so both AIs spread out identically. */
  private slot(id: number): number {
    if (!this.slots.has(id)) this.slots.set(id, this.slots.size + 1);
    return this.slots.get(id)!;
  }

  private dir(): number {
    return this.side === 0 ? 1 : -1;
  }

  private nearest(u: Unit, others: Unit[]): Unit | undefined {
    let best: Unit | undefined;
    let bd = Infinity;
    for (const o of others) {
      const d = dist(u, o);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  /** Average position of the infantry, used to place guns and horse behind the line. */
  private frontAnchor(mine: Unit[]): Vec {
    const inf = mine.filter((u) => u.type === 'line');
    if (inf.length === 0) return { x: this.homeX(400), y: MAP.height / 2 };
    const x = inf.reduce((a, u) => a + u.x, 0) / inf.length;
    const y = inf.reduce((a, u) => a + u.y, 0) / inf.length;
    return { x, y };
  }

  private moveIfFar(cmds: Command[], u: Unit, p: Vec, slack = 150) {
    const current = u.order.kind === 'move' ? { x: u.order.x, y: u.order.y } : u;
    if (dist(current, p) <= slack) return;
    cmds.push({ kind: 'move', side: this.side, moves: [{ id: u.id, x: p.x, y: p.y }] });
  }
}
