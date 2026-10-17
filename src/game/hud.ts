import { CALLIN_ORDER, Formation, RULES, UNIT_TYPES, UnitTypeId } from '../sim/config';
import { Unit, World, formationOf } from '../sim/world';

export interface HudHandlers {
  callIn(type: UnitTypeId): void;
  requisition(): void;
  ready(): void;
  hold(): void;
  formation(f?: Formation): void;
  aim(): void;
  ceaseFire(): void;
  restart(): void;
  resign(): void;
  pause(): void;
  speed(delta: number): void;
}

export interface UiState {
  selected: Unit[];
  pendingCallIn: UnitTypeId | null;
  paused: boolean;
  speed: number;
}

const PLAYER = 0;

export function clock(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

/** Only touch the DOM when the content actually changed, so buttons are not rebuilt under the cursor. */
function setHtml(e: HTMLElement, html: string) {
  if (e.dataset.html === html) return;
  e.dataset.html = html;
  e.innerHTML = html;
}

const FORMATION_LABEL: Record<Formation, string> = {
  marching: 'Marching', formation: 'Formation', fortified: 'Fortified',
};

/** The heads-up display, built from plain HTML over the game canvas. */
export class Hud {
  private top: HTMLDivElement;
  private economy: HTMLDivElement;
  private captions: HTMLDivElement;
  private cards = new Map<UnitTypeId, HTMLDivElement>();
  private queue: HTMLDivElement;
  private selection: HTMLDivElement;
  private deploy: HTMLDivElement;
  private tooltip: HTMLDivElement;
  private end: HTMLDivElement;
  private controls: HTMLDivElement;
  private help: HTMLDivElement;
  private endShown = false;

  constructor(root: HTMLElement, private h: HudHandlers) {
    this.top = el('div', 'panel');
    this.top.id = 'top';
    this.economy = el('div', 'panel');
    this.economy.id = 'economy';
    this.captions = el('div');
    this.captions.id = 'captions';
    this.selection = el('div', 'panel');
    this.selection.id = 'selection';
    this.deploy = el('div', 'panel');
    this.deploy.id = 'deploy';
    this.tooltip = el('div', 'panel');
    this.tooltip.id = 'tooltip';
    this.end = el('div');
    this.end.id = 'end';
    this.controls = el('div', 'panel');
    this.controls.id = 'controls';
    this.help = el('div', 'panel');
    this.help.id = 'help';

    const bar = el('div', 'panel');
    bar.id = 'callins';
    for (const type of CALLIN_ORDER) {
      const def = UNIT_TYPES[type];
      const card = el('div', 'card', `<div class="t">${def.label}</div><div class="c">${def.cost} manpower · ${def.arrival}s</div><div class="why"></div><div class="cool"></div>`);
      card.title = `Call in ${def.label}: ${def.cost} manpower, arrives after ${def.arrival}s, then ${def.cooldown}s before another`;
      card.addEventListener('click', () => this.h.callIn(type));
      this.cards.set(type, card);
      bar.appendChild(card);
    }
    this.queue = el('div');
    this.queue.id = 'queue';
    bar.appendChild(this.queue);

    this.controls.innerHTML = `<button data-a="pause">Pause</button><button data-a="slower">−</button><span class="spd" style="align-self:center;min-width:28px;text-align:center">1×</span><button data-a="faster">+</button><button data-a="help">?</button><button data-a="resign">Resign</button>`;
    this.controls.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).dataset.a;
      if (a === 'pause') this.h.pause();
      if (a === 'slower') this.h.speed(-1);
      if (a === 'faster') this.h.speed(1);
      if (a === 'help') this.help.style.display = this.help.style.display === 'none' ? 'block' : 'none';
      if (a === 'resign') {
        // Two clicks to resign, so a stray click never ends the battle.
        const b = e.target as HTMLButtonElement;
        if (b.dataset.confirm === '1') {
          this.h.resign();
          return;
        }
        b.dataset.confirm = '1';
        b.textContent = 'Confirm resign?';
        window.setTimeout(() => { b.dataset.confirm = ''; b.textContent = 'Resign'; }, 3000);
      }
    });

    this.help.innerHTML = `
      <h3>How to play</h3>
      <p>Hold more objectives and break the enemy army's morale before 30:00.</p>
      <p><kbd>Left-click</kbd> select · <kbd>drag</kbd> box select · <kbd>Shift</kbd> add<br>
      <kbd>Right-click</kbd> move, or attack an enemy<br>
      <kbd>Right-drag</kbd> form a line along the drag<br>
      <kbd>F</kbd> cycle formation, or <kbd>1</kbd> march · <kbd>2</kbd> formation · <kbd>3</kbd> fortify · <kbd>H</kbd> hold<br>
      Artillery: <kbd>B</kbd> then click to place its fire circle (or right-click an enemy) · <kbd>X</kbd> cease fire<br>
      <kbd>Space</kbd> pause · <kbd>+</kbd>/<kbd>−</kbd> speed<br>
      <kbd>WASD</kbd> or arrows pan · wheel zoom</p>
      <p><b>Marching</b> is fastest but fights badly; troops march automatically on any move out of combat and form up when they arrive. <b>Formation</b> is the fighting stance. <b>Fortified</b> barely moves but takes less damage and loses morale more slowly: dug in properly out of combat (${RULES.fortifyTime}s), or a weaker hasty position if already fighting. Shells hit fortified troops harder.</p>
      <p>Artillery stops and sets up when you give it a target, and only fires once set up. Units in woods are hidden unless your troops are within ${RULES.woodsSpotRange}m; firing guns give themselves away.</p>
      <p>Call in troops from the bar at the bottom, then click inside your deployment zone (the shaded strip on the left). They march in from the map edge.</p>
      <p><button data-a="close">Got it</button></p>`;
    this.help.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).dataset.a === 'close') this.help.style.display = 'none';
    });

    this.economy.innerHTML = `<span class="mp"></span><button data-a="req" title="+${RULES.requisitionAmount} manpower once, costs ${RULES.requisitionMoraleCost} army morale">Requisition</button><span class="cap" style="color:var(--muted)"></span>`;
    this.deploy.innerHTML = `<div class="h">Deploy your army</div><div style="margin:4px 0 8px;color:var(--muted)">Right-click to reposition regiments inside your zone. Spend your budget on extra troops.</div><button data-a="ready">Start battle</button>`;
    this.selection.innerHTML = `<div class="info"></div><div class="btns"><button data-a="hold">Hold (H)</button></div><div class="btns fm"><button data-a="fm-marching">March (1)</button><button data-a="fm-formation">Formation (2)</button><button data-a="fm-fortified">Fortify (3)</button></div><div class="btns guns"><button data-a="aim">Aim fire (B)</button><button data-a="cease">Cease fire (X)</button></div>`;
    this.economy.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).dataset.a === 'req') this.h.requisition();
    });
    this.deploy.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).dataset.a === 'ready') this.h.ready();
    });
    this.selection.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).dataset.a;
      if (a === 'hold') this.h.hold();
      if (a?.startsWith('fm-')) this.h.formation(a.slice(3) as Formation);
      if (a === 'aim') this.h.aim();
      if (a === 'cease') this.h.ceaseFire();
    });
    this.end.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).dataset.a === 'again') this.h.restart();
    });

    for (const e of [this.top, this.economy, this.captions, bar, this.selection, this.deploy, this.controls, this.help, this.tooltip, this.end]) root.appendChild(e);
  }

  update(world: World, ui: UiState) {
    const [me, them] = world.sides;
    const mb = (v: number, c: string) => `<div class="bar"><div style="width:${Math.max(0, v)}%;background:${c}"></div></div>`;
    const clockText = world.phase === 'deploy' ? clock(world.deployLeft) : clock(RULES.matchLength - world.time);
    const sub = world.phase === 'deploy' ? 'deployment' : world.time >= RULES.finalPushAt ? 'final push · points ×2' : 'remaining';
    setHtml(this.top, `
      <div class="army"><div class="name serif"><span>${me.nation}</span><span>${me.score.toFixed(0)} pts</span></div>${mb(me.armyMorale, '#2b2e38')}<div style="font-size:11px;color:var(--muted)">Army morale ${me.armyMorale.toFixed(0)}</div></div>
      <div id="clock"><div class="time serif">${clockText}</div><div class="sub">${sub}${ui.paused ? ' · paused' : ''}</div></div>
      <div class="army"><div class="name serif"><span>${them.nation}</span><span>${them.score.toFixed(0)} pts</span></div>${mb(them.armyMorale, '#d9a92b')}<div style="font-size:11px;color:var(--muted)">Army morale ${them.armyMorale.toFixed(0)}</div></div>`);

    const income = world.phase === 'deploy' ? 'deployment budget' : `+${world.incomePerMinute(PLAYER).toFixed(0)}/min`;
    setHtml(this.economy.querySelector('.mp') as HTMLElement, `<b>Manpower ${Math.floor(me.manpower)}</b> <span style="color:var(--muted)">${income}</span>`);
    (this.economy.querySelector('button') as HTMLButtonElement).disabled = world.phase !== 'battle' || me.requisitionUsed;
    (this.economy.querySelector('.cap') as HTMLElement).textContent = `Army ${world.fieldCount(PLAYER)}/${RULES.fieldCap}`;

    for (const [type, card] of this.cards) {
      const why = world.callInBlocker(PLAYER, type);
      card.classList.toggle('off', why !== null);
      card.classList.toggle('active', ui.pendingCallIn === type);
      (card.querySelector('.why') as HTMLElement).textContent = why ?? (ui.pendingCallIn === type ? 'Click your zone' : '');
      const cd = Math.max(0, me.cooldowns[type] - world.time);
      (card.querySelector('.cool') as HTMLElement).style.width = world.phase === 'battle' && cd > 0 ? `${(cd / UNIT_TYPES[type].cooldown) * 100}%` : '0';
    }
    setHtml(this.queue, me.queue.length
      ? me.queue.map((c) => `<div>${UNIT_TYPES[c.type].label} in ${Math.ceil(c.readyAt - world.time)}s</div>`).join('')
      : `<div>${world.phase === 'deploy' ? 'Deploying: units appear at once' : 'No troops on the way'}</div>`);

    this.deploy.style.display = world.phase === 'deploy' ? 'block' : 'none';
    const readyBtn = this.deploy.querySelector('button') as HTMLButtonElement;
    readyBtn.textContent = me.ready ? 'Waiting…' : 'Start battle';
    readyBtn.disabled = me.ready;

    const controlsSpd = this.controls.querySelector('.spd') as HTMLElement;
    controlsSpd.textContent = `${ui.speed}×`;
    (this.controls.querySelector('[data-a="pause"]') as HTMLElement).textContent = ui.paused ? 'Resume' : 'Pause';

    this.updateSelection(ui.selected);
    this.updateCaptions(world);
    this.updateEnd(world);
  }

  private updateSelection(sel: Unit[]) {
    if (sel.length === 0) {
      this.selection.style.display = 'none';
      return;
    }
    this.selection.style.display = 'block';
    for (const f of ['marching', 'formation', 'fortified'] as Formation[]) {
      (this.selection.querySelector(`[data-a="fm-${f}"]`) as HTMLElement).classList.toggle('on', sel.every((u) => u.formation === f));
    }
    (this.selection.querySelector('.guns') as HTMLElement).style.display = sel.some((u) => u.type === 'artillery') ? 'flex' : 'none';
    const info = this.selection.querySelector('.info') as HTMLElement;
    if (sel.length === 1) {
      const u = sel[0];
      setHtml(info, `<div class="n">${u.name}</div>${this.unitRows(u)}`);
    } else {
      const men = sel.reduce((a, u) => a + u.men, 0);
      const morale = sel.reduce((a, u) => a + u.morale, 0) / sel.length;
      setHtml(info, `<div class="n">${sel.length} regiments</div><div class="row"><span>Men</span><span>${Math.round(men).toLocaleString()}</span></div><div class="row"><span>Average morale</span><span>${morale.toFixed(0)}</span></div>`);
    }
  }

  private unitRows(u: Unit): string {
    const order = u.state === 'routing' ? 'Routing!' : u.order.kind === 'move' ? 'Moving' : u.order.kind === 'attack' ? (u.order.retaliate ? 'Returning fire' : 'Attacking') : u.holdPosition ? 'Holding position' : 'Idle';
    return `<div class="row"><span>${UNIT_TYPES[u.type].label}</span><span>${this.formationText(u)}</span></div>
      <div class="row"><span>Men</span><span>${Math.round(u.men).toLocaleString()} / ${u.maxMen.toLocaleString()}</span></div>
      <div class="row"><span>Morale</span><span style="color:${u.morale < RULES.waveringAt ? 'var(--bad)' : 'inherit'}">${u.morale.toFixed(0)}${u.state === 'wavering' ? ' (wavering)' : ''}</span></div>
      <div class="row"><span>Order</span><span>${order}</span></div>`;
  }

  private formationText(u: Unit): string {
    if (u.marching) return 'Marching (auto)';
    if (u.formation === 'fortified' && formationOf(u) !== 'fortified') return u.type === 'artillery' ? 'Setting up guns…' : 'Digging in…';
    if (u.formation === 'fortified' && u.hasty) return 'Fortified (hasty)';
    return FORMATION_LABEL[u.formation];
  }

  showTooltip(u: Unit | null, x: number, y: number) {
    if (!u) {
      this.tooltip.style.display = 'none';
      return;
    }
    this.tooltip.style.display = 'block';
    this.tooltip.style.left = `${x + 16}px`;
    this.tooltip.style.top = `${y + 16}px`;
    setHtml(this.tooltip, `<div class="n">${u.name}</div>${this.unitRows(u)}`);
  }

  private updateCaptions(world: World) {
    const fresh = world.events.filter((e) => e.t > world.time - 6 && (e.side === -1 || e.side === PLAYER || /takes|fled|destroyed|breaks|requisitions/.test(e.text))).slice(-4);
    const key = fresh.map((e) => e.t + e.text).join('|');
    if (key === this.captions.dataset.key) return;
    this.captions.dataset.key = key;
    this.captions.innerHTML = fresh.map((e) => `<div>${e.text}</div>`).join('');
  }

  private updateEnd(world: World) {
    if (world.phase !== 'ended' || !world.result || this.endShown) return;
    this.endShown = true;
    const r = world.result;
    const title = r.winner === -1 ? 'Draw' : r.winner === PLAYER ? 'Victory' : 'Defeat';
    const [a, b] = world.sides;
    this.end.innerHTML = `<div class="panel"><h2>${title}</h2><p>${r.reason} at ${clock(world.time)}.</p>
      <table><tr><td></td><td><b>${a.nation}</b></td><td><b>${b.nation}</b></td></tr>
      <tr><td>Points</td><td>${a.score.toFixed(0)}</td><td>${b.score.toFixed(0)}</td></tr>
      <tr><td>Men lost</td><td>${Math.round(a.lostMen).toLocaleString()}</td><td>${Math.round(b.lostMen).toLocaleString()}</td></tr>
      <tr><td>Army morale</td><td>${a.armyMorale.toFixed(0)}</td><td>${b.armyMorale.toFixed(0)}</td></tr></table>
      <button data-a="again">Play again</button></div>`;
    this.end.style.display = 'flex';
  }

  reset() {
    this.endShown = false;
    this.end.style.display = 'none';
  }
}
