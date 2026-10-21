import { CALLIN_ORDER, Formation, RULES, UNIT_TYPES, UnitTypeId } from '../sim/config';
import { OBJECTIVES, Vec } from '../sim/map';
import { Unit, World, experienceOf, formationOf, isSupport } from '../sim/world';

export interface HudHandlers {
  callIn(type: UnitTypeId): void;
  requisition(): void;
  ready(): void;
  hold(): void;
  formation(f?: Formation): void;
  aim(): void;
  ceaseFire(): void;
  restart(): void;
  menu(): void;
  spectate(): void;
  resign(): void;
  build(): void;
  pause(): void;
  speed(delta: number): void;
  jump(at: Vec, unitId?: number): void;
  labels(): void;
}

/** A short notice in the alert list; clicking it moves the view to where it happened. */
export interface Alert {
  text: string;
  tone: 'bad' | 'good' | 'info';
  at: Vec;
  unitId?: number;
  t: number; // battle time it was raised
}

export interface UiState {
  selected: Unit[];
  pendingCallIn: UnitTypeId | null;
  paused: boolean;
  speed: number;
  labels: boolean;
  spectating: boolean;
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
  private callins: HTMLDivElement;
  private spectating = false;
  private world: World | null = null;
  private selection: HTMLDivElement;
  private deploy: HTMLDivElement;
  private tooltip: HTMLDivElement;
  private end: HTMLDivElement;
  private controls: HTMLDivElement;
  private help: HTMLDivElement;
  private hint: HTMLDivElement;
  private alertBox: HTMLDivElement;
  private alerts: Alert[] = [];
  private banner: HTMLDivElement;
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
    this.hint = el('div');
    this.hint.id = 'hint';
    this.alertBox = el('div');
    this.alertBox.id = 'alerts';
    this.alertBox.addEventListener('click', (e) => {
      const i = Number(((e.target as HTMLElement).closest('[data-i]') as HTMLElement | null)?.dataset.i);
      const a = this.alerts[i];
      if (a) this.h.jump(a.at, a.unitId);
    });
    this.banner = el('div');
    this.banner.id = 'banner';

    const bar = el('div', 'panel');
    bar.id = 'callins';
    this.callins = bar;
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

    this.controls.innerHTML = `<button data-a="pause">Pause</button><button data-a="slower">−</button><span class="spd" style="align-self:center;min-width:28px;text-align:center">1×</span><button data-a="faster">+</button><button data-a="labels" title="Show or hide the words under regiments: Routing, Wavering, Flanked! and so on (L)">Labels</button><button data-a="help">?</button><button data-a="spectate" title="Watch two AI armies fight">Watch AI</button><button data-a="resign">Resign</button><button data-a="menu" title="Leave this battle for the title screen">Menu</button>`;
    this.controls.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).dataset.a;
      if (a === 'pause') this.h.pause();
      if (a === 'slower') this.h.speed(-1);
      if (a === 'faster') this.h.speed(1);
      if (a === 'spectate') this.h.spectate();
      if (a === 'menu') this.h.menu();
      if (a === 'labels') this.h.labels();
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

    const k = (key: string) => `<kbd>${key}</kbd>`;
    this.help.innerHTML = `
      <h3>How to play</h3>
      <p class="goal">Break the enemy's morale, hold all ${OBJECTIVES.length} objectives for ${RULES.dominationHold}s, or lead on points after ${RULES.matchLength / 60} min.</p>
      <table class="keys">
        <tr><td>${k('Click')}, ${k('Shift')}+drag</td><td>Select, box select</td></tr>
        <tr><td>${k('Double-click')}</td><td>Select the whole brigade</td></tr>
        <tr><td>${k('Right-click')}</td><td>Move, or attack an enemy</td></tr>
        <tr><td>${k('Right-drag')}</td><td>Form a line along the drag</td></tr>
        <tr><td>${k('1')} ${k('2')} ${k('3')} ${k('H')}</td><td>March, formation, fortify, hold</td></tr>
        <tr><td>${k('B')} ${k('X')}</td><td>Guns: aim, cease fire</td></tr>
        <tr><td>Drag, ${k('WASD')}</td><td>Move the map; wheel zooms</td></tr>
        <tr><td>${k('Space')} ${k('+')} ${k('−')}</td><td>Pause, speed</td></tr>
        <tr><td>${k('L')}</td><td>Show or hide regiment labels</td></tr>
      </table>
      <ul class="tips">
        <li>Keep regiments in the <b>general's ring</b>, and send the general to <b>routed troops</b> to rally them.</li>
        <li><b>Fortify</b> to hold ground; <b>shell</b> enemies who have dug in.</li>
        <li>Keep <b>supply wagons</b> near the fighting so muskets don't run dry.</li>
      </ul>
      <details><summary>Formations</summary>
        <p><b>March</b> is fastest but fights badly (used automatically out of combat). <b>Formation</b> is the fighting stance. <b>Fortified</b> barely moves but takes less damage and morale loss; it takes ${RULES.fortifyTime}s, only out of combat. In a town or woods, digging in adds nothing to the cover already there. Shells hit fortified troops harder, and a near miss shakes them out of their works for ${RULES.shellUnsettle}s.</p><p>Infantry charging home with the bayonet shakes the enemy on impact, most of all from the flank. Holding fewer objectives than the enemy drains ${RULES.objectiveDrain} army morale a minute for each one, so sitting back has a cost.</p><p>To take an objective, keep troops in its ring with no enemy there for ${RULES.captureTime}s; an arc round it shows the progress. Any enemy in the ring pauses it, and it runs back if everyone leaves.</p></details>
      <details><summary>Morale and the general</summary>
        <p>Inside the general's ring, morale loss is cut by a third and keeps recovering even under fire. Routed troops run to the general if it is safe, and rally once clear of the enemy, much sooner near the general. Troops that break twice rally only to the general. Losing the general costs ${RULES.generalLossMorale} army morale. The top bar shows what is draining each army.</p><p>Morale can be won back: +${RULES.recaptureMorale} for retaking an objective from the enemy, +${RULES.rallyArmyMorale} for each regiment that rallies. An army ${RULES.desperateGap} or more behind fights with its back to the wall: its regiments lose morale ${Math.round((1 - RULES.desperateMoraleTaken) * 100)}% slower and it gets ${Math.round(RULES.catchUpBonus * 100)}% more manpower.</p></details>
      <details><summary>Supply, fatigue and reinforcements</summary>
        <p>Below ${RULES.lowAmmo}% ammunition fire is halved; at 0 it stops. Standing wagons send carts to regiments within ${RULES.supplyRange}m (green ring), which can be shot up on the way. Held depots and your deployment zone refill slowly. Marching, charging and melee tire troops; rest restores them. Call in troops from the bar on the left, then click in your deployment zone; they arrive green and gain experience in battle (gold pips).</p></details>
      <details><summary>Guns, engineers and terrain</summary>
        <p>Guns set up before firing. Engineers (${k('E')}) build earthworks or a pontoon bridge at a river (${RULES.maxWorks} per side), and nearby troops dig in twice as fast. Woods hide units beyond ${RULES.woodsSpotRange}m; firing guns give themselves away.</p><p>On river maps the outer bridge on each half is an objective too. Bridges jam: every regiment on one slows the rest, and orders route round crossings that are crowded or held by the enemy.</p></details>
      <details><summary>What regiments do on their own</summary>
        <p>Between orders they shoot the shakiest enemy in front, face charging cavalry, avoid ground being shelled, won't chase a stronger or dug-in enemy, step back when wavering, and walk to the wagons when out of ammunition. ${k('H')} keeps them in place.</p></details>
      <p style="margin-top:8px"><button data-a="close">Got it</button></p>`;
    this.help.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).dataset.a === 'close') this.help.style.display = 'none';
    });

    this.economy.innerHTML = `<span class="mp"></span><button data-a="req" title="+${RULES.requisitionAmount} manpower once, costs ${RULES.requisitionMoraleCost} army morale">Requisition</button><span class="cap" style="color:var(--muted)"></span>`;
    this.deploy.innerHTML = `<div class="h">Deploy your army</div><div style="margin:4px 0 8px;color:var(--muted)">Right-click to reposition regiments in your zone or around your two towns. Spend your budget on extra troops.</div><button data-a="ready">Start battle</button>`;
    const key = (k: string) => ` <kbd>${k}</kbd>`;
    this.selection.innerHTML = `<div class="info"></div>
      <div class="btns fm">
        <button data-a="fm-marching" title="March column: fastest, but fights badly and takes more casualties. Troops march on their own for long moves.">March${key('1')}</button>
        <button data-a="fm-formation" title="Line of battle: the fighting stance.">Formation${key('2')}</button>
        <button data-a="fm-fortified" title="Dig in: barely moves, but takes less fire and loses morale more slowly. Takes ${RULES.fortifyTime}s, only out of combat. Shells hit dug-in troops harder.">Fortify${key('3')}</button>
      </div>
      <div class="btns"><button data-a="hold" title="Stop and hold this spot: they will not chase attackers, fall back or go for ammunition on their own.">Hold position${key('H')}</button></div>
      <div class="btns guns"><button data-a="aim" title="Click the ground to shell a circle there. Guns set up first, and move up if it is out of range.">Aim fire${key('B')}</button><button data-a="cease" title="Stop shelling.">Cease fire${key('X')}</button></div>
      <div class="btns eng"><button data-a="build" title="Build earthworks (cover like a village), or a pontoon bridge when standing at the river.">Build works${key('E')}</button></div>
      <div class="tip">Right-click: move or attack · right-drag: form a line · double-click: whole brigade</div>`;
    this.economy.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).dataset.a === 'req') this.h.requisition();
    });
    this.deploy.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).dataset.a === 'ready') this.h.ready();
    });
    this.selection.addEventListener('click', (e) => {
      const a = ((e.target as HTMLElement).closest('[data-a]') as HTMLElement | null)?.dataset.a;
      if (a === 'hold') this.h.hold();
      if (a?.startsWith('fm-')) this.h.formation(a.slice(3) as Formation);
      if (a === 'aim') this.h.aim();
      if (a === 'build') this.h.build();
      if (a === 'cease') this.h.ceaseFire();
    });
    this.end.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).dataset.a === 'again') this.h.restart();
      if ((e.target as HTMLElement).dataset.a === 'menu') this.h.menu();
    });

    for (const e of [this.top, this.economy, this.captions, bar, this.selection, this.deploy, this.controls, this.help, this.alertBox, this.banner, this.tooltip, this.hint, this.end]) root.appendChild(e);
  }

  update(world: World, ui: UiState) {
    this.world = world;
    const [me, them] = world.sides;
    const mb = (v: number, c: string) => `<div class="bar"><div style="width:${Math.max(0, v)}%;background:${c}"></div></div>`;
    const clockText = world.phase === 'deploy' ? clock(world.deployLeft) : clock(RULES.matchLength - world.time);
    const sub = world.phase === 'deploy' ? 'deployment' : world.time >= RULES.finalPushAt ? 'final push · points ×2' : 'remaining';
    const held = (side: number) => world.owners.filter((o) => o === side).length;
    // What is draining the army's morale, biggest first, so it is clear what to fix.
    const drain = (side: 0 | 1) => {
      const b = world.moraleBreakdown(side);
      const parts: [string, number][] = [['casualties', b.losses], ['units lost', b.removed], ['routing', b.routing], ['objectives', b.objectives], ['clock', b.time]];
      const lost = parts.filter(([, v]) => v >= 1).sort((a, b2) => b2[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} −${v.toFixed(0)}`);
      if (b.regained >= 1) lost.push(`won back +${b.regained.toFixed(0)}`);
      return lost.join(' · ');
    };
    const armyLine = (side: 0 | 1) => {
      const s = world.sides[side];
      const d = drain(side);
      const wall = world.behind(side) ? ' · <b title="Well behind: regiments steadier, more manpower">back to the wall</b>' : '';
      return `Morale ${s.armyMorale.toFixed(0)}${wall} · objectives ${held(side)}/${OBJECTIVES.length}${d ? `<br><span title="What has cost this army morale">${d}</span>` : ''}`;
    };
    setHtml(this.top, `
      <div class="army"><div class="name serif"><span>${me.nation}</span><span>${me.score.toFixed(0)} pts</span></div>${mb(me.armyMorale, '#2b2e38')}<div class="sub2">${armyLine(0)}</div></div>
      <div id="clock"><div class="time serif">${clockText}</div><div class="sub">${sub}${ui.paused ? ' · paused' : ''}</div></div>
      <div class="army"><div class="name serif"><span>${them.nation}</span><span>${them.score.toFixed(0)} pts</span></div>${mb(them.armyMorale, '#d9a92b')}<div class="sub2">${armyLine(1)}</div></div>`);
    this.updateBanner(world, ui.spectating);
    this.updateAlerts(world);

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

    // Watching AI vs AI: nothing to command, so the player's panels are hidden.
    this.spectating = ui.spectating;
    this.deploy.style.display = world.phase === 'deploy' && !ui.spectating ? 'block' : 'none';
    this.callins.style.display = ui.spectating ? 'none' : 'flex';
    this.economy.style.display = ui.spectating ? 'none' : 'flex';
    (this.controls.querySelector('[data-a="resign"]') as HTMLElement).style.display = ui.spectating ? 'none' : '';
    (this.controls.querySelector('[data-a="spectate"]') as HTMLElement).textContent = ui.spectating ? 'Play' : 'Watch AI';
    const readyBtn = this.deploy.querySelector('button') as HTMLButtonElement;
    readyBtn.textContent = me.ready ? 'Waiting…' : 'Start battle';
    readyBtn.disabled = me.ready;

    const controlsSpd = this.controls.querySelector('.spd') as HTMLElement;
    controlsSpd.textContent = `${ui.speed}×`;
    (this.controls.querySelector('[data-a="pause"]') as HTMLElement).textContent = ui.paused ? 'Resume' : 'Pause';
    this.controls.querySelector('[data-a="labels"]')!.classList.toggle('on', ui.labels);

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
    (this.selection.querySelector('.eng') as HTMLElement).style.display = sel.some((u) => u.type === 'engineers') ? 'flex' : 'none';
    const info = this.selection.querySelector('.info') as HTMLElement;
    if (sel.length === 1) {
      const u = sel[0];
      setHtml(info, `<div class="n">${u.name}</div>${this.unitRows(u)}`);
    } else {
      const men = sel.reduce((a, u) => a + u.men, 0);
      const avg = (f: (u: Unit) => number) => sel.reduce((a, u) => a + f(u), 0) / sel.length;
      const brigade = sel.every((u) => u.brigade === sel[0].brigade) && this.world ? this.world.brigadeName(sel[0]) : '';
      setHtml(info, `<div class="n">${brigade ? `${brigade} · ` : ''}${sel.length} regiments</div><div class="row"><span>Men</span><span>${Math.round(men).toLocaleString()}</span></div><div class="row"><span>Average morale</span><span>${avg((u) => u.morale).toFixed(0)}</span></div><div class="row"><span>Average fatigue / ammunition</span><span>${avg((u) => u.fatigue).toFixed(0)} / ${avg((u) => u.ammo).toFixed(0)}%</span></div>`);
    }
  }

  private unitRows(u: Unit): string {
    const w = this.world;
    const order = u.state === 'routing' ? 'Routing!' : u.order.kind === 'move' ? 'Moving' : u.order.kind === 'attack' ? (u.order.retaliate ? 'Returning fire' : 'Attacking') : u.holdPosition ? 'Holding position' : 'Idle';
    const row = (k: string, v: string, bad = false) => `<div class="row"><span>${k}</span><span style="color:${bad ? 'var(--bad)' : 'inherit'}">${v}</span></div>`;
    const level = experienceOf(u);
    const fatigue = u.fatigue < 30 ? 'Fresh' : u.fatigue < 70 ? 'Tired' : 'Exhausted';
    const own = u.side === PLAYER || this.spectating;
    let rows = row(UNIT_TYPES[u.type].label, this.formationText(u));
    if (w && u.type !== 'general') rows += row('Brigade', w.brigadeName(u));
    rows += row('Men', `${Math.round(u.men).toLocaleString()} / ${u.maxMen.toLocaleString()}`);
    if (u.type !== 'general') rows += row('Morale', `${u.morale.toFixed(0)}${u.state === 'wavering' ? ' (wavering)' : ''}`, u.morale < RULES.waveringAt);
    if (!isSupport(u)) rows += row('Experience', level[0].toUpperCase() + level.slice(1));
    if (own) {
      rows += row('Fatigue', `${fatigue} (${u.fatigue.toFixed(0)})`, u.fatigue >= 70);
      if (UNIT_TYPES[u.type].range > 0 || u.type === 'artillery') rows += row('Ammunition', `${u.ammo.toFixed(0)}%`, u.ammo < RULES.lowAmmo);
      if (u.type === 'supply') {
        const n = w?.supplyingCount(u) ?? 0;
        const status = !w?.canSendCarts(u) ? 'Halted (must stand still)' : n === 0 ? 'Nobody needs supply' : `Supplying ${n} regiment${n === 1 ? '' : 's'}`;
        rows += row('Supply', status);
      }
      if (w && !isSupport(u) && w.isSupplied(u)) rows += row('Supply', 'Supplied');
      if (w && u.type !== 'general') rows += row('General', w.inCommand(u) ? 'Nearby (steadier)' : 'Out of range');
      rows += row('Order', order);
    }
    return rows;
  }

  private formationText(u: Unit): string {
    if (u.building > 0) return `${u.buildKind === 'pontoon' ? 'Bridging' : 'Building works'} ${Math.ceil(u.building)}s`;
    if (u.marching) return 'Marching (auto)';
    if (u.formation === 'fortified' && formationOf(u) !== 'fortified') return u.type === 'artillery' ? 'Setting up guns…' : 'Digging in…';
    return FORMATION_LABEL[u.formation];
  }

  showTooltip(u: Unit | null, x: number, y: number) {
    if (!u) {
      this.tooltip.style.display = 'none';
      return;
    }
    this.tooltip.style.display = 'block';
    setHtml(this.tooltip, `<div class="n">${u.name}</div>${this.unitRows(u)}`);
    // Keep it on screen: flip to the other side of the cursor near the right and bottom edges.
    const w = this.tooltip.offsetWidth;
    const h = this.tooltip.offsetHeight;
    this.tooltip.style.left = `${x + 16 + w > window.innerWidth ? x - 16 - w : x + 16}px`;
    this.tooltip.style.top = `${y + 16 + h > window.innerHeight ? y - 16 - h : y + 16}px`;
  }

  /** The few words by the pointer saying what a click will do. */
  showHint(text: string | null, x: number, y: number, bad = false) {
    if (!text) {
      this.hint.style.display = 'none';
      return;
    }
    this.hint.style.display = 'block';
    if (this.hint.textContent !== text) this.hint.textContent = text;
    this.hint.classList.toggle('bad', bad);
    this.hint.style.left = `${x + 18}px`;
    this.hint.style.top = `${y - 30}px`;
  }

  /** How the battle can be won or lost right now: someone holding every objective, or an army near breaking. */
  private updateBanner(world: World, spectating: boolean) {
    let text = '';
    let tone = '';
    if (world.phase === 'battle') {
      for (const side of [0, 1] as const) {
        if (world.domination[side] <= 0) continue;
        const left = clock(RULES.dominationHold - world.domination[side]);
        const mine = side === PLAYER && !spectating;
        text = spectating ? `${world.sides[side].nation} holds every objective: wins in ${left}`
          : mine ? `You hold every objective: victory in ${left}` : `The enemy holds every objective: defeat in ${left} unless you retake one`;
        tone = mine || spectating ? 'good' : 'bad';
      }
      if (!text && !spectating && world.sides[PLAYER].armyMorale < 25) {
        text = 'Your army is close to breaking: pull back shaken regiments and hold what you have';
        tone = 'bad';
      }
    }
    if (this.banner.textContent !== text) this.banner.textContent = text;
    this.banner.className = tone;
    this.banner.style.display = text ? 'block' : 'none';
  }

  /** Add a notice to the alert list (newest at the top). */
  alert(a: Alert) {
    this.alerts.unshift(a);
    this.alerts.length = Math.min(this.alerts.length, 5);
  }

  private updateAlerts(world: World) {
    this.alerts = this.alerts.filter((a) => world.time - a.t < 20 && a.t <= world.time);
    setHtml(this.alertBox, this.alerts.map((a, i) => `<div class="alert ${a.tone}" data-i="${i}" title="Click to look">${a.text}</div>`).join(''));
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
    const title = r.winner === -1 ? 'Draw'
      : this.spectating ? `${world.sides[r.winner].nation} wins`
      : r.winner === PLAYER ? 'Victory' : 'Defeat';
    const [a, b] = world.sides;
    this.end.innerHTML = `<div class="panel"><h2>${title}</h2><p>${r.reason} at ${clock(world.time)}.</p>
      <table><tr><td></td><td><b>${a.nation}</b></td><td><b>${b.nation}</b></td></tr>
      <tr><td>Points</td><td>${a.score.toFixed(0)}</td><td>${b.score.toFixed(0)}</td></tr>
      <tr><td>Men lost</td><td>${Math.round(a.lostMen).toLocaleString()}</td><td>${Math.round(b.lostMen).toLocaleString()}</td></tr>
      <tr><td>Army morale</td><td>${a.armyMorale.toFixed(0)}</td><td>${b.armyMorale.toFixed(0)}</td></tr></table>
      <button data-a="again">${this.spectating ? 'Watch another' : 'Play again'}</button> <button data-a="menu">Main menu</button></div>`;
    this.end.style.display = 'flex';
  }

  reset() {
    this.alerts = [];
    this.endShown = false;
    this.end.style.display = 'none';
  }
}
