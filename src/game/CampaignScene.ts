import Phaser from 'phaser';
import { UNIT_TYPES, UnitTypeId } from '../sim/config';
import {
  Army, BattleOutcome, Campaign, Fight, GRID_SIZE, OWNER_NAMES, RANKS, RECRUIT_COST, RELIEF_SECONDS, Territory, WORLD, advance, answerAlert, armyById,
  attackersOf, autoResolveEncounter, dismiss, encounterLord, encounterMap, encounterSides, encounterTitle, finishTutorial, friendlyGround,
  loadCampaign, newCampaign, ownedBy, playerArmy, previewAttack, rankOf, recruit, refit, refitCost, retreat, saveCampaign, settleEncounter,
  strength, territoryAt, territoryGrid, territoryUnder, winChance,
} from '../sim/strategic';
import { ArmyEntry, experienceOf } from '../sim/world';
import type { BattleSetup } from './BattleScene';

/**
 * The campaign map. Your army is a banner you march across the country by clicking; time runs while you march and
 * stops when something needs you: Ostmark marching on one of your towns, or a battle. Hover over an army or a town to
 * see its troops and your chance against it. Battles can be fought out on the battlefield or settled at once.
 */

const OWNER_RGB: [number, number, number][] = [[93, 111, 143], [199, 154, 58]];
const OWNER_HEX = [0x2b2e38, 0xd9a92b];
const ALLY_HEX = 0x5d7aa8;
const SEA: [number, number, number] = [107, 135, 150];
const DAY_SECONDS = 6; // real seconds per campaign day at normal speed

interface Result extends BattleOutcome { kind: 'campaign' | 'tutorial'; skipped?: boolean }

export class CampaignScene extends Phaser.Scene {
  private c!: Campaign;
  private grid!: Int16Array;
  private land: Phaser.GameObjects.Image | null = null;
  private ownersKey = '';
  private gfx!: Phaser.GameObjects.Graphics;
  private townText: Phaser.GameObjects.Text[] = [];
  private armyText = new Map<number, Phaser.GameObjects.Text>();
  private ui!: HTMLDivElement;
  private paused = true;
  private speed = 1;
  private chase: number | null = null; // an enemy army the player is marching on
  private lastSavedDay = -1;
  private pan: { x: number; y: number; sx: number; sy: number } | null = null;
  private hover: Territory | null = null;
  private hoverArmy: Army | null = null;
  private hoverFight: Fight | null = null;
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);
  private uiKey = '';

  constructor() {
    super('campaign');
  }

  init(data: { slot: number; result?: Result }) {
    this.c = loadCampaign(data.slot) ?? newCampaign(data.slot, 1 + Math.floor(Math.random() * 1e9));
    this.grid = territoryGrid(this.c);
    const r = data.result;
    if (r && r.kind === 'tutorial' && !this.c.tutorialDone) finishTutorial(this.c, r.survivors[0]);
    else if (r && r.kind === 'campaign' && this.c.encounter) settleEncounter(this.c, r);
    saveCampaign(this.c);
    this.paused = true;
    this.chase = null;
    this.ownersKey = '';
    this.armyText = new Map();
    this.townText = [];
    this.land = null;
  }

  create() {
    document.body.classList.add('in-campaign');
    this.cameras.main.setBackgroundColor('#4f6672');
    this.gfx = this.add.graphics().setDepth(5);
    this.buildUi();
    this.fitCamera();
    this.scale.on('resize', this.fitCamera, this);
    this.setupInput();
    this.drawLand();
    // For the browser tests: where towns and armies sit on screen, and the campaign itself.
    const screen = (p: { x: number; y: number }) => {
      const cam = this.cameras.main;
      return { x: (p.x - cam.worldView.x) * cam.zoom, y: (p.y - cam.worldView.y) * cam.zoom };
    };
    (window as unknown as { campTest?: unknown }).campTest = {
      towns: () => this.c.territories.map((t) => ({ id: t.id, name: t.name, owner: t.owner, garrison: t.garrison.length, ...screen(t) })),
      armies: () => this.c.armies.filter((a) => a.regiments.length).map((a) => ({ id: a.id, name: a.name, side: a.side, player: !!a.player, ...screen(a) })),
      state: () => this.c,
      refresh: () => this.renderUi(true),
    };
    this.events.once('shutdown', () => {
      document.body.classList.remove('in-campaign');
      window.removeEventListener('keydown', this.keyHandler);
      this.scale.off('resize', this.fitCamera, this);
      this.ui.remove();
    });
    this.renderUi(true);
  }

  // ---------- view ----------

  private fitCamera() {
    // Fit the country into the room the side panels leave, so no town starts hidden under one.
    const cam = this.cameras.main;
    const wide = cam.width > 760;
    const left = wide ? 306 : 8;
    const right = wide && cam.width - 306 - 286 > WORLD.width * 0.4 ? 286 : 8;
    const top = 56;
    const bottom = wide ? 8 : cam.height * 0.4 + 16;
    const zoom = Math.min((cam.width - left - right) / WORLD.width, (cam.height - top - bottom) / WORLD.height);
    cam.setZoom(zoom);
    cam.centerOn(WORLD.width / 2 - (left - right) / 2 / zoom, WORLD.height / 2 - (top - bottom) / 2 / zoom);
  }

  private setupInput() {
    this.input.mouse?.disableContextMenu();
    const cam = this.cameras.main;
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (p.button !== 0) { this.pan = { x: cam.scrollX, y: cam.scrollY, sx: p.x, sy: p.y }; return; }
      if (this.c.encounter || this.c.over) return;
      const w = { x: p.worldX, y: p.worldY };
      const me = playerArmy(this.c);
      if (!me.regiments.length || me.busyUntil !== undefined) return;
      const army = this.armyAt(w);
      if (army && !army.player) { this.chase = army.id; me.target = { x: army.x, y: army.y }; }
      else if (territoryAt(this.grid, w.x, w.y) >= 0) {
        this.chase = null;
        // Clicking near a town marches right into it.
        const t = territoryUnder(this.c, this.grid, w);
        me.target = Math.hypot(t.x - w.x, t.y - w.y) < 30 ? { x: t.x, y: t.y } : w;
      }
      this.paused = false;
      this.renderUi(true);
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (this.pan) {
        cam.scrollX = this.pan.x - (p.x - this.pan.sx) / cam.zoom;
        cam.scrollY = this.pan.y - (p.y - this.pan.sy) / cam.zoom;
        return;
      }
      const id = territoryAt(this.grid, p.worldX, p.worldY);
      this.hoverArmy = this.armyAt({ x: p.worldX, y: p.worldY });
      const zr = 1 / Math.max(0.6, cam.zoom);
      this.hoverFight = this.c.fights.find((f) => Math.hypot(f.x - p.worldX, f.y - 26 * zr - p.worldY) < 18 * zr) ?? null;
      this.hover = id >= 0 ? this.c.territories[id] : null;
      this.renderTip(p.x, p.y);
    });
    this.input.on('pointerup', () => { this.pan = null; });
    this.input.on('wheel', (p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => {
      const before = cam.getWorldPoint(p.x, p.y);
      cam.setZoom(Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.88 : 1.12), 0.3, 4));
      const after = cam.getWorldPoint(p.x, p.y);
      cam.scrollX += before.x - after.x;
      cam.scrollY += before.y - after.y;
    });
    window.addEventListener('keydown', this.keyHandler);
  }

  /** The army banner under a point of the map, if any. */
  private armyAt(w: { x: number; y: number }): Army | null {
    const r = 14 / Math.max(0.6, this.cameras.main.zoom) + 4;
    return this.c.armies.filter((a) => a.regiments.length && Math.hypot(a.x - w.x, a.y - w.y) < r).sort((a, b) => Math.hypot(a.x - w.x, a.y - w.y) - Math.hypot(b.x - w.x, b.y - w.y))[0] ?? null;
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === ' ') { e.preventDefault(); if (!this.c.encounter && !this.c.over) { this.paused = !this.paused; this.renderUi(true); } }
  }

  /** Paint the country: each territory in its owner's colour, borders darker, the sea round it. */
  private drawLand() {
    const key = this.c.territories.map((t) => t.owner).join('');
    if (key === this.ownersKey) return;
    this.ownersKey = key;
    const { cols, rows, cell } = GRID_SIZE;
    const canvas = document.createElement('canvas');
    canvas.width = WORLD.width;
    canvas.height = WORLD.height;
    const g = canvas.getContext('2d')!;
    const img = g.createImageData(WORLD.width, WORLD.height);
    const d = img.data;
    for (let y = 0; y < WORLD.height; y++) {
      const gy = Math.min(rows - 1, Math.floor(y / cell));
      for (let x = 0; x < WORLD.width; x++) {
        const gx = Math.min(cols - 1, Math.floor(x / cell));
        const id = this.grid[gy * cols + gx];
        // Grain, so the colours read like paint on paper.
        const n = ((x * 73856093) ^ (y * 19349663)) & 15;
        let rgb: [number, number, number];
        if (id < 0) rgb = SEA;
        else {
          rgb = OWNER_RGB[this.c.territories[id].owner];
          const right = gx < cols - 1 ? this.grid[gy * cols + gx + 1] : id;
          const down = gy < rows - 1 ? this.grid[(gy + 1) * cols + gx] : id;
          const edge = (x % cell === cell - 1 && right !== id) || (y % cell === cell - 1 && down !== id);
          if (edge) rgb = right < 0 || down < 0 ? [70, 66, 54] : [48, 44, 36];
        }
        const i = (y * WORLD.width + x) * 4;
        d[i] = rgb[0] + n - 8;
        d[i + 1] = rgb[1] + n - 8;
        d[i + 2] = rgb[2] + n - 8;
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    if (this.textures.exists('camp-land')) this.textures.remove('camp-land');
    this.textures.addCanvas('camp-land', canvas);
    this.land?.destroy();
    this.land = this.add.image(0, 0, 'camp-land').setOrigin(0, 0).setDepth(-10);
    for (const t of this.townText) t.destroy();
    this.townText = this.c.territories.map((t) => this.add.text(t.x, t.y - 16, t.name, {
      fontFamily: '"EB Garamond", Georgia, serif', fontSize: t.capital ? '20px' : '16px', fontStyle: t.capital ? 'bold' : '', color: '#fffaf0', stroke: '#2a2620', strokeThickness: 4,
    }).setOrigin(0.5, 1).setDepth(6));
  }

  // ---------- the loop ----------

  update(_time: number, delta: number) {
    const c = this.c;
    if (!this.paused && !c.encounter && !c.over) {
      const me = playerArmy(c);
      const chased = this.chase !== null ? c.armies.find((a) => a.id === this.chase && a.regiments.length) : undefined;
      const marching = !!me.target;
      if (chased) me.target = { x: chased.x, y: chased.y };
      else if (this.chase !== null) { this.chase = null; me.target = null; }
      let left = (Math.min(delta, 200) / 1000 / DAY_SECONDS) * this.speed;
      while (left > 0 && !c.encounter && !c.over) {
        const dt = Math.min(0.05, left);
        advance(c, this.grid, dt);
        left -= dt;
      }
      if (c.encounter || c.over) { this.paused = true; saveCampaign(c); }
      if (Math.floor(c.day) !== this.lastSavedDay) { this.lastSavedDay = Math.floor(c.day); saveCampaign(c); }
      // Arriving stops the clock so the player can give the next order; pressing Play again waits in place.
      if (marching && !me.target && !c.encounter && me.regiments.length) this.paused = true;
    }
    this.drawLand();
    this.draw();
    this.renderUi();
  }

  private draw() {
    const g = this.gfx;
    const c = this.c;
    const z = this.cameras.main.zoom;
    const px = (n: number) => n / Math.max(0.6, z);
    g.clear();
    for (const t of c.territories) {
      const r = t.capital ? px(9) : px(6);
      g.fillStyle(0x2a2620, 1);
      g.fillCircle(t.x, t.y, r + px(2));
      g.fillStyle(OWNER_HEX[t.owner], 1);
      g.fillCircle(t.x, t.y, r);
      if (t.capital) { g.lineStyle(px(2), 0xfffaf0, 1); g.strokeCircle(t.x, t.y, r + px(4)); }
      // Garrison pips.
      for (let i = 0; i < t.garrison.length; i++) { g.fillStyle(0xfffaf0, 0.9); g.fillRect(t.x - px(9) + i * px(4), t.y + r + px(3), px(3), px(3)); }
      // A town Ostmark is attacking: a pulsing red ring.
      if (t.owner === 0 && attackersOf(c, t).length) {
        const pulse = 0.5 + 0.5 * Math.sin(this.time.now / 250);
        g.lineStyle(px(3), 0xc0392b, 0.5 + 0.5 * pulse);
        g.strokeCircle(t.x, t.y, r + px(8 + pulse * 4));
      }
    }
    // Where Ostmark's attacks are heading.
    for (const a of c.armies) {
      if (a.side !== 1 || a.mission === undefined || !a.regiments.length) continue;
      const t = c.territories[a.mission];
      this.dashed(a, t, 0xc0392b, px);
    }
    const me = playerArmy(c);
    if (me.target && me.regiments.length) this.dashed(me, me.target, 0xfffaf0, px);
    // Battles under way: crossed swords, with a ring that fills as the fight goes on.
    for (const f of c.fights) {
      const r = px(15);
      const done = Phaser.Math.Clamp(1 - (f.endsAt - c.day) / 0.8, 0, 1);
      g.fillStyle(0x2a2620, 0.75);
      g.fillCircle(f.x, f.y - px(26), r);
      g.lineStyle(px(3), 0xc0392b, 1);
      g.beginPath();
      g.arc(f.x, f.y - px(26), r, -Math.PI / 2, -Math.PI / 2 + done * Math.PI * 2);
      g.strokePath();
      g.lineStyle(px(2.5), 0xfffaf0, 1);
      const s2 = px(7);
      g.lineBetween(f.x - s2, f.y - px(26) - s2, f.x + s2, f.y - px(26) + s2);
      g.lineBetween(f.x + s2, f.y - px(26) - s2, f.x - s2, f.y - px(26) + s2);
    }
    const seen = new Set<number>();
    for (const a of c.armies) {
      if (!a.regiments.length) continue;
      seen.add(a.id);
      this.drawArmy(a, px);
    }
    for (const [id, t] of this.armyText) if (!seen.has(id)) { t.destroy(); this.armyText.delete(id); }
  }

  private dashed(from: { x: number; y: number }, to: { x: number; y: number }, colour: number, px: (n: number) => number) {
    const g = this.gfx;
    g.lineStyle(px(2), colour, 0.8);
    const steps = Math.floor(Math.hypot(to.x - from.x, to.y - from.y) / px(10));
    for (let i = 0; i < steps; i += 2) {
      const a = i / steps;
      const b = Math.min(1, (i + 1) / steps);
      g.lineBetween(from.x + (to.x - from.x) * a, from.y + (to.y - from.y) * a, from.x + (to.x - from.x) * b, from.y + (to.y - from.y) * b);
    }
  }

  private drawArmy(a: Army, px: (n: number) => number) {
    const g = this.gfx;
    const mine = !!a.player;
    const r = px(mine ? 11 : 10);
    g.fillStyle(0x000000, 0.3);
    g.fillEllipse(a.x + px(2), a.y + px(3), r * 2.2, r * 1.2);
    g.fillStyle(a.side === 1 ? OWNER_HEX[1] : mine ? OWNER_HEX[0] : ALLY_HEX, 1);
    g.fillCircle(a.x, a.y, r);
    g.lineStyle(px(2.5), a.side === 0 ? 0xfffaf0 : 0x2a2620, 1);
    g.strokeCircle(a.x, a.y, r);
    if (this.hoverArmy === a) { g.lineStyle(px(2), 0xfffaf0, 0.9); g.strokeCircle(a.x, a.y, r + px(5)); }
    // A little flag on a pole.
    g.lineStyle(px(2), 0x2a2620, 1);
    g.lineBetween(a.x, a.y - r, a.x, a.y - r - px(16));
    g.fillStyle(mine ? 0xfffaf0 : a.side === 0 ? 0x9fb6dc : 0xd9a92b, 1);
    g.fillTriangle(a.x, a.y - r - px(16), a.x + px(12), a.y - r - px(12), a.x, a.y - r - px(8));
    let t = this.armyText.get(a.id);
    const label = `${a.regiments.length}`;
    if (!t) {
      t = this.add.text(a.x, a.y, label, { fontFamily: 'Inter, sans-serif', fontSize: '13px', fontStyle: 'bold', color: a.side === 0 ? '#fffaf0' : '#2a2620' }).setOrigin(0.5).setDepth(7);
      this.armyText.set(a.id, t);
    }
    t.setText(label).setPosition(a.x, a.y).setScale(1 / Math.max(0.6, this.cameras.main.zoom));
  }

  // ---------- panels ----------

  private buildUi() {
    const ui = document.createElement('div');
    ui.id = 'camp';
    ui.innerHTML = `
      <div class="panel c-top"></div>
      <div class="panel c-army"></div>
      <div class="panel c-log"></div>
      <div class="c-alerts"></div>
      <div class="panel c-tip"></div>
      <div class="c-modal"><div class="panel"></div></div>`;
    document.getElementById('app')!.appendChild(ui);
    this.ui = ui;
    ui.addEventListener('click', (e) => this.click(e));
  }

  private q(sel: string): HTMLElement {
    return this.ui.querySelector(sel) as HTMLElement;
  }

  private click(e: MouseEvent) {
    const el = (e.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
    if (!el) return;
    const c = this.c;
    const a = el.dataset.a!;
    if (a === 'pause') this.paused = !this.paused;
    if (a === 'speed') this.speed = this.speed === 1 ? 3 : 1;
    if (a === 'exit') { saveCampaign(c); window.dispatchEvent(new Event('wargame:campaignExit')); return; }
    if (a.startsWith('recruit-')) { const why = recruit(c, a.slice(8) as UnitTypeId); if (why) this.flash(why); }
    if (a === 'refit') { const why = refit(c); if (why) this.flash(why); }
    if (a.startsWith('dismiss-')) {
      if (el.dataset.sure) dismiss(c, Number(a.slice(8)));
      else { el.dataset.sure = '1'; el.textContent = 'Sure?'; return; }
    }
    if (a.startsWith('ride-') || a.startsWith('ignore-')) {
      const ride = a.startsWith('ride-');
      answerAlert(c, Number(a.slice(a.indexOf('-') + 1)), ride);
      if (ride) { this.chase = null; this.paused = false; }
    }
    if (a === 'fight') {
      const [mine, theirs] = encounterSides(c);
      const e = c.encounter!;
      saveCampaign(c);
      const setup: BattleSetup = {
        kind: 'campaign', slot: c.slot, armies: [structuredClone(mine), structuredClone(theirs)], mapSeed: encounterMap(c), title: encounterTitle(c),
        lord: encounterLord(c) ?? undefined, defending: e.kind === 'holdout',
        relief: e.relief ? { name: e.relief.name, at: RELIEF_SECONDS, regiments: structuredClone(e.relief.regiments) } : undefined,
      };
      window.dispatchEvent(new CustomEvent('wargame:battle', { detail: setup }));
      return;
    }
    if (a === 'auto') { autoResolveEncounter(c); saveCampaign(c); }
    if (a === 'retreat') { retreat(c); saveCampaign(c); }
    this.renderUi(true);
  }

  private flash(text: string) {
    const box = this.q('.c-army .why');
    if (box) { box.textContent = text; window.setTimeout(() => { box.textContent = ''; }, 2500); }
  }

  /** Redraw the panels when what they show has changed. */
  private renderUi(force = false) {
    const c = this.c;
    const me = playerArmy(c);
    const here = friendlyGround(c, this.grid);
    const key = JSON.stringify([Math.floor(c.day), c.gold, c.rank, me.regiments, here?.id, c.encounter, c.alerts, c.fights.length, c.over, this.paused, this.speed, c.log.length, c.log[c.log.length - 1]?.text]);
    if (!force && key === this.uiKey) return;
    this.uiKey = key;
    const income = ownedBy(c, 0).reduce((s, t) => s + t.income, 0);
    const rank = rankOf(c);
    const nextRank = RANKS[c.rank + 1];
    this.q('.c-top').innerHTML = `
      <span class="d">Day ${Math.floor(c.day) + 1}</span>
      <span>Gold <b>${Math.floor(c.gold)}</b> <small>+${income}/day</small></span>
      <span>${rank.name} <small>${c.wins} victor${c.wins === 1 ? 'y' : 'ies'}${nextRank ? `, ${nextRank.name} at ${nextRank.wins}` : ''}</small></span>
      <span>Towns <b>${ownedBy(c, 0).length}</b> <small>of ${c.territories.length}</small></span>
      <button data-a="pause" class="${this.paused ? '' : 'on'}">${this.paused ? 'Play' : 'Pause'}</button>
      <button data-a="speed">${this.speed}×</button>
      <button data-a="exit">Save &amp; exit</button>`;
    const regs = me.regiments.map((r, i) => {
      const pct = Math.round((r.men / UNIT_TYPES[r.type].men) * 100);
      const exp = experienceOf({ xp: r.xp });
      const pips = ['green', 'trained', 'veteran', 'elite'].indexOf(exp);
      return `<div class="reg"><span class="t">${UNIT_TYPES[r.type].label}</span><span class="pips" title="${exp}">${'●'.repeat(pips)}${'○'.repeat(3 - pips)}</span>
        <span class="bar"><span style="width:${pct}%"></span></span><span class="m">${Math.round(r.men)}</span><button data-a="dismiss-${i}" title="Dismiss this regiment">×</button></div>`;
    }).join('');
    const shop = (Object.keys(RECRUIT_COST) as UnitTypeId[]).map((t) => `<button data-a="recruit-${t}" ${!here ? 'disabled' : ''} title="${UNIT_TYPES[t].label}: ${UNIT_TYPES[t].men} men">${UNIT_TYPES[t].label} <small>${RECRUIT_COST[t]}g</small></button>`).join('');
    const cost = refitCost(c);
    this.q('.c-army').innerHTML = `
      <div class="h">Your army <small>${me.regiments.length} of ${rank.regiments} regiments · strength ${Math.round(strength(me.regiments))}</small></div>
      ${me.regiments.length ? regs : '<p class="muted">Your army has been destroyed. A new one will gather at the capital.</p>'}
      <div class="sub">${here ? `Recruit at ${here.name}` : 'Recruit and refit in towns you hold'}</div>
      <div class="shop">${shop}</div>
      <button data-a="refit" ${!here || !cost ? 'disabled' : ''}>Refit to full strength <small>${cost}g</small></button>
      <div class="why"></div>
      <p class="muted">Click the map to march. Click an army to go after it. Walk into an Ostmark town to storm it. Hover over an army or town to see its troops and your chance. Press Play while standing still to wait. ${'<kbd>Space</kbd>'} pauses.</p>`;
    this.q('.c-log').innerHTML = `<div class="h">News</div><div class="goal">Take <b>${c.territories.find((t) => t.capital && t.owner !== 0)?.name ?? 'Ostgard'}</b>, Ostmark's capital, to win the war.</div>` +
      c.log.slice(-9).reverse().map((l) => `<div class="l ${l.tone}"><span>Day ${l.day + 1}</span> ${l.text}</div>`).join('');
    this.renderModal();
    if (c.encounter) this.q('.c-tip').style.display = 'none';
    this.renderAlerts();
  }

  private renderModal() {
    const c = this.c;
    const modal = this.q('.c-modal');
    const box = modal.querySelector('.panel') as HTMLElement;
    if (c.over) {
      modal.style.display = 'flex';
      box.innerHTML = c.over === 'won'
        ? `<h2>Victory!</h2><p>Ostgard has fallen and Ostmark sues for peace. The war is won in ${Math.floor(c.day) + 1} days.</p><button data-a="exit">Back to the title</button>`
        : `<h2>Defeat</h2><p>Ostmark has taken Valdhaven. The war is lost.</p><button data-a="exit">Back to the title</button>`;
      return;
    }
    const e = c.encounter;
    if (!e) { modal.style.display = 'none'; return; }
    const [mine, theirs] = encounterSides(c);
    const t = c.territories[e.territory];
    const sa = strength(mine);
    const sb = strength(theirs);
    const lord = encounterLord(c);
    const mineAll = e.relief ? [...mine, ...e.relief.regiments] : mine;
    const chance = Math.round(winChance(mineAll, theirs) * 100);
    const allyNames = e.allies.map((id) => armyById(c, id)?.lord).filter(Boolean);
    const intro = {
      field: e.fight !== undefined ? `${allyNames.length ? allyNames.join(' and ') : 'Our lords'} ${allyNames.length > 1 ? 'are' : 'is'} already fighting ${encounterTitle(c)}. We join the battle.` : `${encounterTitle(c)} ${e.attacking ? 'stands in our way' : 'has caught up with us'}.`,
      assault: `${t.name} is held by Ostmark${theirs.length ? `: ${troopList(theirs)}` : ''}. We must storm it.`,
      relief: `${encounterTitle(c)} is besieging ${t.name}. Drive them off and the town is saved; lose and it falls.`,
      holdout: `${encounterTitle(c)} is storming ${t.name}, with us inside. Hold the town until ${e.relief ? `<b>${e.relief.name}</b> arrives, in about ${Math.round(RELIEF_SECONDS / 60)} minutes of battle` : 'they give up'}.`,
    }[e.kind];
    modal.style.display = 'flex';
    box.innerHTML = `
      <h2>${{ field: 'Battle', assault: 'Assault', relief: 'Relieve', holdout: 'Hold' }[e.kind]} ${e.kind === 'field' ? `near ${t.name}` : t.name}</h2>
      <p>${intro}</p>
      ${lord ? `<p class="lord"><b>${lord}</b> leads them in person. Kill their general and the army breaks: ${lord} is taken for ransom.</p>` : ''}
      <table><tr><td>Our side${allyNames.length ? `<br><small>with ${allyNames.join(' and ')}</small>` : ''}${e.garrison === 0 ? `<br><small>and the garrison</small>` : ''}</td><td>${troopList(mine)}</td><td><b>${Math.round(sa)}</b></td></tr>
      ${e.relief ? `<tr><td>Coming to help</td><td>${e.relief.name}: ${troopList(e.relief.regiments)}</td><td><b>${Math.round(strength(e.relief.regiments))}</b></td></tr>` : ''}
      <tr><td>${encounterTitle(c)}</td><td>${troopList(theirs)}</td><td><b>${Math.round(sb)}</b></td></tr></table>
      <p>Chance of winning if settled at once: <b class="${chance >= 55 ? 'good' : chance < 45 ? 'bad' : ''}">${chance}%</b>.</p>
      <div class="btns"><button data-a="fight" class="on">Fight the battle</button><button data-a="auto">Settle it at once</button>${e.kind === 'holdout' ? '' : '<button data-a="retreat">Fall back</button>'}</div>`;
  }

  /** Notices of Ostmark's attacks: small, and they do not stop the clock. */
  private renderAlerts() {
    const c = this.c;
    const me = playerArmy(c);
    this.q('.c-alerts').innerHTML = c.alerts.slice(-3).map((al) => {
      const i = c.alerts.indexOf(al);
      const t = c.territories[al.territory];
      const foe = armyById(c, al.army);
      const days = Math.max(0.5, Math.round((Math.hypot(me.x - t.x, me.y - t.y) / 90) * 2) / 2);
      return `<div class="panel al"><span><b>${foe?.lord ?? 'Ostmark'}</b> is marching on <b>${t.name}</b>${me.regiments.length ? ` <small>(${days} days' ride)</small>` : ''}</span>
        <button data-a="ride-${i}" class="on">Ride there</button><button data-a="ignore-${i}" title="Dismiss">×</button></div>`;
    }).join('');
  }

  private renderTip(x: number, y: number) {
    const tip = this.q('.c-tip');
    const c = this.c;
    const a = this.hoverArmy;
    const t = this.hover;
    const f = this.hoverFight;
    if (f && !this.pan && !c.encounter) {
      tip.style.display = 'block';
      tip.style.left = `${Math.min(x + 16, window.innerWidth - 300)}px`;
      tip.style.top = `${y + 12}px`;
      const side = (ids: number[]) => ids.map((id) => armyById(c, id)).filter((b): b is Army => !!b && b.regiments.length > 0);
      const [ours, theirs] = [side(f.sides[0]), side(f.sides[1])];
      const town = f.town !== null ? c.territories[f.town] : null;
      const mine = [...ours.flatMap((b) => b.regiments), ...(town?.owner === 0 ? town.garrison : [])];
      const foes = [...theirs.flatMap((b) => b.regiments), ...(town?.owner === 1 ? town.garrison : [])];
      const hours = Math.max(1, Math.round((f.endsAt - c.day) * 24));
      const pct = Math.round(winChance(mine, foes) * 100);
      tip.innerHTML = `<b>Battle ${town ? `for ${town.name}` : `near ${c.territories[f.territory].name}`}</b>
        <div class="troops"><div><span>${ours.map((b) => b.lord).join(', ') || 'Nobody'}${town?.owner === 0 ? ' and the garrison' : ''}</span><span>${Math.round(strength(mine))}</span></div>
        <div><span>${theirs.map((b) => b.lord).join(', ')}</span><span>${Math.round(strength(foes))}</span></div></div>
        <small>Our side's chance: ${pct}%. Decided in about ${hours} hours. Ride here to join it.</small>`;
      return;
    }
    if ((!a && !t) || this.pan || c.encounter || c.over) { tip.style.display = 'none'; return; }
    tip.style.display = 'block';
    tip.style.left = `${Math.min(x + 16, window.innerWidth - 300)}px`;
    tip.style.top = `${y + 12}px`;
    const odds = (target: Army | Territory) => {
      const me = playerArmy(c);
      if (!me.regiments.length) return '';
      const p = previewAttack(c, target);
      const pct = Math.round(p.chance * 100);
      return `<div class="odds ${pct >= 55 ? 'good' : pct < 45 ? 'bad' : ''}">Your chance if you attack: <b>${pct}%</b><br><small>${Math.round(strength(p.mine))} against ${Math.round(strength(p.theirs))}${p.allies.length ? `, with ${p.allies.map((l) => l.lord).join(' and ')}` : ''}</small></div>`;
    };
    if (a) {
      const doing = a.player ? '' : a.siege !== undefined ? `Besieging ${c.territories[a.siege].name}` : a.mission !== undefined ? `${a.side === 1 ? 'Marching on' : 'Riding to help'} ${c.territories[a.mission].name}` : a.resting ? 'Resting to recover' : a.side === 1 ? 'On the frontier' : 'Keeping watch';
      tip.innerHTML = `<b>${a.name}</b>${a.player ? '' : `<br><small>${a.side === 0 ? 'Allied lord of Valdmark' : 'Ostmark'}${doing ? ` · ${doing}` : ''}</small>`}
        <div class="troops">${regimentRows(a.regiments)}</div>
        <small>Strength ${Math.round(strength(a.regiments))}</small>${a.side === 1 ? odds(a) : ''}`;
      return;
    }
    const tt = t!;
    const under = attackersOf(c, tt);
    tip.innerHTML = `<b>${tt.name}</b>${tt.capital ? ' (capital)' : ''}<br><small>${OWNER_NAMES[tt.owner]} · ${tt.income} gold a day</small>
      <div class="troops">${tt.garrison.length ? regimentRows(tt.garrison) : '<small>No garrison</small>'}</div>
      ${under.length ? `<div class="odds bad">Under attack by ${under.map((u) => u.lord).join(' and ')}${siegeLeft(c, tt)}</div>` : ''}${tt.owner === 1 ? odds(tt) : ''}`;
  }
}

/** How long a besieged town has before it is stormed, as words. */
function siegeLeft(c: Campaign, t: Territory): string {
  const b = c.armies.find((a) => a.siege === t.id && a.busyUntil !== undefined && a.fight === undefined);
  if (!b) return c.fights.some((f) => f.town === t.id) ? '<br>Being stormed now' : '';
  const days = Math.max(0, b.busyUntil! - c.day);
  return `<br>Stormed in ${days >= 1 ? `${Math.round(days * 2) / 2} days` : `${Math.max(1, Math.round(days * 24))} hours`}`;
}

/** "2 line infantry, 1 artillery" */
function troopList(regs: ArmyEntry[]): string {
  const n: Partial<Record<UnitTypeId, number>> = {};
  for (const r of regs) n[r.type] = (n[r.type] ?? 0) + 1;
  return Object.entries(n).map(([k, v]) => `${v} ${UNIT_TYPES[k as UnitTypeId].label.toLowerCase()}`).join(', ') || 'nothing';
}

/** One line per kind of regiment: how many, and how many men. */
function regimentRows(regs: ArmyEntry[]): string {
  const n = new Map<UnitTypeId, { k: number; men: number }>();
  for (const r of regs) { const e = n.get(r.type) ?? { k: 0, men: 0 }; e.k++; e.men += r.men; n.set(r.type, e); }
  return [...n].map(([type, e]) => `<div><span>${e.k} × ${UNIT_TYPES[type].label}</span><span>${Math.round(e.men).toLocaleString()} men</span></div>`).join('');
}
