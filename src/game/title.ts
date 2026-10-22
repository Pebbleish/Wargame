import { RULES } from '../sim/config';
import { OBJECTIVES } from '../sim/map';
import { RANKS, SLOTS, deleteCampaign, loadCampaign, newCampaign, ownedBy, saveCampaign } from '../sim/strategic';
import { savedMaps } from './maps';

/**
 * The title screen, in the style of a certain block game: a big stone logo, a yellow splash line that pulses,
 * a stack of wide stone buttons, and a live AI battle drifting past behind it all. Singleplayer, Multiplayer and
 * FAQ / Settings each open their own screen; the battle scene listens for 'wargame:play' and sends 'wargame:menu'
 * when the player comes back.
 */

const SPLASHES = [
  'Now with capture time!',
  'Hold the line!',
  'Mind your flanks!',
  'Form square!',
  'Up, Guards, and at \'em!',
  'An army marches on its stomach!',
  'Ten minutes to glory!',
  'Keep a reserve!',
  'More cannon!',
  'Never split your army!',
  'Also try chess!',
  'The general is in the ring!',
  'Do not chase the routers!',
  'Fortify, then shell!',
  'Mind the bridges!',
  '100% more wagons!',
  'Deterministic at 10 Hz!',
  'The AI remembers you!',
];

const LABELS_KEY = 'wargame.labels';
const SPEED_KEY = 'wargame.speed';
const MENU_KEY = 'wargame.menuLive';
const HABITS_KEY = 'wargame.habits';
const SPEEDS = [0.5, 1, 2, 3, 5, 8];

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the setting lasts for this visit only.
  }
}

type Screen = 'title' | 'single' | 'multi' | 'options' | 'campaign';

export class TitleScreen {
  private root: HTMLDivElement;
  private screen: Screen = 'title';
  private tab: 'settings' | 'faq' = 'settings';
  private splash = SPLASHES[Math.floor(Math.random() * SPLASHES.length)];
  private confirmClear = false;
  private mapChoice = ''; // the saved map to fight on in Singleplayer ('' for a new random field)
  private slot = 0; // the campaign save picked in the list
  private confirmDelete = false;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'title';
    parent.appendChild(this.root);
    this.root.addEventListener('click', (e) => this.click(e));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.visible() && this.screen !== 'title') this.go('title');
    });
    window.addEventListener('wargame:menu', () => this.show());
    this.show();
  }

  private visible() {
    return document.body.classList.contains('menu');
  }

  show() {
    document.body.classList.add('menu');
    this.splash = SPLASHES[Math.floor(Math.random() * SPLASHES.length)];
    this.go('title');
  }

  private hide() {
    document.body.classList.remove('menu');
    this.root.innerHTML = '';
  }

  private go(screen: Screen) {
    this.screen = screen;
    this.confirmClear = false;
    this.confirmDelete = false;
    this.render();
  }

  private play(spectate: boolean) {
    const map = !spectate ? savedMaps().find((m) => m.name === this.mapChoice) : undefined;
    this.hide();
    window.dispatchEvent(new CustomEvent('wargame:play', { detail: { spectate, map } }));
  }

  /** Start or carry on the campaign in the picked slot. A new one, or one whose tutorial is not done, starts with the tutorial. */
  private playSlot() {
    let c = loadCampaign(this.slot);
    if (!c) {
      c = newCampaign(this.slot, 1 + Math.floor(Math.random() * 1e9));
      saveCampaign(c);
    }
    this.hide();
    if (!c.tutorialDone) window.dispatchEvent(new CustomEvent('wargame:battle', { detail: { kind: 'tutorial', slot: this.slot, title: 'Tutorial' } }));
    else window.dispatchEvent(new CustomEvent('wargame:campaign', { detail: { slot: this.slot } }));
  }

  private click(e: MouseEvent) {
    const t = (e.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
    if (!t || (t as HTMLButtonElement).disabled) return;
    const a = t.dataset.a;
    if (a === 'single') this.go('single');
    else if (a === 'multi') this.go('multi');
    else if (a === 'options') this.go('options');
    else if (a === 'back') this.go('title');
    else if (a === 'new') this.play(false);
    else if (a === 'campaign') this.go('campaign');
    else if (a === 'editor') { this.hide(); window.dispatchEvent(new Event('wargame:editor')); }
    else if (a === 'map') {
      const names = ['', ...savedMaps().map((m) => m.name)];
      this.mapChoice = names[(names.indexOf(this.mapChoice) + 1) % names.length];
      this.render();
    }
    else if (a === 'slot') { this.slot = Number(t.dataset.i); this.confirmDelete = false; this.render(); }
    else if (a === 'begin') this.playSlot();
    else if (a === 'delete') {
      if (this.confirmDelete) { deleteCampaign(this.slot); this.go('campaign'); return; }
      this.confirmDelete = true;
      this.render();
    }
    else if (a === 'watch') this.play(true);
    else if (a === 'splash') { this.splash = SPLASHES[(SPLASHES.indexOf(this.splash) + 1) % SPLASHES.length]; this.render(); }
    else if (a === 'tab-settings' || a === 'tab-faq') { this.tab = a === 'tab-faq' ? 'faq' : 'settings'; this.render(); }
    else if (a === 'labels') { write(LABELS_KEY, read(LABELS_KEY) === '0' ? '1' : '0'); this.settingsChanged(); }
    else if (a === 'speed') { write(SPEED_KEY, String(SPEEDS[(this.speedIndex() + 1) % SPEEDS.length])); this.settingsChanged(); }
    else if (a === 'live') { write(MENU_KEY, read(MENU_KEY) === '0' ? '1' : '0'); this.settingsChanged(); }
    else if (a === 'clear') {
      // Two clicks, so a stray one never wipes what the AI has learned.
      if (this.confirmClear) { write(HABITS_KEY, null); this.confirmClear = false; t.textContent = 'AI Memory: Cleared'; return; }
      this.confirmClear = true;
      this.render();
    }
  }

  private settingsChanged() {
    window.dispatchEvent(new Event('wargame:settings'));
    this.render();
  }

  private speedIndex() {
    const i = SPEEDS.indexOf(Number(read(SPEED_KEY)));
    return i >= 0 ? i : 1;
  }

  private render() {
    const r = this.root;
    if (this.screen === 'title') {
      r.innerHTML = `
        <div class="logo-wrap">
          <div class="logo" aria-label="War Game"><span class="logo-back">WAR GAME</span><span class="logo-front">WAR GAME</span></div>
          <div class="edition">Prototype Edition</div>
          <button class="splash" data-a="splash" title="Click for another">${this.splash}</button>
        </div>
        <div class="mc-menu">
          <button class="mc" data-a="single">Singleplayer</button>
          <button class="mc" data-a="campaign">Campaign</button>
          <button class="mc" data-a="multi">Multiplayer</button>
          <div class="mc-pair"><button class="mc" data-a="editor">Map Editor</button><button class="mc" data-a="options">FAQ / Settings</button></div>
        </div>
        <div class="corner left">War Game Prototype 0.1</div>
        <div class="corner right">A historical real-time strategy game</div>`;
      return;
    }
    if (this.screen === 'single') {
      r.innerHTML = `
        <div class="mc-screen">
          <h1>Singleplayer</h1>
          <div class="mc-menu">
            <button class="mc" data-a="map" title="Fight on a new random field, or on a map you made in the Map Editor">Map: ${this.mapChoice ? esc(this.mapChoice) : 'Random field'}</button>
            <button class="mc" data-a="new">New Battle</button>
            <div class="mc-note">Command one army against the AI. It remembers how you fought last time.</div>
            <button class="mc" data-a="watch">Watch AI Battle</button>
            <div class="mc-note">Sit back and watch two AI generals fight it out, with the whole field in view.</div>
          </div>
          <div class="mc-foot"><button class="mc" data-a="back">Back</button></div>
        </div>`;
      return;
    }
    if (this.screen === 'campaign') {
      const rows = Array.from({ length: SLOTS }, (_, i) => {
        const c = loadCampaign(i);
        const sub = !c ? 'Empty: start a new campaign'
          : !c.tutorialDone ? 'Lieutenant · tutorial not finished'
          : c.over ? `${c.over === 'won' ? 'The war is won' : 'The war is lost'} · day ${Math.floor(c.day) + 1}`
          : `${RANKS[c.rank].name} · day ${Math.floor(c.day) + 1} · ${ownedBy(c, 0).length} of ${c.territories.length} towns · ${c.wins} victories`;
        return `<button class="mc-row ${i === this.slot ? 'sel' : ''}" data-a="slot" data-i="${i}"><span class="t">Campaign ${i + 1}</span><span class="s">${sub}</span></button>`;
      }).join('');
      const picked = loadCampaign(this.slot);
      r.innerHTML = `
        <div class="mc-screen">
          <h1>Campaign</h1>
          <div class="mc-panel">The war with Ostmark. You start as a lieutenant with a handful of regiments and learn the ropes, then lead an army across the country, town by town, until Ostmark's capital falls.</div>
          <div class="mc-list rows">${rows}</div>
          <div class="mc-menu tight">
            <button class="mc" data-a="begin">${!picked ? 'New Campaign' : picked.tutorialDone ? 'Continue' : 'Continue Tutorial'}</button>
            <div class="mc-pair"><button class="mc" data-a="delete" ${picked ? '' : 'disabled'}>${this.confirmDelete ? 'Click again to delete' : 'Delete Save'}</button><button class="mc" data-a="back">Back</button></div>
          </div>
        </div>`;
      return;
    }
    if (this.screen === 'multi') {
      r.innerHTML = `
        <div class="mc-screen">
          <h1>Multiplayer</h1>
          <div class="mc-panel">Battles against other players aren't here yet. For now, take on the AI in Singleplayer.</div>
          <div class="mc-menu">
            <button class="mc" disabled title="Coming later">Join Battle</button>
            <button class="mc" disabled title="Coming later">Host Battle</button>
          </div>
          <div class="mc-foot"><button class="mc" data-a="back">Back</button></div>
        </div>`;
      return;
    }
    const on = (v: boolean) => (v ? 'ON' : 'OFF');
    const settings = `
      <div class="mc-grid">
        <button class="mc" data-a="labels" title="The words under regiments: Routing, Wavering, Flanked! and so on">Unit Labels: ${on(read(LABELS_KEY) !== '0')}</button>
        <button class="mc" data-a="speed" title="How fast each battle starts. You can still change it in battle with + and −.">Start Speed: ${SPEEDS[this.speedIndex()]}×</button>
        <button class="mc" data-a="live" title="Play an AI battle behind this menu, or keep the field still">Menu Battle: ${read(MENU_KEY) === '0' ? 'Still' : 'Live'}</button>
        <button class="mc" data-a="clear" title="The AI remembers how you fought and plans against it. This makes it forget.">${this.confirmClear ? 'Click again to forget' : 'AI Memory: Clear'}</button>
      </div>`;
    const faq: [string, string][] = [
      ['How do I win?', `Break the enemy's army morale, hold all ${OBJECTIVES.length} objectives for ${RULES.dominationHold} seconds, or be ahead on points when the ${RULES.matchLength / 60} minutes run out.`],
      ['How do I give orders?', 'Click a regiment to select it, or Shift+drag to box select. Right-click to move or attack, and right-drag to form a line. Double-click selects a whole brigade.'],
      ['How do I take a town?', `Keep troops inside its ring with no enemy there for ${RULES.captureTime} seconds. An arc round the town shows progress. Any enemy in the ring pauses it, and it runs back if everyone leaves.`],
      ['Why are my troops running away?', 'They have lost their nerve. Keep regiments inside the general\'s ring, where morale holds better, and send the general to routed troops to rally them.'],
      ['Why did my men stop firing?', `They are out of ammunition. Keep supply wagons within ${RULES.supplyRange} m of the fighting and they send carts forward.`],
      ['How do I get more troops?', 'Call them in from the bar on the left, then click in your deployment zone. Manpower comes in over time, faster with more towns and depots held.'],
      ['How do I beat dug-in troops?', 'Shell them. Guns hit fortified troops much harder, and a near miss shakes them out of their works for a while.'],
      ['Does the AI learn?', 'Yes. It remembers how you fought in earlier battles and picks its plan with that in mind. You can make it forget under Settings.'],
      ['How does the campaign work?', 'Pick one of the two save slots. You start as a lieutenant in a tutorial battle, then lead an army in a war of defence: Ostmark has crossed the border. Its lords strike at your towns once or twice a day, and each attack is announced so you can ride to the rescue; a town you stand in must hold out until help comes. Allied lords fight alongside you. Hover over any army or town to see its troops and your chance against it. Kill an enemy lord in battle and the army breaks. Take Ostgard, Ostmark\'s capital, to win; lose Valdhaven and the war is lost.'],
      ['How do I make my own map?', 'Open the Map Editor from the title screen. Paint woods, hills and marsh, place towns, lay roads and a river with bridges, and give each side 2 home towns. Save it, then pick it with the Map button under Singleplayer. Share code turns a map into text you can send to a friend.'],
      ['Is there multiplayer?', 'Not yet. For now, every battle is against the AI.'],
      ['Where are the controls?', 'Press the ? button during a battle for the full list of keys and rules.'],
    ];
    const faqHtml = `<div class="mc-list">${faq.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join('')}</div>`;
    r.innerHTML = `
      <div class="mc-screen">
        <h1>FAQ / Settings</h1>
        <div class="mc-tabs">
          <button class="mc ${this.tab === 'settings' ? 'sel' : ''}" data-a="tab-settings">Settings</button>
          <button class="mc ${this.tab === 'faq' ? 'sel' : ''}" data-a="tab-faq">FAQ</button>
        </div>
        ${this.tab === 'settings' ? settings : faqHtml}
        <div class="mc-foot"><button class="mc" data-a="back">Done</button></div>
      </div>`;
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
