import Phaser from 'phaser';
import { MAP, RULES, UNIT_TYPES, UnitTypeId } from '../sim/config';
import { AI } from '../sim/ai';
import { OBJECTIVES, Vec, dist } from '../sim/map';
import { Side, Unit, World, formationOf, inZone, unitSize } from '../sim/world';
import { Hud } from './hud';
import { paintTerrain } from './terrain';

const PLAYER: Side = 0;
const STEP = 1 / RULES.tickRate;
const SPEEDS = [0.5, 1, 2, 3];
const COLORS = {
  0: { fill: 0x2b2e38, symbol: 0xe9e1c8, light: 0x8d96b0 },
  1: { fill: 0xd9a92b, symbol: 0x3a2c10, light: 0xf2d27a },
} as const;

interface Drag {
  button: number;
  start: Vec; // world
  screen: Vec;
  current: Vec;
  moved: boolean;
}

export class BattleScene extends Phaser.Scene {
  private world!: World;
  private ai!: AI;
  private hud!: Hud;
  private seed = 1;
  private gfx!: Phaser.GameObjects.Graphics;
  private overlay!: Phaser.GameObjects.Graphics;
  private zones!: Phaser.GameObjects.Graphics;
  private acc = 0;
  private speedIndex = 1;
  private paused = false;
  private selected = new Set<number>();
  private pendingCallIn: UnitTypeId | null = null;
  private drag: Drag | null = null;
  private pan: { x: number; y: number; sx: number; sy: number } | null = null;
  private lastClick = { t: 0, id: -1 };
  private hudTimer = 0;
  private keys: Record<string, boolean> = {};
  private pointerWorld: Vec = { x: 0, y: 0 };
  private aiming = false; // placing the fire circle for the selected batteries

  constructor() {
    super('battle');
  }

  create() {
    this.newBattle();
    // The painted map is split into tiles so it stays under the texture size limit of older graphics cards.
    if (!this.textures.exists('terrain-0-0')) {
      const full = paintTerrain();
      const tw = Math.ceil(MAP.width / 2);
      const th = Math.ceil(MAP.height / 2);
      for (let ty = 0; ty < 2; ty++) {
        for (let tx = 0; tx < 2; tx++) {
          const tile = document.createElement('canvas');
          tile.width = tw;
          tile.height = th;
          tile.getContext('2d')!.drawImage(full, -tx * tw, -ty * th);
          this.textures.addCanvas(`terrain-${tx}-${ty}`, tile);
        }
      }
    }
    for (let ty = 0; ty < 2; ty++) {
      for (let tx = 0; tx < 2; tx++) this.add.image(tx * Math.ceil(MAP.width / 2), ty * Math.ceil(MAP.height / 2), `terrain-${tx}-${ty}`).setOrigin(0, 0);
    }
    this.zones = this.add.graphics();
    for (const o of OBJECTIVES) {
      this.add.text(o.x, o.y - 125, o.name, {
        fontFamily: '"EB Garamond", Georgia, serif', fontSize: '34px', color: '#fffaf0', stroke: '#2a2620', strokeThickness: 6,
      }).setOrigin(0.5);
    }
    this.gfx = this.add.graphics();
    this.overlay = this.add.graphics();

    const cam = this.cameras.main;
    cam.setBounds(0, 0, MAP.width, MAP.height);
    this.fitCamera();
    this.scale.on('resize', () => this.fitCamera());

    this.hud = new Hud(document.getElementById('hud')!, {
      callIn: (type) => {
        if (this.world.callInBlocker(PLAYER, type)) return;
        this.pendingCallIn = this.pendingCallIn === type ? null : type;
      },
      requisition: () => this.world.apply({ kind: 'requisition', side: PLAYER }),
      ready: () => this.world.apply({ kind: 'ready', side: PLAYER }),
      hold: () => this.world.apply({ kind: 'hold', side: PLAYER, ids: [...this.selected] }),
      formation: () => this.world.apply({ kind: 'formation', side: PLAYER, ids: [...this.selected] }),
      aim: () => { if (this.selectedGuns().length) this.aiming = true; },
      ceaseFire: () => this.world.apply({ kind: 'ceaseFire', side: PLAYER, ids: this.selectedGuns().map((u) => u.id) }),
      restart: () => {
        this.seed += 1;
        this.newBattle();
        this.hud.reset();
      },
      pause: () => { this.paused = !this.paused; },
      speed: (d) => { this.speedIndex = Phaser.Math.Clamp(this.speedIndex + d, 0, SPEEDS.length - 1); },
    });

    this.setupInput();
  }

  private newBattle() {
    this.world = new World(this.seed);
    this.ai = new AI(1);
    this.selected.clear();
    this.pendingCallIn = null;
    this.acc = 0;
    this.paused = false;
  }

  /** Start zoomed out so the whole battlefield is visible. */
  private fitCamera() {
    const cam = this.cameras.main;
    cam.setZoom(this.minZoom());
    cam.centerOn(MAP.width / 2, MAP.height / 2);
  }

  private minZoom(): number {
    const cam = this.cameras.main;
    return Math.max(cam.width / MAP.width, cam.height / MAP.height);
  }

  // ---------- input ----------

  private setupInput() {
    this.input.mouse?.disableContextMenu();
    const cam = this.cameras.main;

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      const w = { x: p.worldX, y: p.worldY };
      if (p.button === 1) {
        this.pan = { x: cam.scrollX, y: cam.scrollY, sx: p.x, sy: p.y };
        return;
      }
      this.drag = { button: p.button, start: w, screen: { x: p.x, y: p.y }, current: w, moved: false };
    });

    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      this.pointerWorld = { x: p.worldX, y: p.worldY };
      if (this.pan) {
        cam.scrollX = this.pan.x - (p.x - this.pan.sx) / cam.zoom;
        cam.scrollY = this.pan.y - (p.y - this.pan.sy) / cam.zoom;
      }
      if (this.drag) {
        this.drag.current = { x: p.worldX, y: p.worldY };
        if (Math.hypot(p.x - this.drag.screen.x, p.y - this.drag.screen.y) > 8) this.drag.moved = true;
      }
      const hover = this.unitAt(this.pointerWorld);
      this.hud.showTooltip(this.drag ? null : hover ?? null, p.x, p.y);
    });

    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      if (p.button === 1) {
        this.pan = null;
        return;
      }
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      const end = { x: p.worldX, y: p.worldY };
      if (d.button === 0) this.leftRelease(d, end, p.event.shiftKey);
      if (d.button === 2) this.rightRelease(d, end);
    });

    this.input.on('wheel', (p: Phaser.Input.Pointer, _over: unknown, _dx: number, dy: number) => {
      const before = { x: p.worldX, y: p.worldY };
      const zoom = Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.88 : 1.14), this.minZoom(), 2.5);
      cam.setZoom(zoom);
      cam.scrollX = before.x - cam.width * 0.5 - (p.x - cam.width * 0.5) / zoom;
      cam.scrollY = before.y - cam.height * 0.5 - (p.y - cam.height * 0.5) / zoom;
    });

    window.addEventListener('keydown', (e) => {
      this.keys[e.key.toLowerCase()] = true;
      const k = e.key.toLowerCase();
      if (k === ' ') { this.paused = !this.paused; e.preventDefault(); }
      if (k === 'h') this.world.apply({ kind: 'hold', side: PLAYER, ids: [...this.selected] });
      if (k === 'f') this.world.apply({ kind: 'formation', side: PLAYER, ids: [...this.selected] });
      if (k === 'b' && this.selectedGuns().length) this.aiming = true;
      if (k === 'x') this.world.apply({ kind: 'ceaseFire', side: PLAYER, ids: this.selectedGuns().map((u) => u.id) });
      if (k === '+' || k === '=') this.speedIndex = Math.min(SPEEDS.length - 1, this.speedIndex + 1);
      if (k === '-' || k === '_') this.speedIndex = Math.max(0, this.speedIndex - 1);
      if (k === 'escape') { this.pendingCallIn = null; this.aiming = false; this.selected.clear(); }
      if (k === 'a' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.selected = new Set(this.world.units.filter((u) => u.side === PLAYER && u.state !== 'routing').map((u) => u.id));
      }
    });
    window.addEventListener('keyup', (e) => { this.keys[e.key.toLowerCase()] = false; });
    window.addEventListener('blur', () => { this.keys = {}; });
  }

  private unitAt(p: Vec): Unit | undefined {
    let best: Unit | undefined;
    let bestD = Infinity;
    for (const u of this.world.units) {
      if (!u.seen[PLAYER]) continue;
      const { w, d } = unitSize(u);
      const dx = p.x - u.x;
      const dy = p.y - u.y;
      const along = dx * Math.cos(u.facing) + dy * Math.sin(u.facing);
      const across = -dx * Math.sin(u.facing) + dy * Math.cos(u.facing);
      if (Math.abs(along) <= d / 2 + 12 && Math.abs(across) <= w / 2 + 12) {
        const dd = Math.hypot(dx, dy);
        if (dd < bestD) { bestD = dd; best = u; }
      }
    }
    return best;
  }

  private selectedGuns(): Unit[] {
    return this.selectedUnits().filter((u) => u.type === 'artillery');
  }

  private leftRelease(d: Drag, end: Vec, shift: boolean) {
    if (this.aiming) {
      this.aiming = false;
      this.world.apply({ kind: 'bombard', side: PLAYER, ids: this.selectedGuns().map((u) => u.id), x: end.x, y: end.y });
      return;
    }
    if (this.pendingCallIn) {
      const type = this.pendingCallIn;
      if (inZone(PLAYER, end)) {
        this.world.apply({ kind: 'callIn', side: PLAYER, type, x: end.x, y: end.y });
        if (!shift || this.world.callInBlocker(PLAYER, type)) this.pendingCallIn = null;
      }
      return;
    }
    if (!d.moved) {
      const u = this.unitAt(end);
      if (u && u.side === PLAYER) {
        const now = this.time.now;
        if (this.lastClick.id === u.id && now - this.lastClick.t < 350) {
          // Double-click: every regiment of that type currently on screen.
          const view = this.cameras.main.worldView;
          this.selected = new Set(this.world.units
            .filter((o) => o.side === PLAYER && o.type === u.type && view.contains(o.x, o.y))
            .map((o) => o.id));
        } else {
          if (!shift) this.selected.clear();
          if (shift && this.selected.has(u.id)) this.selected.delete(u.id);
          else this.selected.add(u.id);
        }
        this.lastClick = { t: now, id: u.id };
      } else if (!shift) {
        this.selected.clear();
      }
      return;
    }
    const x0 = Math.min(d.start.x, end.x);
    const x1 = Math.max(d.start.x, end.x);
    const y0 = Math.min(d.start.y, end.y);
    const y1 = Math.max(d.start.y, end.y);
    if (!shift) this.selected.clear();
    for (const u of this.world.units) {
      if (u.side === PLAYER && u.state !== 'routing' && u.x >= x0 && u.x <= x1 && u.y >= y0 && u.y <= y1) this.selected.add(u.id);
    }
  }

  private selectedUnits(): Unit[] {
    return this.world.units.filter((u) => this.selected.has(u.id) && u.state !== 'routing');
  }

  private rightRelease(d: Drag, end: Vec) {
    if (this.pendingCallIn || this.aiming) {
      this.pendingCallIn = null;
      this.aiming = false;
      return;
    }
    const sel = this.selectedUnits();
    if (sel.length === 0) return;
    if (!d.moved) {
      const target = this.unitAt(end);
      if (target && target.side !== PLAYER && this.world.phase === 'battle') {
        this.world.apply({ kind: 'attack', side: PLAYER, ids: sel.map((u) => u.id), target: target.id });
        return;
      }
      this.world.apply({ kind: 'move', side: PLAYER, moves: this.groupMove(sel, end), facing: this.groupFacing(sel, end) });
      return;
    }
    const { moves, facing } = this.lineMove(sel, d.start, end);
    this.world.apply({ kind: 'move', side: PLAYER, moves, facing });
  }

  /** Keep the group's shape and move it so its centre lands on the target. */
  private groupMove(sel: Unit[], target: Vec) {
    const cx = sel.reduce((a, u) => a + u.x, 0) / sel.length;
    const cy = sel.reduce((a, u) => a + u.y, 0) / sel.length;
    return sel.map((u) => ({ id: u.id, x: target.x + (u.x - cx), y: target.y + (u.y - cy) }));
  }

  private groupFacing(sel: Unit[], target: Vec): number | undefined {
    const cx = sel.reduce((a, u) => a + u.x, 0) / sel.length;
    const cy = sel.reduce((a, u) => a + u.y, 0) / sel.length;
    if (Math.hypot(target.x - cx, target.y - cy) < 30) return undefined;
    return Math.atan2(target.y - cy, target.x - cx);
  }

  /** Spread the selection along the dragged line, all facing the same way, leaving room for each block's width. */
  private lineMove(sel: Unit[], a: Vec, b: Vec) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const dir = { x: dx / len, y: dy / len };
    const facing = Math.atan2(-dx, dy);
    // Order units along the line by where they stand now, so they do not cross each other.
    const sorted = [...sel].sort((u, v) => (u.x * dir.x + u.y * dir.y) - (v.x * dir.x + v.y * dir.y));
    const widths = sorted.map((u) => unitSize({ type: u.type, formation: u.formation }).w + 20);
    const needed = widths.reduce((s, w) => s + w, 0);
    const span = Math.max(len, needed);
    const gap = (span - needed) / Math.max(1, sorted.length - 1);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    let along = -span / 2 + (sorted.length === 1 ? (span - needed) / 2 : 0);
    const moves = sorted.map((u, i) => {
      const centre = along + widths[i] / 2;
      along += widths[i] + gap;
      return { id: u.id, x: mid.x + dir.x * centre, y: mid.y + dir.y * centre };
    });
    return { moves, facing };
  }

  // ---------- loop ----------

  update(_time: number, delta: number) {
    this.panCamera(delta);
    if (!this.paused) {
      this.acc += (Math.min(delta, 250) / 1000) * SPEEDS[this.speedIndex];
      let guard = 0;
      while (this.acc >= STEP && guard++ < 60) {
        for (const c of this.ai.update(this.world)) this.world.apply(c);
        this.world.step();
        this.acc -= STEP;
      }
    }
    for (const id of [...this.selected]) {
      const u = this.world.unit(id);
      if (!u || u.state === 'routing') this.selected.delete(id);
    }
    this.draw();
    this.hudTimer -= delta;
    if (this.hudTimer <= 0) {
      this.hudTimer = 100;
      this.hud.update(this.world, {
        selected: this.selectedUnits(),
        pendingCallIn: this.pendingCallIn,
        paused: this.paused,
        speed: SPEEDS[this.speedIndex],
      });
    }
  }

  private panCamera(delta: number) {
    const cam = this.cameras.main;
    const v = (900 / cam.zoom) * (delta / 1000);
    if (this.keys['a'] || this.keys['arrowleft']) cam.scrollX -= v;
    if (this.keys['d'] || this.keys['arrowright']) cam.scrollX += v;
    if (this.keys['w'] || this.keys['arrowup']) cam.scrollY -= v;
    if (this.keys['s'] || this.keys['arrowdown']) cam.scrollY += v;
  }

  // ---------- drawing ----------

  private draw() {
    const g = this.gfx;
    const o = this.overlay;
    g.clear();
    o.clear();
    const w = this.world;

    // Deployment zones.
    this.zones.clear();
    const deploying = w.phase === 'deploy' || this.pendingCallIn !== null;
    this.zones.fillStyle(COLORS[0].fill, deploying ? 0.22 : 0.08);
    this.zones.fillRect(0, 0, RULES.zoneDepth, MAP.height);
    this.zones.fillStyle(COLORS[1].fill, 0.1);
    this.zones.fillRect(MAP.width - RULES.zoneDepth, 0, RULES.zoneDepth, MAP.height);
    this.zones.lineStyle(3, COLORS[0].fill, deploying ? 0.7 : 0.3);
    this.zones.lineBetween(RULES.zoneDepth, 0, RULES.zoneDepth, MAP.height);
    this.zones.lineStyle(3, COLORS[1].fill, 0.35);
    this.zones.lineBetween(MAP.width - RULES.zoneDepth, 0, MAP.width - RULES.zoneDepth, MAP.height);

    // Objectives: a ring in the owner's colour and a small flag.
    OBJECTIVES.forEach((ob, i) => {
      const owner = w.owners[i];
      const c = owner === -1 ? 0xf4ecd6 : COLORS[owner].fill;
      g.lineStyle(5, c, 0.75);
      g.strokeCircle(ob.x, ob.y, RULES.captureRadius);
      g.lineStyle(4, 0x2a2620, 0.9);
      g.lineBetween(ob.x, ob.y - 95, ob.x, ob.y - 40);
      g.fillStyle(c, 1);
      g.fillTriangle(ob.x, ob.y - 95, ob.x + 34, ob.y - 84, ob.x, ob.y - 72);
    });

    // Reinforcements on the road: a dust cloud at the map edge in the last seconds.
    for (const side of [0, 1] as Side[]) {
      for (const c of w.sides[side].queue) {
        const left = c.readyAt - w.time;
        if (left > RULES.arrivalWarning) continue;
        const pos = { x: side === 0 ? 30 : MAP.width - 30, y: c.y };
        if (side !== PLAYER && !w.units.some((u) => u.side === PLAYER && dist(u, pos) <= UNIT_TYPES[u.type].sight)) continue;
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2 + w.time;
          g.fillStyle(0xb8a27a, 0.25);
          g.fillCircle(pos.x + Math.cos(a) * 25, pos.y + Math.sin(a) * 35, 30 + (k % 3) * 8);
        }
      }
    }

    // Units.
    // Fire circles of our batteries, and shell bursts anyone can see.
    for (const u of w.units) {
      if (u.side !== PLAYER || u.type !== 'artillery' || !u.fireZone) continue;
      const inRange = dist(u, u.fireZone) <= UNIT_TYPES.artillery.range;
      const sel = this.selected.has(u.id);
      const col = inRange ? 0xc0392b : 0x8a8170;
      g.lineStyle(sel ? 5 : 3, col, sel ? 0.9 : 0.55);
      g.strokeCircle(u.fireZone.x, u.fireZone.y, RULES.bombardRadius);
      g.fillStyle(col, 0.08);
      g.fillCircle(u.fireZone.x, u.fireZone.y, RULES.bombardRadius);
      if (sel) {
        g.lineStyle(2, col, 0.5);
        g.lineBetween(u.x, u.y, u.fireZone.x, u.fireZone.y);
      }
    }
    for (const i of w.impacts) {
      const age = w.time - i.t;
      g.fillStyle(0x3b3428, 0.35 * (1 - age / 3));
      g.fillCircle(i.x, i.y, 22);
      if (age < 1) {
        g.fillStyle(0xf0c060, 0.8 * (1 - age));
        g.fillCircle(i.x, i.y, 18 + age * 20);
        g.fillStyle(0xeeeae0, 0.5 * (1 - age));
        g.fillCircle(i.x + 10, i.y - 14, 28 + age * 30);
      }
    }

    // Units, drawn between their last two positions so movement is smooth at any frame rate.
    const now = w.time;
    const t = this.paused || w.phase !== 'battle' ? 1 : Phaser.Math.Clamp(this.acc / STEP, 0, 1);
    for (const u of w.units) {
      if (!u.seen[PLAYER]) continue;
      const view = {
        ...u,
        x: u.prev.x + (u.x - u.prev.x) * t,
        y: u.prev.y + (u.y - u.prev.y) * t,
        facing: u.prev.facing + Phaser.Math.Angle.Wrap(u.facing - u.prev.facing) * t,
      };
      this.drawUnit(g, view, now);
    }

    // Orders of the selected regiments.
    for (const u of this.selectedUnits()) {
      if (u.order.kind === 'move') {
        const pts = [u as Vec, ...u.waypoints];
        o.lineStyle(4, 0xfffaf0, 0.8);
        for (let i = 0; i < pts.length - 1; i++) o.lineBetween(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
        const last = pts[pts.length - 1];
        const prev = pts[pts.length - 2] ?? u;
        this.arrowHead(o, prev, last, 0xfffaf0);
      } else if (u.order.kind === 'attack') {
        const t = w.unit(u.order.target);
        if (t) {
          o.lineStyle(4, 0xc0392b, 0.85);
          o.lineBetween(u.x, u.y, t.x, t.y);
          this.arrowHead(o, u, t, 0xc0392b);
        }
      }
    }

    // Drag feedback.
    const d = this.drag;
    if (d && d.moved && d.button === 0 && !this.pendingCallIn) {
      o.lineStyle(2, 0xfffaf0, 0.9);
      o.strokeRect(Math.min(d.start.x, d.current.x), Math.min(d.start.y, d.current.y), Math.abs(d.current.x - d.start.x), Math.abs(d.current.y - d.start.y));
    }
    if (d && d.moved && d.button === 2) {
      const sel = this.selectedUnits();
      if (sel.length) {
        const { moves, facing } = this.lineMove(sel, d.start, d.current);
        for (const m of moves) {
          const u = sel.find((s) => s.id === m.id)!;
          this.blockOutline(o, { ...u, x: m.x, y: m.y, facing }, 0xfffaf0, 0.8);
        }
      }
    }

    // Range rings and the circle being placed while aiming artillery.
    if (this.aiming) {
      for (const u of this.selectedGuns()) {
        o.lineStyle(2, 0xfffaf0, 0.5);
        o.strokeCircle(u.x, u.y, UNIT_TYPES.artillery.range);
      }
      const ok = this.selectedGuns().some((u) => dist(u, this.pointerWorld) <= UNIT_TYPES.artillery.range);
      o.lineStyle(4, ok ? 0xc0392b : 0x8a8170, 0.9);
      o.strokeCircle(this.pointerWorld.x, this.pointerWorld.y, RULES.bombardRadius);
    }

    // Ghost of a call-in being placed.
    if (this.pendingCallIn) {
      const ok = inZone(PLAYER, this.pointerWorld);
      const type = this.pendingCallIn;
      const fake = { type, formation: UNIT_TYPES[type].formations[0], x: this.pointerWorld.x, y: this.pointerWorld.y, facing: 0 } as Unit;
      this.blockOutline(o, fake, ok ? 0x7fd17f : 0xe0604f, 0.9);
    }
  }

  private corners(u: Pick<Unit, 'x' | 'y' | 'facing' | 'type' | 'formation'>, inset = 0): Vec[] {
    const { w, d } = unitSize(u);
    const fx = Math.cos(u.facing);
    const fy = Math.sin(u.facing);
    const rx = -fy;
    const ry = fx;
    const hw = w / 2 - inset;
    const hd = d / 2 - inset;
    return [
      { x: u.x + fx * hd - rx * hw, y: u.y + fy * hd - ry * hw },
      { x: u.x + fx * hd + rx * hw, y: u.y + fy * hd + ry * hw },
      { x: u.x - fx * hd + rx * hw, y: u.y - fy * hd + ry * hw },
      { x: u.x - fx * hd - rx * hw, y: u.y - fy * hd - ry * hw },
    ];
  }

  private blockOutline(g: Phaser.GameObjects.Graphics, u: Pick<Unit, 'x' | 'y' | 'facing' | 'type' | 'formation'>, color: number, alpha: number) {
    g.lineStyle(3, color, alpha);
    g.strokePoints(this.corners(u), true);
  }

  private drawUnit(g: Phaser.GameObjects.Graphics, u: Unit, now: number) {
    const col = COLORS[u.side];
    const routing = u.state === 'routing';
    const alpha = routing ? 0.55 : 1;
    const c = this.corners(u);

    // Smoke from recent volleys, drawn first so the block sits on top.
    const since = now - u.firedAt;
    if (since < 1.4) {
      const fx = Math.cos(u.facing);
      const fy = Math.sin(u.facing);
      const { w, d } = unitSize(u);
      const puffs = u.type === 'artillery' ? 3 : 5;
      for (let k = 0; k < puffs; k++) {
        const across = (k / (puffs - 1) - 0.5) * w * 0.9;
        const ahead = d / 2 + 18 + since * 20 + (k % 2) * 10;
        const r = (u.type === 'artillery' ? 26 : 16) + since * 12;
        g.fillStyle(0xf5f2ea, 0.45 * (1 - since / 1.4));
        g.fillCircle(u.x + fx * ahead - fy * across, u.y + fy * ahead + fx * across, r);
      }
    }

    g.fillStyle(0x000000, 0.22 * alpha);
    g.fillPoints(c.map((p) => ({ x: p.x + 6, y: p.y + 8 })), true);
    g.fillStyle(col.fill, 0.35 * alpha);
    g.fillPoints(c, true);

    // Remaining strength fills the block from one side, like a health bar.
    const f = Math.max(0, Math.min(1, u.men / u.maxMen));
    const strength = [c[0], { x: c[0].x + (c[1].x - c[0].x) * f, y: c[0].y + (c[1].y - c[0].y) * f }, { x: c[3].x + (c[2].x - c[3].x) * f, y: c[3].y + (c[2].y - c[3].y) * f }, c[3]];
    g.fillStyle(col.fill, 0.95 * alpha);
    g.fillPoints(strength, true);

    // NATO-style symbol.
    const s = this.corners(u, 5);
    g.lineStyle(3, col.symbol, 0.9 * alpha);
    if (u.type === 'line' || u.type === 'light' || u.type === 'engineers') {
      g.lineBetween(s[0].x, s[0].y, s[2].x, s[2].y);
      g.lineBetween(s[1].x, s[1].y, s[3].x, s[3].y);
    }
    if (u.type === 'light') {
      g.fillStyle(col.symbol, alpha);
      g.fillCircle(u.x, u.y, 6);
    }
    if (u.type === 'engineers') g.strokeCircle(u.x, u.y, 8);
    if (u.type === 'cavalry') g.lineBetween(s[3].x, s[3].y, s[1].x, s[1].y);
    if (u.type === 'artillery') {
      g.fillStyle(col.symbol, alpha);
      g.fillCircle(u.x, u.y, 8);
      if (formationOf(u) === 'unlimbered') g.lineBetween(u.x, u.y, u.x + Math.cos(u.facing) * 22, u.y + Math.sin(u.facing) * 22);
    }

    // Outline: white when selected, orange when wavering, red when routing.
    const selected = this.selected.has(u.id);
    const outline = routing ? 0xc0392b : selected ? 0xffffff : u.state === 'wavering' ? 0xff9a2e : 0x1d1b16;
    g.lineStyle(selected ? 5 : 2.5, outline, alpha);
    g.strokePoints(c, true);

    // Morale bar above the block.
    if (u.morale < 99.5 || selected) {
      const bx = u.x - 30;
      const by = u.y - Math.max(unitSize(u).w, unitSize(u).d) / 2 - 18;
      g.fillStyle(0x1d1b16, 0.7);
      g.fillRect(bx - 1, by - 1, 62, 9);
      g.fillStyle(u.morale < RULES.waveringAt ? 0xd35400 : 0x7fc25b, 1);
      g.fillRect(bx, by, (60 * Math.max(0, u.morale)) / 100, 7);
    }

    if (u.meleeWith !== null) {
      g.fillStyle(0xb8a27a, 0.35);
      for (let k = 0; k < 4; k++) g.fillCircle(u.x + Math.cos(now * 3 + k) * 30, u.y + Math.sin(now * 2 + k) * 20, 18);
    }
  }

  private arrowHead(g: Phaser.GameObjects.Graphics, from: Vec, to: Vec, color: number) {
    const a = Math.atan2(to.y - from.y, to.x - from.x);
    const s = 26;
    g.fillStyle(color, 0.9);
    g.fillTriangle(
      to.x, to.y,
      to.x - Math.cos(a - 0.4) * s, to.y - Math.sin(a - 0.4) * s,
      to.x - Math.cos(a + 0.4) * s, to.y - Math.sin(a + 0.4) * s,
    );
  }
}
