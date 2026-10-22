import Phaser from 'phaser';
import { UNIT_TYPES, UnitTypeId } from '../sim/config';
import {
  Army, Campaign, GRID_SIZE, OWNER_NAMES, RANKS, RECRUIT_COST, Territory, WORLD, advance, autoResolveEncounter, dismiss, encounterMap,
  encounterSides, encounterTitle, finishTutorial, friendlyGround, loadCampaign, newCampaign, ownedBy, playerArmy, rankOf, recruit, refit,
  refitCost, retreat, saveCampaign, settleEncounter, strength, territoryAt, territoryGrid, territoryUnder,
} from '../sim/strategic';
import { ArmyEntry, experienceOf } from '../sim/world';
import type { BattleSetup } from './BattleScene';

/**
 * The campaign map. Your army is a banner you march across the country by clicking; time runs while you march and
 * stops when something needs you. Walk into a town you do not hold to fight its garrison, or meet an enemy army in
 * the field. Battles can be fought out on the battlefield or settled at once.
 */

const OWNER_RGB: [number, number, number][] = [[93, 111, 143], [199, 154, 58], [143, 148, 115]];
const OWNER_HEX = [0x2b2e38, 0xd9a92b, 0x6b6e58];
const SEA: [number, number, number] = [107, 135, 150];
const DAY_SECONDS = 2; // real seconds per campaign day at normal speed

interface Result { kind: 'campaign' | 'tutorial'; won: boolean; survivors: [ArmyEntry[], ArmyEntry[]]; skipped?: boolean }

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
    else if (r && r.kind === 'campaign' && this.c.encounter) settleEncounter(this.c, r.won, r.survivors);
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
    // For the browser tests: where each town sits on screen.
    (window as unknown as { campTowns?: () => unknown }).campTowns = () => this.c.territories.map((t) => {
      const cam = this.cameras.main;
      return { name: t.name, owner: t.owner, garrison: t.garrison.length, x: (t.x - cam.worldView.x) * cam.zoom, y: (t.y - cam.worldView.y) * cam.zoom };
    });
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
      if (!me.regiments.length) return;
      const foe = this.c.armies.find((a) => a.side === 1 && a.regiments.length && Math.hypot(a.x - w.x, a.y - w.y) < 22 / cam.zoom * 0.6 + 14);
      if (foe) { this.chase = foe.id; me.target = { x: foe.x, y: foe.y }; }
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
    }
    const me = playerArmy(c);
    if (me.target && me.regiments.length) {
      g.lineStyle(px(2), 0xfffaf0, 0.8);
      const steps = Math.floor(Math.hypot(me.target.x - me.x, me.target.y - me.y) / px(10));
      for (let i = 0; i < steps; i += 2) {
        const a = i / steps;
        const b = Math.min(1, (i + 1) / steps);
        g.lineBetween(me.x + (me.target.x - me.x) * a, me.y + (me.target.y - me.y) * a, me.x + (me.target.x - me.x) * b, me.y + (me.target.y - me.y) * b);
      }
    }
    const seen = new Set<number>();
    for (const a of c.armies) {
      if (!a.regiments.length) continue;
      seen.add(a.id);
      this.drawArmy(a, px);
    }
    for (const [id, t] of this.armyText) if (!seen.has(id)) { t.destroy(); this.armyText.delete(id); }
  }

  private drawArmy(a: Army, px: (n: number) => number) {
    const g = this.gfx;
    const mine = a.side === 0;
    const r = px(mine ? 11 : 10);
    g.fillStyle(0x000000, 0.3);
    g.fillEllipse(a.x + px(2), a.y + px(3), r * 2.2, r * 1.2);
    g.fillStyle(OWNER_HEX[a.side], 1);
    g.fillCircle(a.x, a.y, r);
    g.lineStyle(px(2.5), mine ? 0xfffaf0 : 0x2a2620, 1);
    g.strokeCircle(a.x, a.y, r);
    // A little flag on a pole.
    g.lineStyle(px(2), 0x2a2620, 1);
    g.lineBetween(a.x, a.y - r, a.x, a.y - r - px(16));
    g.fillStyle(mine ? 0xfffaf0 : 0xd9a92b, 1);
    g.fillTriangle(a.x, a.y - r - px(16), a.x + px(12), a.y - r - px(12), a.x, a.y - r - px(8));
    let t = this.armyText.get(a.id);
    const label = `${a.regiments.length}`;
    if (!t) {
      t = this.add.text(a.x, a.y, label, { fontFamily: 'Inter, sans-serif', fontSize: '13px', fontStyle: 'bold', color: mine ? '#fffaf0' : '#2a2620' }).setOrigin(0.5).setDepth(7);
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
    if (a === 'fight') {
      const [mine, theirs] = encounterSides(c);
      saveCampaign(c);
      const setup: BattleSetup = { kind: 'campaign', slot: c.slot, armies: [structuredClone(mine), structuredClone(theirs)], mapSeed: encounterMap(c), title: encounterTitle(c) };
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
    const key = JSON.stringify([Math.floor(c.day), c.gold, c.rank, me.regiments, here?.id, c.encounter, c.over, this.paused, this.speed, c.log.length]);
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
      <p class="muted">Click the map to march. Click an enemy army to go after it. Walk into a town you do not hold to attack it. Press Play while standing still to wait. ${'<kbd>Space</kbd>'} pauses.</p>`;
    this.q('.c-log').innerHTML = `<div class="h">News</div><div class="goal">Take <b>${c.territories.find((t) => t.capital && t.owner !== 0)?.name ?? 'Ostgard'}</b>, Ostmark's capital, to win the war.</div>` +
      c.log.slice(-9).reverse().map((l) => `<div class="l ${l.tone}"><span>Day ${l.day + 1}</span> ${l.text}</div>`).join('');
    this.renderModal();
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
    const list = (regs: ArmyEntry[]) => {
      const n: Partial<Record<UnitTypeId, number>> = {};
      for (const r of regs) n[r.type] = (n[r.type] ?? 0) + 1;
      return Object.entries(n).map(([k, v]) => `${v} ${UNIT_TYPES[k as UnitTypeId].label.toLowerCase()}`).join(', ');
    };
    const sa = strength(mine);
    const sb = strength(theirs);
    const odds = sa / (sa + sb);
    const word = odds > 0.65 ? 'in our favour' : odds > 0.55 ? 'slightly in our favour' : odds > 0.45 ? 'even' : odds > 0.35 ? 'against us' : 'badly against us';
    modal.style.display = 'flex';
    box.innerHTML = `
      <h2>Battle at ${t.name}</h2>
      <p>${e.enemyArmy !== null ? `${encounterTitle(c)} ${e.attacking ? 'stands in our way' : 'has caught up with us'}.` : `${t.name} is held by a garrison of ${OWNER_NAMES[t.owner] === 'Neutral' ? 'a neutral lord' : 'Ostmark'}.`}</p>
      <table><tr><td>Our army</td><td>${list(mine)}</td><td><b>${Math.round(sa)}</b></td></tr>
      <tr><td>${encounterTitle(c)}</td><td>${list(theirs)}</td><td><b>${Math.round(sb)}</b></td></tr></table>
      <p>The odds look <b>${word}</b>.</p>
      <div class="btns"><button data-a="fight" class="on">Fight the battle</button><button data-a="auto">Settle it at once</button><button data-a="retreat">Fall back</button></div>`;
  }

  private renderTip(x: number, y: number) {
    const tip = this.q('.c-tip');
    const t = this.hover;
    if (!t || this.pan) { tip.style.display = 'none'; return; }
    const g = t.garrison.length ? t.garrison.map((r) => UNIT_TYPES[r.type].label).join(', ') : 'none';
    const army = this.c.armies.find((a) => a.regiments.length && a.side === 1 && territoryAt(this.grid, a.x, a.y) === t.id);
    tip.style.display = 'block';
    tip.style.left = `${x + 16}px`;
    tip.style.top = `${y + 12}px`;
    tip.innerHTML = `<b>${t.name}</b>${t.capital ? ' (capital)' : ''}<br>${OWNER_NAMES[t.owner]} · ${t.income} gold a day<br>Garrison: ${g}${army ? `<br>${army.name}: ${army.regiments.length} regiments` : ''}`;
  }
}

