import Phaser from 'phaser';
import { MAP, RULES, UNIT_TYPES, UnitTypeId } from '../sim/config';
import { AI } from '../sim/ai';
import { CROSSINGS, EARTHWORKS, OBJECTIVES, Vec, dist } from '../sim/map';
import { Side, Unit, World, experienceOf, formationOf, inZone, isSupport, unitSize } from '../sim/world';
import { Hud } from './hud';
import { paintTerrain } from './terrain';

const PLAYER: Side = 0;
// The view is turned like a chessboard: your side of the map at the bottom, the enemy at the top.
const VIEW_ROTATION = -Math.PI / 2;
const COS = Math.cos(VIEW_ROTATION);
const SIN = Math.sin(VIEW_ROTATION);
/** A direction on screen, expressed in world coordinates. */
const screenToWorldDir = (x: number, y: number): Vec => ({ x: x * COS + y * SIN, y: -x * SIN + y * COS });
const STEP = 1 / RULES.tickRate;
const SPEEDS = [0.5, 1, 2, 3, 5, 8];
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
  panning: boolean; // a plain left-drag moves the map; Shift+drag box-selects
}

export class BattleScene extends Phaser.Scene {
  private world!: World;
  private ais: AI[] = [];
  private spectating = false; // both armies are AI-controlled and the whole field is visible
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
  private mapLayer: Phaser.GameObjects.GameObject[] = [];
  private aiming = false; // placing the fire circle for the selected batteries

  constructor() {
    super('battle');
  }

  create() {
    this.newBattle();
    this.zones = this.add.graphics();
    this.gfx = this.add.graphics();
    this.overlay = this.add.graphics();

    const cam = this.cameras.main;
    cam.setRotation(VIEW_ROTATION);
    cam.setBackgroundColor('#1d1b16');
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
      formation: (f) => this.world.apply({ kind: 'formation', side: PLAYER, ids: [...this.selected], formation: f }),
      resign: () => this.world.apply({ kind: 'resign', side: PLAYER }),
      spectate: () => {
        this.spectating = !this.spectating;
        this.seed += 1;
        this.newBattle();
        this.hud.reset();
      },
      build: () => this.world.apply({ kind: 'build', side: PLAYER, ids: [...this.selected] }),
      aim: () => { if (this.selectedAimers().length) this.aiming = true; },
      ceaseFire: () => this.world.apply({ kind: 'ceaseFire', side: PLAYER, ids: this.selectedAimers().map((u) => u.id) }),
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

  private canSee(u: Unit): boolean {
    return this.spectating || u.seen[PLAYER];
  }

  private newBattle() {
    this.world = new World(this.seed);
    this.buildMap();
    this.ais = this.spectating ? [new AI(0), new AI(1)] : [new AI(1)];
    this.selected.clear();
    this.pendingCallIn = null;
    this.acc = 0;
    this.paused = false;
  }

  /** Paint the battlefield generated for this battle, with its objective names. */
  private buildMap() {
    for (const o of this.mapLayer) o.destroy();
    this.mapLayer = [];
    // The painted map is split into tiles so it stays under the texture size limit of older graphics cards.
    const full = paintTerrain();
    const tw = Math.ceil(MAP.width / 2);
    const th = Math.ceil(MAP.height / 2);
    for (let ty = 0; ty < 2; ty++) {
      for (let tx = 0; tx < 2; tx++) {
        const key = `terrain-${tx}-${ty}`;
        if (this.textures.exists(key)) this.textures.remove(key);
        const tile = document.createElement('canvas');
        tile.width = tw;
        tile.height = th;
        tile.getContext('2d')!.drawImage(full, -tx * tw, -ty * th);
        this.textures.addCanvas(key, tile);
        this.mapLayer.push(this.add.image(tx * tw, ty * th, key).setOrigin(0, 0).setDepth(-10));
      }
    }
    for (const o of OBJECTIVES) {
      const above = screenToWorldDir(0, -125);
      this.mapLayer.push(this.add.text(o.x + above.x, o.y + above.y, o.name, {
        fontFamily: '"EB Garamond", Georgia, serif', fontSize: '34px', color: '#fffaf0', stroke: '#2a2620', strokeThickness: 6,
      }).setOrigin(0.5).setDepth(-1).setRotation(-VIEW_ROTATION));
    }
  }

  /** Start with the map's width across the screen, looking at your own half. */
  private fitCamera() {
    const cam = this.cameras.main;
    cam.setZoom(Math.max(this.minZoom(), Math.min(cam.width / MAP.height, 0.6)));
    this.centerOn({ x: 0, y: MAP.height / 2 }); // clamped below so your own edge sits at the bottom of the screen
    this.clampCamera();
  }

  /** Zoomed all the way out, the whole battlefield fits on screen. */
  private minZoom(): number {
    const cam = this.cameras.main;
    const across = Math.abs(COS) > 0.5 ? [MAP.width, MAP.height] : [MAP.height, MAP.width];
    return Math.min(cam.width / across[0], cam.height / across[1]);
  }

  private centerOn(p: Vec) {
    const cam = this.cameras.main;
    cam.scrollX = p.x - cam.width / 2;
    cam.scrollY = p.y - cam.height / 2;
  }

  /** The world point under a screen position (the camera turns and zooms around the screen centre). */
  private worldAt(sx: number, sy: number, zoom = this.cameras.main.zoom): Vec {
    const cam = this.cameras.main;
    const d = screenToWorldDir((sx - cam.width / 2) / zoom, (sy - cam.height / 2) / zoom);
    return { x: cam.scrollX + cam.width / 2 + d.x, y: cam.scrollY + cam.height / 2 + d.y };
  }

  /** Keep the view over the battlefield; when the view is bigger than the map, centre the map. */
  private clampCamera() {
    const cam = this.cameras.main;
    const mid = { x: cam.scrollX + cam.width / 2, y: cam.scrollY + cam.height / 2 };
    const half = {
      x: (Math.abs(COS) * cam.width + Math.abs(SIN) * cam.height) / cam.zoom / 2,
      y: (Math.abs(SIN) * cam.width + Math.abs(COS) * cam.height) / cam.zoom / 2,
    };
    const clamp = (v: number, h: number, size: number) => (h * 2 >= size ? size / 2 : Phaser.Math.Clamp(v, h, size - h));
    this.centerOn({ x: clamp(mid.x, half.x, MAP.width), y: clamp(mid.y, half.y, MAP.height) });
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
      const panning = p.button === 0 && !p.event.shiftKey && !this.aiming && !this.pendingCallIn;
      if (panning) this.pan = { x: cam.scrollX, y: cam.scrollY, sx: p.x, sy: p.y };
      this.drag = { button: p.button, start: w, screen: { x: p.x, y: p.y }, current: w, moved: false, panning };
    });

    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      this.pointerWorld = { x: p.worldX, y: p.worldY };
      if (this.pan && (!this.drag?.panning || Math.hypot(p.x - this.pan.sx, p.y - this.pan.sy) > 8)) {
        const d = screenToWorldDir((p.x - this.pan.sx) / cam.zoom, (p.y - this.pan.sy) / cam.zoom);
        cam.scrollX = this.pan.x - d.x;
        cam.scrollY = this.pan.y - d.y;
        this.clampCamera();
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
      if (d?.panning) this.pan = null;
      if (!d || (d.panning && d.moved)) return;
      const end = { x: p.worldX, y: p.worldY };
      if (d.button === 0) this.leftRelease(d, end, p.event.shiftKey);
      if (d.button === 2) this.rightRelease(d, end);
    });

    this.input.on('wheel', (p: Phaser.Input.Pointer, _over: unknown, _dx: number, dy: number) => {
      // Zoom toward the pointer: the ground under it stays under it.
      const before = this.worldAt(p.x, p.y);
      const zoom = Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.88 : 1.14), this.minZoom(), 2.5);
      const after = this.worldAt(p.x, p.y, zoom);
      cam.setZoom(zoom);
      cam.scrollX += before.x - after.x;
      cam.scrollY += before.y - after.y;
      this.clampCamera();
    });

    window.addEventListener('keydown', (e) => {
      this.keys[e.key.toLowerCase()] = true;
      const k = e.key.toLowerCase();
      if (k === ' ') { this.paused = !this.paused; e.preventDefault(); }
      if (k === 'h') this.world.apply({ kind: 'hold', side: PLAYER, ids: [...this.selected] });
      if (k === 'f') this.world.apply({ kind: 'formation', side: PLAYER, ids: [...this.selected] });
      const fm = ({ '1': 'marching', '2': 'formation', '3': 'fortified' } as const)[k as '1' | '2' | '3'];
      if (fm) this.world.apply({ kind: 'formation', side: PLAYER, ids: [...this.selected], formation: fm });
      if (k === 'b' && this.selectedAimers().length) this.aiming = true;
      if (k === 'e') this.world.apply({ kind: 'build', side: PLAYER, ids: [...this.selected] });
      if (k === 'x') this.world.apply({ kind: 'ceaseFire', side: PLAYER, ids: this.selectedAimers().map((u) => u.id) });
      if (k === '+' || k === '=') this.speedIndex = Math.min(SPEEDS.length - 1, this.speedIndex + 1);
      if (k === '-' || k === '_') this.speedIndex = Math.max(0, this.speedIndex - 1);
      if (k === 'escape') { this.pendingCallIn = null; this.aiming = false; this.selected.clear(); }
      if (k === 'a' && (e.ctrlKey || e.metaKey) && !this.spectating) {
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
      if (!this.canSee(u)) continue;
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

  private selectedAimers(): Unit[] {
    return this.selectedGuns();
  }

  private leftRelease(d: Drag, end: Vec, shift: boolean) {
    if (this.spectating) return;
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
          // Double-click: the regiment's whole brigade.
          this.selected = new Set(this.world.units
            .filter((o) => o.side === PLAYER && o.brigade === u.brigade && o.state !== 'routing')
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
        for (const ai of this.ais) for (const c of ai.update(this.world)) this.world.apply(c);
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
        spectating: this.spectating,
      });
    }
  }

  private panCamera(delta: number) {
    const cam = this.cameras.main;
    const v = (900 / cam.zoom) * (delta / 1000);
    let sx = 0;
    let sy = 0;
    if (this.keys['a'] || this.keys['arrowleft']) sx -= v;
    if (this.keys['d'] || this.keys['arrowright']) sx += v;
    if (this.keys['w'] || this.keys['arrowup']) sy -= v;
    if (this.keys['s'] || this.keys['arrowdown']) sy += v;
    if (!sx && !sy) return;
    const d = screenToWorldDir(sx, sy);
    cam.scrollX += d.x;
    cam.scrollY += d.y;
    this.clampCamera();
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
    const z0 = RULES.zoneStart;
    const z1 = RULES.zoneStart + RULES.zoneDepth;
    this.zones.fillRect(z0, 0, RULES.zoneDepth, MAP.height);
    this.zones.fillStyle(COLORS[1].fill, 0.1);
    this.zones.fillRect(MAP.width - z1, 0, RULES.zoneDepth, MAP.height);
    this.zones.lineStyle(3, COLORS[0].fill, deploying ? 0.7 : 0.3);
    this.zones.lineBetween(z0, 0, z0, MAP.height);
    this.zones.lineBetween(z1, 0, z1, MAP.height);
    this.zones.lineStyle(3, COLORS[1].fill, 0.35);
    this.zones.lineBetween(MAP.width - z0, 0, MAP.width - z0, MAP.height);
    this.zones.lineBetween(MAP.width - z1, 0, MAP.width - z1, MAP.height);

    // During deployment, starting regiments can also be placed around your home towns.
    if (w.phase === 'deploy') {
      for (const t of w.homeTowns(PLAYER)) {
        this.zones.fillStyle(COLORS[0].fill, 0.12);
        this.zones.fillCircle(t.x, t.y, RULES.townDeployRadius);
        this.zones.lineStyle(3, COLORS[0].fill, 0.5);
        this.zones.strokeCircle(t.x, t.y, RULES.townDeployRadius);
      }
    }

    // Earthworks and pontoon bridges built by engineers.
    for (const e of EARTHWORKS) {
      this.zones.fillStyle(0x8a6d45, 0.35);
      this.zones.fillCircle(e.x, e.y, e.r);
      this.zones.lineStyle(10, 0x6b5236, 0.85);
      this.zones.strokeCircle(e.x, e.y, e.r);
      this.zones.lineStyle(3, COLORS[e.side].fill, 0.6);
      this.zones.strokeCircle(e.x, e.y, e.r - 9);
    }
    for (const c of CROSSINGS) {
      if (!c.pontoon) continue;
      this.zones.fillStyle(0x3b3024, 0.9);
      for (let k = -2; k <= 2; k++) this.zones.fillEllipse(c.x + k * 18, c.y, 12, 30);
      this.zones.fillStyle(0xa48b68, 1);
      this.zones.fillRect(c.x - 50, c.y - 8, 100, 16);
    }
    for (const u of w.units) {
      if (u.building <= 0 || !this.canSee(u)) continue;
      const total = u.buildKind === 'pontoon' ? RULES.pontoonTime : RULES.buildTime;
      this.zones.lineStyle(4, 0xfff3cf, 0.9);
      this.zones.beginPath();
      this.zones.arc(u.x, u.y, 60, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - u.building / total));
      this.zones.strokePath();
    }

    // The impassable border around the map.
    const b = RULES.borderWidth;
    this.zones.fillStyle(0x1d1b16, 0.5);
    this.zones.fillRect(0, 0, MAP.width, b);
    this.zones.fillRect(0, MAP.height - b, MAP.width, b);
    this.zones.fillRect(0, b, b, MAP.height - 2 * b);
    this.zones.fillRect(MAP.width - b, b, b, MAP.height - 2 * b);
    this.zones.lineStyle(2, 0x1d1b16, 0.6);
    this.zones.strokeRect(b, b, MAP.width - 2 * b, MAP.height - 2 * b);

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
        if (side !== PLAYER && !this.spectating && !w.units.some((u) => u.side === PLAYER && dist(u, pos) <= UNIT_TYPES[u.type].sight)) continue;
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
      if ((u.side !== PLAYER && !this.spectating) || u.type !== 'artillery' || !u.fireZone) continue;
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
    // Our wagon trains: the zone they supply on their own, and the spot their last cart is serving.
    for (const u of w.units) {
      if ((u.side !== PLAYER && !this.spectating) || u.type !== 'supply' || u.state === 'routing') continue;
      const sel = this.selected.has(u.id);
      g.lineStyle(sel ? 4 : 2, 0x4f9d4a, sel ? 0.7 : 0.3);
      g.strokeCircle(u.x, u.y, RULES.supplyRange);
      if (u.supplyZone && w.supplyActive(u)) {
        g.lineStyle(3, 0x4f9d4a, 0.6);
        g.strokeCircle(u.supplyZone.x, u.supplyZone.y, RULES.supplyAreaRadius);
        g.fillStyle(0x4f9d4a, 0.08);
        g.fillCircle(u.supplyZone.x, u.supplyZone.y, RULES.supplyAreaRadius);
      }
    }

    // The general's command radius: orders reach regiments inside it at once.
    for (const side of [0, 1] as Side[]) {
      if (side !== PLAYER && !this.spectating) continue;
      const gen = w.general(side);
      if (!gen) continue;
      g.lineStyle(3, COLORS[side].fill, 0.35);
      g.strokeCircle(gen.x, gen.y, RULES.commandRadius);
    }

    // Supply carts on the road to their area.
    for (const c of w.carts) {
      if (!this.spectating && !c.seen[PLAYER]) continue;
      g.fillStyle(0x1d1b16, 0.9);
      g.fillRect(c.x - 16, c.y - 11, 32, 22);
      g.fillStyle(0x8a6d45, 1);
      g.fillRect(c.x - 13, c.y - 8, 26, 16);
      g.fillStyle(COLORS[c.side].fill, 1);
      g.fillRect(c.x - 13, c.y - 8, 26 * (c.hp / 100), 5);
    }

    // Couriers riding out with orders.
    for (const c of w.couriers) {
      if (!this.spectating && !c.seen[PLAYER]) continue;
      const target = w.unit(c.unit);
      if (target && (c.side === PLAYER || this.spectating)) {
        g.lineStyle(2, 0xfffaf0, 0.35);
        g.lineBetween(c.x, c.y, target.x, target.y);
      }
      g.fillStyle(0x1d1b16, 0.9);
      g.fillCircle(c.x, c.y, 11);
      g.fillStyle(COLORS[c.side].fill, 1);
      g.fillCircle(c.x, c.y, 8);
    }

    for (const i of w.impacts) {
      const age = w.time - i.t;
      const blast = RULES.shellBlast;
      // Scorched crater, then a flash, a shock ring and a rolling cloud of smoke.
      g.fillStyle(0x3b3428, 0.4 * (1 - age / 3));
      g.fillCircle(i.x, i.y, blast * 0.6);
      if (age < 0.5) {
        g.lineStyle(4, 0xfff3cf, 0.7 * (1 - age / 0.5));
        g.strokeCircle(i.x, i.y, blast * (0.4 + age * 2.4));
      }
      if (age < 1.2) {
        const k = 1 - age / 1.2;
        g.fillStyle(0xd9542b, 0.7 * k);
        g.fillCircle(i.x, i.y, blast * (0.5 + age * 0.4));
        g.fillStyle(0xf0c060, 0.85 * k);
        g.fillCircle(i.x, i.y, blast * (0.3 + age * 0.4));
      }
      if (age < 2.5) {
        const k = 1 - age / 2.5;
        g.fillStyle(0xeeeae0, 0.45 * k);
        g.fillCircle(i.x + 12, i.y - 16, blast * (0.7 + age * 0.5));
        g.fillStyle(0xcfc8b8, 0.35 * k);
        g.fillCircle(i.x - 18, i.y - 4, blast * (0.5 + age * 0.45));
      }
    }

    // Units, drawn between their last two positions so movement is smooth at any frame rate.
    const now = w.time;
    const t = this.paused || w.phase !== 'battle' ? 1 : Phaser.Math.Clamp(this.acc / STEP, 0, 1);
    for (const u of w.units) {
      if (!this.canSee(u)) continue;
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
    if (d && d.moved && d.button === 0 && !d.panning && !this.pendingCallIn) {
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
      const fake = { type, formation: 'formation', x: this.pointerWorld.x, y: this.pointerWorld.y, facing: 0 } as Unit;
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
    if (u.type === 'supply') {
      // Supply: a bar across the rear of the block, on two wheels.
      g.lineBetween(s[2].x, s[2].y, s[3].x, s[3].y);
      g.lineBetween((s[0].x + s[3].x) / 2, (s[0].y + s[3].y) / 2, (s[1].x + s[2].x) / 2, (s[1].y + s[2].y) / 2);
      g.strokeCircle(u.x + (s[0].x - u.x) * 0.5, u.y + (s[0].y - u.y) * 0.5, 5);
      g.strokeCircle(u.x + (s[1].x - u.x) * 0.5, u.y + (s[1].y - u.y) * 0.5, 5);
    }
    if (u.type === 'general') {
      // The general: a banner on a pole above the staff block.
      const up = screenToWorldDir(0, -1);
      const right = screenToWorldDir(1, 0);
      const top = { x: u.x + up.x * 62, y: u.y + up.y * 62 };
      g.lineStyle(4, 0x2a2620, alpha);
      g.lineBetween(u.x, u.y, top.x, top.y);
      g.fillStyle(col.fill, alpha);
      g.fillPoints([top, { x: top.x + right.x * 34 - up.x * 8, y: top.y + right.y * 34 - up.y * 8 }, { x: top.x - up.x * 18, y: top.y - up.y * 18 }], true);
      g.fillStyle(col.symbol, alpha);
      g.fillCircle(u.x, u.y, 7);
    }
    if (u.type === 'artillery') {
      g.fillStyle(col.symbol, alpha);
      g.fillCircle(u.x, u.y, 8);
      if (formationOf(u) === 'fortified') g.lineBetween(u.x, u.y, u.x + Math.cos(u.facing) * 22, u.y + Math.sin(u.facing) * 22);
    }

    // Outline: white when selected, orange when wavering, red when routing.
    const selected = this.selected.has(u.id);
    const outline = routing ? 0xc0392b : selected ? 0xffffff : u.state === 'wavering' ? 0xff9a2e : 0x1d1b16;
    g.lineStyle(selected ? 5 : 2.5, outline, alpha);
    g.strokePoints(c, true);

    // Morale bar above the block, as seen on screen.
    if (u.morale < 99.5 || selected) {
      const up = screenToWorldDir(0, -1);
      const right = screenToWorldDir(1, 0);
      const lift = Math.max(unitSize(u).w, unitSize(u).d) / 2 + 18;
      const bar = (from: number, len: number, h: number): Vec[] => {
        const o = { x: u.x + up.x * lift + right.x * from, y: u.y + up.y * lift + right.y * from };
        return [o, { x: o.x + right.x * len, y: o.y + right.y * len }, { x: o.x + right.x * len + up.x * h, y: o.y + right.y * len + up.y * h }, { x: o.x + up.x * h, y: o.y + up.y * h }];
      };
      g.fillStyle(0x1d1b16, 0.7);
      g.fillPoints(bar(-31, 62, 9), true);
      g.fillStyle(u.morale < RULES.waveringAt ? 0xd35400 : 0x7fc25b, 1);
      g.fillPoints(bar(-30, (60 * Math.max(0, u.morale)) / 100, 7), true);
    }

    // Own regiments show their ammunition as a thin blue bar under the morale bar, and their experience as pips.
    const own = u.side === PLAYER || this.spectating;
    if (own && (u.ammo < 99.5 || selected) && UNIT_TYPES[u.type].range > 0 || own && u.type === 'artillery' && u.ammo < 99.5) {
      const up = screenToWorldDir(0, -1);
      const right = screenToWorldDir(1, 0);
      const lift = Math.max(unitSize(u).w, unitSize(u).d) / 2 + 6;
      const o = { x: u.x + up.x * lift - right.x * 31, y: u.y + up.y * lift - right.y * 31 };
      const rect = (len: number, h: number): Vec[] => [o, { x: o.x + right.x * len, y: o.y + right.y * len }, { x: o.x + right.x * len + up.x * h, y: o.y + right.y * len + up.y * h }, { x: o.x + up.x * h, y: o.y + up.y * h }];
      g.fillStyle(0x1d1b16, 0.7);
      g.fillPoints(rect(62, 6), true);
      g.fillStyle(u.ammo < RULES.lowAmmo ? 0xc0392b : 0x5b9bd5, 1);
      g.fillPoints(rect((62 * Math.max(0, u.ammo)) / 100, 6), true);
    }
    const level = experienceOf(u);
    const pips = level === 'veteran' ? 1 : level === 'elite' ? 2 : 0;
    if (pips && !isSupport(u)) {
      const right = screenToWorldDir(1, 0);
      const up = screenToWorldDir(0, -1);
      const lift = Math.max(unitSize(u).w, unitSize(u).d) / 2 + 22;
      for (let k = 0; k < pips; k++) {
        const p = { x: u.x + up.x * lift + right.x * (40 + k * 14), y: u.y + up.y * lift + right.y * (40 + k * 14) };
        g.fillStyle(0xf0c060, alpha);
        g.fillCircle(p.x, p.y, 5);
      }
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
