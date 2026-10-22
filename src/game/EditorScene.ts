import Phaser from 'phaser';
import { MAP, RULES } from '../sim/config';
import { generateMap } from '../sim/map';
import {
  Circle, Crossing, MapData, ObjectiveDef, ObjectiveKind, VILLAGE_RADIUS, CROSSING_RADIUS, Vec, currentMap, dist, loadMap, mapProblems,
} from '../sim/map';
import { deleteMap, mapFromCode, mapToCode, saveMap, savedMaps } from './maps';
import { paintTerrain } from './terrain';

// The same view as a battle: your side of the map at the bottom.
const VIEW_ROTATION = -Math.PI / 2;
const COS = Math.cos(VIEW_ROTATION);
const SIN = Math.sin(VIEW_ROTATION);
const screenToWorldDir = (x: number, y: number): Vec => ({ x: x * COS + y * SIN, y: -x * SIN + y * COS });
const mirror = (p: Vec): Vec => ({ x: MAP.width - p.x, y: MAP.height - p.y });
const SIDE_FILL = [0x2b2e38, 0xd9a92b];

type Tool = 'select' | 'village' | 'depot' | 'woods' | 'hill' | 'marsh' | 'road' | 'river' | 'bridge' | 'ford' | 'erase';
type Area = 'woods' | 'hills' | 'marshes';

const TOOLS: { id: Tool; label: string; key: string; hint: string }[] = [
  { id: 'select', label: 'Select', key: 'V', hint: 'Click anything to select it, then drag to move it.' },
  { id: 'village', label: 'Village', key: 'T', hint: 'Click to place a village. Villages are objectives and give cover.' },
  { id: 'depot', label: 'Depot', key: 'D', hint: 'Click to place a depot: an objective that pays extra manpower and refills ammunition.' },
  { id: 'woods', label: 'Woods', key: 'W', hint: 'Click or drag to paint woods: cover, slow going, and they hide troops.' },
  { id: 'hill', label: 'Hill', key: 'H', hint: 'Click to place a hill: longer sight and range for whoever stands on it.' },
  { id: 'marsh', label: 'Marsh', key: 'M', hint: 'Click or drag to paint marsh: very slow going.' },
  { id: 'road', label: 'Road', key: 'R', hint: 'Click to lay a road point by point. Right-click or Enter to finish. Roads snap to towns and bridges.' },
  { id: 'river', label: 'River', key: 'I', hint: 'Click to lay the river from top to bottom. Right-click or Enter to finish. It always runs edge to edge.' },
  { id: 'bridge', label: 'Bridge', key: 'B', hint: 'Click on the river to put a bridge there.' },
  { id: 'ford', label: 'Ford', key: 'F', hint: 'Click on the river to put a ford there: a slow, shallow crossing.' },
  { id: 'erase', label: 'Erase', key: 'E', hint: 'Click or drag over anything to remove it.' },
];

const VILLAGE_NAMES = ['Westbrook', 'Kessel', 'Hollin', 'Marrau', 'Dornach', 'Aschfeld', 'Felden', 'Brackwitz', 'Ulmen', 'Sorau', 'Grisau', 'Lenthe', 'Oberau', 'Ratzen', 'Velden', 'Wiesloch'];
const DEPOT_NAMES = ['Linden Depot', 'Ostrava Depot', 'Gorse Depot', 'Halden Depot', 'Pellau Depot', 'Rothen Depot', 'Kreuz Depot', 'Marl Depot'];
const BRIDGE_NAMES = ['Mill Bridge', 'Stone Bridge', 'Toll Bridge', 'Abbey Bridge', 'Weir Bridge', 'Cart Bridge', 'Kings Bridge'];
const FORD_NAMES = ['Shallow Ford', 'Cattle Ford', 'Ferry Ford', 'Ash Ford'];

interface Town extends Omit<ObjectiveDef, 'id' | 'centre'> {}
interface EdCrossing extends Crossing { obj: boolean } // obj: the crossing is an objective too

/** The map as the editor holds it: crossings carry whether they are objectives, rather than a separate bridge town. */
interface EdMap {
  name: string;
  river: Vec[];
  crossings: EdCrossing[];
  towns: Town[];
  woods: Circle[];
  hills: Circle[];
  marshes: Circle[];
  roads: Vec[][];
}

type Sel =
  | { kind: 'town' | 'crossing' | 'woods' | 'hills' | 'marshes' | 'road'; i: number; j?: number }
  | { kind: 'river'; i: number };

function fromData(d: MapData): EdMap {
  const bridges = d.objectives.filter((o) => o.kind === 'bridge');
  return {
    name: d.name,
    river: d.river.map((p) => ({ x: p.x, y: p.y })),
    crossings: d.crossings.map((c) => {
      const o = bridges.find((b) => dist(b, c) < 5);
      return { x: c.x, y: c.y, name: o?.name ?? c.name, ford: c.ford, obj: !!o };
    }),
    towns: d.objectives.filter((o) => o.kind !== 'bridge').map((o) => ({ name: o.name, kind: o.kind, x: o.x, y: o.y, home: o.home })),
    woods: structuredClone(d.woods),
    hills: structuredClone(d.hills),
    marshes: structuredClone(d.marshes),
    roads: structuredClone(d.roads),
  };
}

function toData(m: EdMap): MapData {
  return {
    version: 1,
    name: m.name,
    river: m.river,
    crossings: m.crossings.map(({ obj, ...c }) => { void obj; return c; }),
    objectives: [
      ...m.towns.map((t) => (t.home === undefined ? { name: t.name, kind: t.kind, x: t.x, y: t.y } : { name: t.name, kind: t.kind, x: t.x, y: t.y, home: t.home })),
      ...m.crossings.filter((c) => c.obj).map((c) => ({ name: c.name, kind: 'bridge' as ObjectiveKind, x: c.x, y: c.y })),
    ],
    woods: m.woods,
    hills: m.hills,
    marshes: m.marshes,
    roads: m.roads,
  };
}

/** A blank field: two home towns a side and a village in the middle, nothing else. */
function blankMap(name: string): EdMap {
  const W = MAP.width;
  const H = MAP.height;
  return {
    name, river: [], crossings: [], woods: [], hills: [], marshes: [], roads: [],
    towns: [
      { name: 'Westbrook', kind: 'village', x: 500, y: H * 0.28, home: 0 },
      { name: 'Halden Depot', kind: 'depot', x: 500, y: H * 0.72, home: 0 },
      { name: 'Felden', kind: 'village', x: W / 2, y: H / 2 },
      { name: 'Linden Depot', kind: 'depot', x: W - 500, y: H * 0.28, home: 1 },
      { name: 'Sorau', kind: 'village', x: W - 500, y: H * 0.72, home: 1 },
    ],
  };
}

function nearestOnLine(line: Vec[], p: Vec): { point: Vec; d: number } | null {
  let best: { point: Vec; d: number } | null = null;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2));
    const q = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
    const d = dist(p, q);
    if (!best || d < best.d) best = { point: q, d };
  }
  return best;
}

/** A river runs from the top edge to the bottom: sorted north to south, with its ends on the edges. */
function tidyRiver(points: Vec[]): Vec[] {
  if (points.length < 2) return [];
  const r = points.slice().sort((a, b) => a.y - b.y).map((p) => ({ x: Math.max(60, Math.min(MAP.width - 60, p.x)), y: p.y }));
  r[0].y = 0;
  r[r.length - 1].y = MAP.height;
  return r;
}

export class EditorScene extends Phaser.Scene {
  private m: EdMap = blankMap('My map');
  private tool: Tool = 'select';
  private brush = 120;
  private mirrorOn = true;
  private sel: Sel | null = null;
  private drawing: Vec[] | null = null; // the road or river being laid
  private drag: { sel: Sel; partner: Sel | null; last: Vec } | null = null;
  private painting = false;
  private lastPaint: Vec | null = null;
  private pan: { x: number; y: number; sx: number; sy: number; moved: boolean } | null = null;
  private gfx!: Phaser.GameObjects.Graphics;
  private layer: Phaser.GameObjects.GameObject[] = [];
  private labels: Phaser.GameObjects.Text[] = [];
  private repaintTimer: number | undefined;
  private ui!: HTMLDivElement;
  private pointer: Vec = { x: 0, y: 0 };
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);

  constructor() {
    super('editor');
  }

  create() {
    const cam = this.cameras.main;
    cam.setRotation(VIEW_ROTATION);
    cam.setBackgroundColor('#1d1b16');
    this.fitCamera();
    this.scale.on('resize', this.fitCamera, this);
    this.gfx = this.add.graphics().setDepth(5);
    this.buildUi();
    this.loadInto(blankMap(this.freshName()));
    this.setupInput();
    this.events.once('shutdown', () => {
      window.removeEventListener('keydown', this.keyHandler);
      this.scale.off('resize', this.fitCamera, this);
      window.clearTimeout(this.repaintTimer);
      this.ui.remove();
      document.body.classList.remove('editor');
      for (const o of [...this.layer, ...this.labels]) o.destroy();
    });
    document.body.classList.add('editor');
  }

  // ---------- camera ----------

  private fitCamera() {
    const cam = this.cameras.main;
    const across = [MAP.height, MAP.width];
    cam.setZoom(Math.min((cam.width - 380) / across[0], (cam.height - 120) / across[1], 1) || 0.2);
    cam.centerOn(MAP.width / 2, MAP.height / 2);
  }

  private worldAt(sx: number, sy: number, zoom = this.cameras.main.zoom): Vec {
    const cam = this.cameras.main;
    const d = screenToWorldDir((sx - cam.width / 2) / zoom, (sy - cam.height / 2) / zoom);
    return { x: cam.scrollX + cam.width / 2 + d.x, y: cam.scrollY + cam.height / 2 + d.y };
  }

  // ---------- input ----------

  private setupInput() {
    this.input.mouse?.disableContextMenu();
    const cam = this.cameras.main;
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      const w = this.worldAt(p.x, p.y);
      if (p.button === 1 || p.button === 2) {
        this.pan = { x: cam.scrollX, y: cam.scrollY, sx: p.x, sy: p.y, moved: false };
        return;
      }
      if (p.button !== 0) return;
      this.press(w);
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      const w = this.worldAt(p.x, p.y);
      this.pointer = w;
      if (this.pan) {
        const dx = p.x - this.pan.sx;
        const dy = p.y - this.pan.sy;
        if (Math.abs(dx) + Math.abs(dy) > 5) this.pan.moved = true;
        const d = screenToWorldDir(dx / cam.zoom, dy / cam.zoom);
        cam.scrollX = this.pan.x - d.x;
        cam.scrollY = this.pan.y - d.y;
        return;
      }
      if (this.drag) this.dragTo(w);
      else if (this.painting) this.paint(w);
    });
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      if (this.pan) {
        const moved = this.pan.moved;
        this.pan = null;
        // A right-click without dragging finishes the road or river being laid.
        if (!moved && p.button === 2) this.finishLine();
        return;
      }
      if (this.drag) {
        if (this.drag.sel.kind === 'river') this.m.river = tidyRiver(this.m.river);
        this.drag = null;
        this.changed();
      }
      if (this.painting) {
        this.painting = false;
        this.lastPaint = null;
        this.changed();
      }
    });
    this.input.on('wheel', (p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => {
      const before = this.worldAt(p.x, p.y);
      const zoom = Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.88 : 1.12), 0.12, 2);
      const after = this.worldAt(p.x, p.y, zoom);
      cam.setZoom(zoom);
      cam.scrollX += before.x - after.x;
      cam.scrollY += before.y - after.y;
    });
    window.addEventListener('keydown', this.keyHandler);
  }

  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    const k = e.key.toLowerCase();
    const tool = TOOLS.find((x) => x.key.toLowerCase() === k);
    if (tool && !e.ctrlKey && !e.metaKey) this.setTool(tool.id);
    if (k === 'enter') this.finishLine();
    if (k === 'escape') { this.drawing = null; this.sel = null; this.renderSel(); }
    if ((k === 'delete' || k === 'backspace') && this.sel) { this.remove(this.sel, true); this.sel = null; this.changed(); }
    const cam = this.cameras.main;
    const step = 200 / cam.zoom;
    const d = k === 'arrowleft' ? screenToWorldDir(-step, 0) : k === 'arrowright' ? screenToWorldDir(step, 0)
      : k === 'arrowup' ? screenToWorldDir(0, -step) : k === 'arrowdown' ? screenToWorldDir(0, step) : null;
    if (d) { cam.scrollX += d.x; cam.scrollY += d.y; e.preventDefault(); }
  }

  private press(w: Vec) {
    const m = this.m;
    const both = (f: (p: Vec, flip: boolean) => void) => {
      f(w, false);
      if (this.mirrorOn && dist(w, mirror(w)) > 80) f(mirror(w), true);
    };
    switch (this.tool) {
      case 'select': {
        this.sel = this.hit(w);
        if (this.sel) this.drag = { sel: this.sel, partner: this.mirrorOn ? this.partner(this.sel) : null, last: w };
        this.renderSel();
        this.drawOverlay();
        return;
      }
      case 'village':
      case 'depot':
        both((p, flip) => {
          const kind = this.tool as 'village' | 'depot';
          m.towns.push({ name: this.newName(kind === 'village' ? VILLAGE_NAMES : DEPOT_NAMES), kind, x: p.x, y: p.y });
          if (!flip) this.sel = { kind: 'town', i: m.towns.length - 1 };
        });
        break;
      case 'hill':
        both((p) => m.hills.push({ x: p.x, y: p.y, r: Math.max(120, this.brush) }));
        break;
      case 'woods':
      case 'marsh':
        this.painting = true;
        this.lastPaint = null;
        this.paint(w);
        return;
      case 'erase':
        this.painting = true;
        this.paint(w);
        return;
      case 'road':
      case 'river':
        if (!this.drawing) this.drawing = [];
        this.drawing.push(this.tool === 'road' ? this.snap(w) : w);
        this.drawOverlay();
        return;
      case 'bridge':
      case 'ford': {
        if (!m.river.length) { this.flash('Lay a river first.'); return; }
        const ford = this.tool === 'ford';
        both((p, flip) => {
          const on = nearestOnLine(m.river, p);
          if (!on || on.d > 300) return;
          if (m.crossings.some((c) => dist(c, on.point) < CROSSING_RADIUS * 2)) return;
          m.crossings.push({ ...on.point, name: this.newName(ford ? FORD_NAMES : BRIDGE_NAMES), ford, obj: !ford });
          if (!flip) this.sel = { kind: 'crossing', i: m.crossings.length - 1 };
        });
        break;
      }
    }
    this.changed();
  }

  /** Woods and marsh are painted as a run of overlapping patches; the eraser removes whatever it passes over. */
  private paint(w: Vec) {
    if (this.tool === 'erase') {
      const s = this.hit(w);
      if (s) { this.remove(s, true); this.sel = null; this.drawOverlay(); this.scheduleRepaint(); }
      return;
    }
    if (this.lastPaint && dist(this.lastPaint, w) < this.brush * 0.8) return;
    this.lastPaint = w;
    const list = this.tool === 'woods' ? this.m.woods : this.m.marshes;
    list.push({ x: w.x, y: w.y, r: this.brush });
    if (this.mirrorOn && dist(w, mirror(w)) > this.brush * 2) list.push({ ...mirror(w), r: this.brush });
    this.drawOverlay();
    this.scheduleRepaint();
  }

  private dragTo(w: Vec) {
    const d = this.drag!;
    const dx = w.x - d.last.x;
    const dy = w.y - d.last.y;
    d.last = w;
    this.moveBy(d.sel, dx, dy);
    if (d.partner) this.moveBy(d.partner, -dx, -dy);
    this.drawOverlay();
    this.renderLabels();
  }

  private moveBy(s: Sel, dx: number, dy: number) {
    const m = this.m;
    const shift = (p: Vec) => { p.x = Math.max(40, Math.min(MAP.width - 40, p.x + dx)); p.y = Math.max(0, Math.min(MAP.height, p.y + dy)); };
    if (s.kind === 'town') shift(m.towns[s.i]);
    else if (s.kind === 'woods' || s.kind === 'hills' || s.kind === 'marshes') shift(m[s.kind][s.i]);
    else if (s.kind === 'road') shift(m.roads[s.i][s.j!]);
    else if (s.kind === 'river') {
      const p = m.river[s.i];
      // The river's ends stay on the edges; they only slide along them.
      const end = s.i === 0 || s.i === m.river.length - 1;
      p.x = Math.max(60, Math.min(MAP.width - 60, p.x + dx));
      if (!end) p.y = Math.max(1, Math.min(MAP.height - 1, p.y + dy));
      this.snapCrossings();
    } else if (s.kind === 'crossing') {
      const c = m.crossings[s.i];
      const on = nearestOnLine(m.river, { x: c.x + dx, y: c.y + dy });
      if (on) { c.x = on.point.x; c.y = on.point.y; }
    }
  }

  /** Crossings stay on the river when it moves. */
  private snapCrossings() {
    for (const c of this.m.crossings) {
      const on = nearestOnLine(this.m.river, c);
      if (on) { c.x = on.point.x; c.y = on.point.y; }
    }
  }

  private finishLine() {
    const pts = this.drawing;
    this.drawing = null;
    if (!pts || pts.length < 2) { this.drawOverlay(); return; }
    if (this.tool === 'road') {
      this.m.roads.push(pts);
      if (this.mirrorOn && pts.some((p) => dist(p, mirror(p)) > 200)) this.m.roads.push(pts.map((p) => this.snap(mirror(p))).reverse());
    } else {
      // With mirroring on, the north half drawn is turned round onto the south, so both armies face the same river.
      let r = pts;
      if (this.mirrorOn) {
        const north = pts.filter((p) => p.y < MAP.height / 2).sort((a, b) => a.y - b.y);
        if (north.length >= 1) r = [...north, ...north.slice().reverse().map(mirror)];
      }
      this.m.river = tidyRiver(r);
      this.snapCrossings();
      // A crossing left far from a redrawn river goes.
      this.m.crossings = this.m.crossings.filter((c) => (nearestOnLine(this.m.river, c)?.d ?? Infinity) < 5);
    }
    this.changed();
  }

  /** Road points snap to a nearby town or crossing, so the road really runs through it. */
  private snap(p: Vec): Vec {
    const spots: Vec[] = [...this.m.towns, ...this.m.crossings];
    const near = spots.filter((s) => dist(s, p) < 90).sort((a, b) => dist(a, p) - dist(b, p))[0];
    return near ? { x: near.x, y: near.y } : p;
  }

  /** What is under the pointer: towns and crossings first, then road and river points, then areas. */
  private hit(w: Vec): Sel | null {
    const m = this.m;
    const tol = 22 / this.cameras.main.zoom;
    const best = <T extends Vec>(list: T[], within: (x: T) => number): number => {
      let bi = -1;
      let bd = Infinity;
      list.forEach((x, i) => { const d = dist(x, w); if (d < within(x) && d < bd) { bd = d; bi = i; } });
      return bi;
    };
    let i = best(m.towns, () => Math.max(VILLAGE_RADIUS, tol));
    if (i >= 0) return { kind: 'town', i };
    i = best(m.crossings, () => Math.max(CROSSING_RADIUS, tol));
    if (i >= 0) return { kind: 'crossing', i };
    for (let r = 0; r < m.roads.length; r++) {
      const j = best(m.roads[r], () => Math.max(40, tol));
      if (j >= 0) return { kind: 'road', i: r, j };
    }
    i = best(m.river, () => Math.max(50, tol));
    if (i >= 0) return { kind: 'river', i };
    for (const kind of ['hills', 'woods', 'marshes'] as Area[]) {
      i = best(m[kind], (c) => c.r);
      if (i >= 0) return { kind, i };
    }
    // Anywhere along a road or the river picks the nearest point of it.
    for (let r = 0; r < m.roads.length; r++) {
      const on = nearestOnLine(m.roads[r], w);
      if (on && on.d < Math.max(30, tol)) return { kind: 'road', i: r, j: best(m.roads[r], () => Infinity) };
    }
    const on = nearestOnLine(m.river, w);
    if (on && on.d < Math.max(40, tol)) return { kind: 'river', i: best(m.river, () => Infinity) };
    return null;
  }

  /** The mirrored twin of an item, if there is one where the mirror would put it. */
  private partner(s: Sel): Sel | null {
    const m = this.m;
    const at = (list: Vec[], p: Vec, skip: number) => {
      let bi = -1;
      let bd = 60;
      list.forEach((x, i) => { if (i !== skip && dist(x, mirror(p)) < bd) { bd = dist(x, mirror(p)); bi = i; } });
      return bi;
    };
    if (s.kind === 'town' || s.kind === 'crossing' || s.kind === 'woods' || s.kind === 'hills' || s.kind === 'marshes') {
      const list: Vec[] = s.kind === 'town' ? m.towns : s.kind === 'crossing' ? m.crossings : m[s.kind];
      const i = at(list, list[s.i], s.i);
      return i >= 0 ? { kind: s.kind, i } : null;
    }
    if (s.kind === 'river') {
      const i = at(m.river, m.river[s.i], s.i);
      return i >= 0 ? { kind: 'river', i } : null;
    }
    const p = m.roads[s.i][s.j!];
    for (let r = 0; r < m.roads.length; r++) {
      const j = at(m.roads[r], p, r === s.i ? s.j! : -1);
      if (j >= 0) return { kind: 'road', i: r, j };
    }
    return null;
  }

  /** Take an item off the map (its mirrored twin too, when mirroring is on). */
  private remove(s: Sel, withPartner: boolean) {
    const m = this.m;
    const partner = withPartner && this.mirrorOn ? this.partner(s) : null;
    const gone: Sel[] = [s];
    if (partner && !(partner.kind === s.kind && partner.i === s.i)) gone.push(partner);
    // Remove from the back of each list first, so the other index stays right.
    gone.sort((a, b) => b.i - a.i);
    for (const g of gone) {
      if (g.kind === 'town') m.towns.splice(g.i, 1);
      else if (g.kind === 'crossing') m.crossings.splice(g.i, 1);
      else if (g.kind === 'woods' || g.kind === 'hills' || g.kind === 'marshes') m[g.kind].splice(g.i, 1);
      else if (g.kind === 'road') m.roads.splice(g.i, 1);
      else if (g.kind === 'river') {
        // Taking out an end, or leaving too little, removes the whole river and its crossings.
        if (g.i === 0 || g.i === m.river.length - 1 || m.river.length <= 2) { m.river = []; m.crossings = []; break; }
        m.river.splice(g.i, 1);
        this.snapCrossings();
      }
    }
  }

  private newName(list: string[]): string {
    const used = new Set([...this.m.towns.map((t) => t.name), ...this.m.crossings.map((c) => c.name)]);
    const free = list.filter((n) => !used.has(n));
    if (free.length) return free[Math.floor(Math.random() * free.length)];
    let n = 2;
    while (used.has(`${list[0]} ${n}`)) n++;
    return `${list[0]} ${n}`;
  }

  private freshName(): string {
    const names = new Set(savedMaps().map((m) => m.name));
    let n = 1;
    while (names.has(`My map ${n}`)) n++;
    return `My map ${n}`;
  }

  // ---------- drawing ----------

  /** After any change: redraw the outlines now, and the painted map once the editing pauses. */
  private changed() {
    this.drawOverlay();
    this.renderLabels();
    this.renderSel();
    this.renderCheck();
    this.scheduleRepaint();
  }

  private scheduleRepaint() {
    window.clearTimeout(this.repaintTimer);
    this.repaintTimer = window.setTimeout(() => this.repaint(), 350);
  }

  /** Paint the map the way a battle will show it. */
  private repaint() {
    loadMap(toData(this.m));
    const full = paintTerrain();
    for (const o of this.layer) o.destroy();
    this.layer = [];
    const tw = Math.ceil(MAP.width / 2);
    const th = Math.ceil(MAP.height / 2);
    for (let ty = 0; ty < 2; ty++) {
      for (let tx = 0; tx < 2; tx++) {
        const key = `ed-terrain-${tx}-${ty}`;
        if (this.textures.exists(key)) this.textures.remove(key);
        const tile = document.createElement('canvas');
        tile.width = tw;
        tile.height = th;
        tile.getContext('2d')!.drawImage(full, -tx * tw, -ty * th);
        this.textures.addCanvas(key, tile);
        this.layer.push(this.add.image(tx * tw, ty * th, key).setOrigin(0, 0).setDepth(-10));
      }
    }
  }

  private renderLabels() {
    for (const t of this.labels) t.destroy();
    this.labels = [];
    const above = screenToWorldDir(0, -125);
    for (const o of [...this.m.towns, ...this.m.crossings.filter((c) => c.obj)]) {
      this.labels.push(this.add.text(o.x + above.x, o.y + above.y, o.name, {
        fontFamily: '"EB Garamond", Georgia, serif', fontSize: '34px', color: '#fffaf0', stroke: '#2a2620', strokeThickness: 6,
      }).setOrigin(0.5).setDepth(6).setRotation(-VIEW_ROTATION));
    }
  }

  update() {
    // Town names stay readable however far out the map is zoomed.
    const k = Math.max(1, 0.4 / this.cameras.main.zoom);
    for (const t of this.labels) if (t.scale !== k) t.setScale(k);
    // Only the brush outline and the line being laid follow the mouse; the rest is redrawn on change.
    if (this.drawing || ['woods', 'hill', 'marsh', 'erase'].includes(this.tool)) this.drawOverlay();
  }

  private drawOverlay() {
    const g = this.gfx;
    const m = this.m;
    const z = this.cameras.main.zoom;
    const px = (n: number) => n / z; // a width in screen pixels
    g.clear();
    // Deployment strips.
    g.fillStyle(SIDE_FILL[0], 0.12);
    g.fillRect(RULES.zoneStart, 0, RULES.zoneDepth, MAP.height);
    g.fillStyle(SIDE_FILL[1], 0.12);
    g.fillRect(MAP.width - RULES.zoneStart - RULES.zoneDepth, 0, RULES.zoneDepth, MAP.height);
    // The mirror line through the centre.
    if (this.mirrorOn) {
      g.fillStyle(0xfffaf0, 0.5);
      g.fillCircle(MAP.width / 2, MAP.height / 2, px(5));
    }
    const outline = (list: Circle[], color: number) => {
      g.lineStyle(px(1.5), color, 0.7);
      for (const c of list) g.strokeCircle(c.x, c.y, c.r);
    };
    outline(m.hills, 0x8a6a3a);
    outline(m.woods, 0x2f5a2a);
    outline(m.marshes, 0x3a7a78);
    g.lineStyle(px(2), 0x5a4a30, 0.6);
    for (const r of m.roads) g.strokePoints(r, false);
    if (m.river.length) {
      g.lineStyle(px(2), 0x1f4f8a, 0.9);
      g.strokePoints(m.river, false);
      g.fillStyle(0x1f4f8a, 1);
      for (const p of m.river) g.fillCircle(p.x, p.y, px(4));
    }
    for (const c of m.crossings) {
      g.lineStyle(px(2), c.ford ? 0x6aa0c0 : 0x2a2620, 1);
      g.strokeRect(c.x - CROSSING_RADIUS / 2, c.y - CROSSING_RADIUS / 2, CROSSING_RADIUS, CROSSING_RADIUS);
      if (c.obj) { g.lineStyle(px(2), 0xfffaf0, 0.8); g.strokeCircle(c.x, c.y, RULES.captureRadius); }
    }
    for (const t of m.towns) {
      g.lineStyle(px(2), 0xfffaf0, 0.8);
      g.strokeCircle(t.x, t.y, RULES.captureRadius);
      if (t.home !== undefined) {
        g.lineStyle(px(6), SIDE_FILL[t.home], 0.95);
        g.strokeCircle(t.x, t.y, RULES.captureRadius + px(5));
      }
    }
    // The selection.
    if (this.sel) {
      const p = this.selPoint(this.sel);
      const r = this.sel.kind === 'woods' || this.sel.kind === 'hills' || this.sel.kind === 'marshes' ? m[this.sel.kind][this.sel.i].r
        : this.sel.kind === 'town' ? RULES.captureRadius + 30 : this.sel.kind === 'crossing' ? CROSSING_RADIUS + 20 : 40;
      if (p) { g.lineStyle(px(3), 0xffe066, 1); g.strokeCircle(p.x, p.y, r); }
      if (this.sel.kind === 'road') { g.lineStyle(px(4), 0xffe066, 0.8); g.strokePoints(m.roads[this.sel.i], false); }
    }
    // The line being laid, and the brush.
    if (this.drawing) {
      const pts = [...this.drawing, this.tool === 'road' ? this.snap(this.pointer) : this.pointer];
      g.lineStyle(px(3), this.tool === 'river' ? 0x3a7fd0 : 0x8a6a3a, 0.9);
      g.strokePoints(pts, false);
    }
    if (['woods', 'hill', 'marsh'].includes(this.tool)) {
      g.lineStyle(px(2), 0xfffaf0, 0.7);
      const r = this.tool === 'hill' ? Math.max(120, this.brush) : this.brush;
      g.strokeCircle(this.pointer.x, this.pointer.y, r);
      if (this.mirrorOn) { g.lineStyle(px(1), 0xfffaf0, 0.35); g.strokeCircle(MAP.width - this.pointer.x, MAP.height - this.pointer.y, r); }
    }
    if (this.tool === 'erase') { g.lineStyle(px(2), 0xff8a7a, 0.8); g.strokeCircle(this.pointer.x, this.pointer.y, px(10)); }
  }

  private selPoint(s: Sel): Vec | null {
    const m = this.m;
    if (s.kind === 'town') return m.towns[s.i] ?? null;
    if (s.kind === 'crossing') return m.crossings[s.i] ?? null;
    if (s.kind === 'river') return m.river[s.i] ?? null;
    if (s.kind === 'road') return m.roads[s.i]?.[s.j!] ?? null;
    return m[s.kind][s.i] ?? null;
  }

  // ---------- panels ----------

  private buildUi() {
    const ui = document.createElement('div');
    ui.id = 'editor';
    ui.innerHTML = `
      <div class="panel ed-top">
        <input class="ed-name" maxlength="40" title="Map name" />
        <select class="ed-new" title="Start a new map"><option value="">New map…</option><option value="blank">Blank field</option><option value="random">Random field</option></select>
        <select class="ed-open" title="Open a saved map"></select>
        <button data-a="save">Save</button>
        <button data-a="forget" title="Delete the saved copy of this map">Delete</button>
        <button data-a="code">Share code</button>
        <button data-a="play" class="on">Test play</button>
        <button data-a="exit">Exit</button>
      </div>
      <div class="panel ed-tools">
        ${TOOLS.map((t) => `<button data-tool="${t.id}" title="${t.hint}">${t.label}<kbd>${t.key}</kbd></button>`).join('')}
        <label class="ed-row">Brush <input type="range" class="ed-brush" min="60" max="260" step="10" value="${this.brush}" /></label>
        <label class="ed-row" title="Everything you place, move or erase is copied onto the enemy's half, turned round the centre, so both sides get the same ground."><input type="checkbox" class="ed-mirror" ${this.mirrorOn ? 'checked' : ''} /> Mirror for a fair map</label>
      </div>
      <div class="panel ed-hint"></div>
      <div class="panel ed-sel"></div>
      <div class="panel ed-check"></div>
      <div class="ed-modal"><div class="panel">
        <h3>Share code</h3>
        <p>Copy this text to share the map, or paste someone else's code and load it.</p>
        <textarea class="ed-code" spellcheck="false"></textarea>
        <div class="ed-btns"><button data-a="copy">Copy</button><button data-a="load">Load pasted code</button><button data-a="close">Close</button></div>
      </div></div>`;
    document.getElementById('app')!.appendChild(ui);
    this.ui = ui;
    const q = <T extends HTMLElement>(s: string) => ui.querySelector(s) as T;
    q<HTMLInputElement>('.ed-name').addEventListener('input', (e) => { this.m.name = (e.target as HTMLInputElement).value; });
    q<HTMLSelectElement>('.ed-new').addEventListener('change', (e) => {
      const v = (e.target as HTMLSelectElement).value;
      (e.target as HTMLSelectElement).value = '';
      if (v === 'blank') this.loadInto(blankMap(this.freshName()));
      if (v === 'random') {
        generateMap(1 + Math.floor(Math.random() * 100000));
        this.loadInto({ ...fromData(currentMap()), name: this.freshName() });
      }
    });
    q<HTMLSelectElement>('.ed-open').addEventListener('change', (e) => {
      const name = (e.target as HTMLSelectElement).value;
      const map = savedMaps().find((m) => m.name === name);
      if (map) this.loadInto(fromData(map));
      this.renderOpen();
    });
    q<HTMLInputElement>('.ed-brush').addEventListener('input', (e) => { this.brush = Number((e.target as HTMLInputElement).value); });
    q<HTMLInputElement>('.ed-mirror').addEventListener('change', (e) => { this.mirrorOn = (e.target as HTMLInputElement).checked; this.drawOverlay(); });
    ui.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest('[data-a],[data-tool]') as HTMLElement | null;
      if (!el) return;
      if (el.dataset.tool) { this.setTool(el.dataset.tool as Tool); return; }
      const a = el.dataset.a;
      if (a === 'save') this.save();
      if (a === 'exit') window.dispatchEvent(new CustomEvent('wargame:editorExit', { detail: {} }));
      if (a === 'play') {
        const d = toData(this.m);
        const problems = mapProblems(d);
        if (problems.length) { this.flash(problems[0]); return; }
        this.save(true);
        window.dispatchEvent(new CustomEvent('wargame:editorExit', { detail: { play: d } }));
      }
      if (a === 'code') { q<HTMLTextAreaElement>('.ed-code').value = mapToCode(toData(this.m)); q('.ed-modal').style.display = 'flex'; }
      if (a === 'close') q('.ed-modal').style.display = 'none';
      if (a === 'copy') { q<HTMLTextAreaElement>('.ed-code').select(); navigator.clipboard?.writeText(q<HTMLTextAreaElement>('.ed-code').value).catch(() => undefined); el.textContent = 'Copied'; }
      if (a === 'load') {
        const map = mapFromCode(q<HTMLTextAreaElement>('.ed-code').value);
        if (!map) { el.textContent = 'Not a map code'; return; }
        this.loadInto(fromData(map));
        q('.ed-modal').style.display = 'none';
      }
      if (a === 'delete' && this.sel) { this.remove(this.sel, true); this.sel = null; this.changed(); }
      if (a === 'forget') {
        if (el.dataset.sure) { deleteMap(this.m.name); this.renderOpen(); this.flash(`Deleted the saved copy of ${this.m.name}.`); }
        else { el.dataset.sure = '1'; el.textContent = 'Click again to delete'; }
      }
    });
    ui.addEventListener('change', (e) => this.selChange(e.target as HTMLElement));
    ui.addEventListener('input', (e) => { if ((e.target as HTMLElement).dataset.f === 'name') this.selChange(e.target as HTMLElement); });
    this.setTool('select');
  }

  private loadInto(m: EdMap) {
    this.m = m;
    this.sel = null;
    this.drawing = null;
    (this.ui.querySelector('.ed-name') as HTMLInputElement).value = m.name;
    this.renderOpen();
    this.changed();
    this.repaint();
  }

  private save(quiet = false) {
    const name = this.m.name.trim() || this.freshName();
    this.m.name = name;
    const ok = saveMap(toData(this.m));
    this.renderOpen();
    if (!quiet) this.flash(ok ? `Saved ${name}. Pick it under Singleplayer to fight on it.` : 'Could not save: this browser is blocking storage.');
  }

  private renderOpen() {
    const list = savedMaps();
    const sel = this.ui.querySelector('.ed-open') as HTMLSelectElement;
    sel.innerHTML = `<option value="">Open saved map… (${list.length})</option>` + list.map((m) => `<option>${esc(m.name)}</option>`).join('');
  }

  private setTool(t: Tool) {
    if (this.drawing && t !== this.tool) this.finishLine();
    this.tool = t;
    this.ui.querySelectorAll<HTMLElement>('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    this.hint(TOOLS.find((x) => x.id === t)!.hint);
    this.drawOverlay();
  }

  private hint(text: string) {
    (this.ui.querySelector('.ed-hint') as HTMLElement).textContent = text;
  }

  private flash(text: string) {
    this.hint(text);
    window.setTimeout(() => this.hint(TOOLS.find((x) => x.id === this.tool)!.hint), 4000);
  }

  /** The panel for what is selected: name, kind and home side for a town; a few fields for anything else. */
  private renderSel() {
    const box = this.ui.querySelector('.ed-sel') as HTMLElement;
    const s = this.sel;
    if (!s) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    const m = this.m;
    const del = '<button data-a="delete">Delete</button>';
    if (s.kind === 'town') {
      const t = m.towns[s.i];
      box.innerHTML = `<div class="n">Town</div>
        <label>Name <input data-f="name" value="${esc(t.name)}" maxlength="24" /></label>
        <label>Kind <select data-f="kind"><option value="village" ${t.kind === 'village' ? 'selected' : ''}>Village</option><option value="depot" ${t.kind === 'depot' ? 'selected' : ''}>Depot</option></select></label>
        <label title="Each side starts with its army at its 2 home towns">Home of <select data-f="home"><option value="">Nobody</option><option value="0" ${t.home === 0 ? 'selected' : ''}>Blue (you)</option><option value="1" ${t.home === 1 ? 'selected' : ''}>Gold (enemy)</option></select></label>${del}`;
    } else if (s.kind === 'crossing') {
      const c = m.crossings[s.i];
      box.innerHTML = `<div class="n">${c.ford ? 'Ford' : 'Bridge'}</div>
        <label>Name <input data-f="name" value="${esc(c.name)}" maxlength="24" /></label>
        <label><input type="checkbox" data-f="obj" ${c.obj ? 'checked' : ''} /> An objective to hold</label>${del}`;
    } else if (s.kind === 'river') {
      box.innerHTML = '<div class="n">River</div><p>Drag its points to reshape it. Deleting an end point removes the whole river.</p>' + del.replace('Delete', 'Delete point');
    } else if (s.kind === 'road') {
      box.innerHTML = '<div class="n">Road</div><p>Drag its points to reshape it.</p>' + del.replace('Delete', 'Delete road');
    } else {
      const c = m[s.kind][s.i];
      const label = { woods: 'Woods', hills: 'Hill', marshes: 'Marsh' }[s.kind];
      box.innerHTML = `<div class="n">${label}</div><label>Size <input type="range" data-f="r" min="60" max="320" step="10" value="${c.r}" /></label>${del}`;
    }
  }

  private selChange(el: HTMLElement) {
    const f = el.dataset.f;
    const s = this.sel;
    if (!f || !s) return;
    const v = (el as HTMLInputElement).value;
    const m = this.m;
    const partner = this.mirrorOn ? this.partner(s) : null;
    if (s.kind === 'town') {
      const t = m.towns[s.i];
      if (f === 'name') t.name = v;
      if (f === 'kind') t.kind = v as ObjectiveKind;
      if (f === 'home') {
        t.home = v === '' ? undefined : (Number(v) as 0 | 1);
        // The mirrored town becomes the other side's home.
        if (partner?.kind === 'town') m.towns[partner.i].home = t.home === undefined ? undefined : ((1 - t.home) as 0 | 1);
      }
    } else if (s.kind === 'crossing') {
      const c = m.crossings[s.i];
      if (f === 'name') c.name = v;
      if (f === 'obj') {
        c.obj = (el as HTMLInputElement).checked;
        if (partner?.kind === 'crossing') m.crossings[partner.i].obj = c.obj;
      }
    } else if (s.kind === 'woods' || s.kind === 'hills' || s.kind === 'marshes') {
      if (f === 'r') {
        m[s.kind][s.i].r = Number(v);
        if (partner && partner.kind === s.kind) m[s.kind][partner.i].r = Number(v);
      }
    }
    this.drawOverlay();
    this.renderLabels();
    this.renderCheck();
    if (f !== 'name') this.scheduleRepaint();
  }

  private renderCheck() {
    const box = this.ui.querySelector('.ed-check') as HTMLElement;
    const problems = mapProblems(toData(this.m));
    box.className = `panel ed-check ${problems.length ? 'bad' : 'good'}`;
    box.innerHTML = problems.length ? `<b>Not ready to play</b><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : '<b>Ready to play</b>';
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
