import { RULES, UNIT_TYPES } from '../sim/config';
import { OBJECTIVES, VILLAGE_RADIUS, Vec, clampToMap, dist } from '../sim/map';
import { ArmyEntry, Command, Unit, World, isSupport } from '../sim/world';

/**
 * The first battle of a campaign: a lieutenant's first command, taught one step at a time by the company sergeant.
 * Each step says what to do and checks the battle (and the orders given) to see when it has been done.
 */

export const TUTORIAL_MAP = 8; // an open field with a village (Kessel) a short march in front of our towns
export const TUTORIAL_ARMY: ArmyEntry[] = [
  { type: 'line', men: UNIT_TYPES.line.men, xp: 10 },
  { type: 'line', men: UNIT_TYPES.line.men, xp: 10 },
  { type: 'light', men: UNIT_TYPES.light.men, xp: 10 },
  { type: 'artillery', men: UNIT_TYPES.artillery.men, xp: 10 },
];

interface Step {
  title: string;
  text: (t: Tutorial) => string;
  done: (t: Tutorial, w: World, selected: Unit[]) => boolean;
  marker?: (t: Tutorial) => Vec;
  enter?: (t: Tutorial, w: World) => void;
}

const KEEP_OUT = 750; // no deploying this close to the enemy's village

const k = (key: string) => `<kbd>${key}</kbd>`;

const STEPS: Step[] = [
  {
    title: 'Your first command',
    text: () => `Welcome, Lieutenant. You have four regiments: two of line infantry, one of light infantry and a battery of guns. Click one of your <b>line infantry</b> regiments (the long dark blocks) to select it.`,
    done: (_t, _w, sel) => sel.some((u) => u.type === 'line'),
  },
  {
    title: 'Placing your troops',
    text: () => `Before the shooting starts you place your regiments. With one selected, ${k('Right-click')} anywhere in the shaded ground on our side or near our towns to set it down there. You cannot set them down inside the red ring round <b>{v}</b>: the enemy holds it. When every regiment stands where you want it, press <b>Start battle</b>.`,
    done: (_t, w) => w.phase === 'battle',
  },
  {
    title: 'Marching',
    text: () => `Good. ${k('Right-click')} on the ground to march it there. Send it to the <b>flag</b>.`,
    marker: (t) => t.flag,
    enter: (t, w) => t.placeFlag(w),
    done: (t, w) => w.units.some((u) => u.side === 0 && u.type === 'line' && dist(u, t.flag) < 160),
  },
  {
    title: 'Several at once',
    text: () => `Now pick up more than one. Hold ${k('Shift')} and drag a box round some regiments, or ${k('Double-click')} one to select its whole brigade.`,
    done: (_t, _w, sel) => sel.filter((u) => !isSupport(u)).length >= 2,
  },
  {
    title: 'Forming a line',
    text: () => `With them selected, ${k('Right-drag')} across the ground: they form up side by side along the line you draw. Draw a line facing <b>{v}</b>.`,
    done: (t) => t.orders.some((c) => c.kind === 'move' && c.side === 0 && c.moves.length >= 2),
  },
  {
    title: 'The guns',
    text: () => `The enemy holds <b>{v}</b>. Soften them up first. Select your battery, press ${k('B')} (or Aim fire) and click on the village to shell it. Guns need a few seconds to set up.`,
    marker: (t) => t.village,
    done: (t, w) => w.units.some((u) => u.side === 0 && u.type === 'artillery' && u.fireZone !== null && dist(u.fireZone, t.village) < 350),
  },
  {
    title: 'Attack',
    text: () => `Now the infantry. Select a regiment and ${k('Right-click')} on an enemy regiment to attack it. Light infantry is good at shooting from a distance; line infantry wins the close fight.`,
    done: (t) => t.orders.some((c) => c.kind === 'attack' && c.side === 0),
  },
  {
    title: 'Take the village',
    text: () => `Drive them out and take <b>{v}</b>. Keep troops inside its ring with no enemy there; an arc fills as you take it. If a regiment starts to waver, pull it back and let the general steady it.`,
    marker: (t) => t.village,
    done: (t, w) => w.owners[t.villageIndex] === 0,
  },
  {
    title: 'Dig in',
    text: () => `{v} is ours, but Ostmark will want it back. Select a regiment in the village and press ${k('3')} to fortify. Digging in takes half a minute and only works out of combat.`,
    marker: (t) => t.village,
    done: (t, w) => w.units.some((u) => u.side === 0 && u.formation === 'fortified' && dist(u, t.village) < VILLAGE_RADIUS + 120),
  },
  {
    title: 'Hold!',
    text: (t) => `Here they come! Hold <b>{v}</b> until their attack breaks. Keep the guns firing on them as they come, and watch for horse on your flanks.${t.lost ? ' <b>They have taken the village: get it back!</b>' : ''}`,
    marker: (t) => t.village,
    enter: (t, w) => t.counterattack(w),
    done: (t, w) => {
      const near = w.units.some((u) => u.side === 1 && !isSupport(u) && u.state !== 'routing' && dist(u, t.village) < 1400);
      const held = w.owners[t.villageIndex] === 0;
      t.lost = !held;
      return held && w.time - t.stepStart > 30 && (!near || w.time - t.stepStart > 180);
    },
  },
];

export class Tutorial {
  step = 0;
  stepStart = 0;
  orders: Command[] = [];
  flag: Vec;
  village: Vec;
  villageIndex: number;
  villageName: string;
  lost = false;
  finished = false;
  skipped = false;
  wave = false; // the counterattack has been launched
  private waveIds: number[] = [];
  private nextDrive = 0;

  constructor(world: World) {
    // The village is the town nearest our own that is not anyone's home.
    const homes = OBJECTIVES.filter((o) => o.home === 0);
    const mid = { x: (homes[0].x + homes[1].x) / 2, y: (homes[0].y + homes[1].y) / 2 };
    const v = OBJECTIVES.filter((o) => o.home === undefined && !o.centre).sort((a, b) => dist(a, mid) - dist(b, mid))[0] ?? OBJECTIVES.find((o) => o.centre)!;
    this.village = { x: v.x, y: v.y };
    this.villageIndex = v.id;
    this.villageName = v.name;
    // Start the regiments well out of musket range of the village, so the lesson begins before the shooting does.
    const ours = world.units.filter((u) => u.side === 0);
    const c = { x: ours.reduce((s, u) => s + u.x, 0) / ours.length, y: ours.reduce((s, u) => s + u.y, 0) / ours.length };
    const away = Math.max(1, dist(c, v));
    const nearest = Math.min(...ours.map((u) => dist(u, v)));
    const push = Math.max(0, 1000 - nearest);
    for (const u of ours) {
      const p = clampToMap({ x: u.x + ((c.x - v.x) / away) * push, y: u.y + ((c.y - v.y) / away) * push }, RULES.borderWidth + 80);
      u.x = p.x;
      u.y = p.y;
    }
    this.flag = { x: v.x, y: v.y };
    world.deployTimeLimit = false;
    world.deployKeepOut = { x: v.x, y: v.y, r: KEEP_OUT };
    // Ostmark holds the village with a weak line regiment and some skirmishers.
    const a = world.spawn(1, 'line', v.x + 60, v.y - 60, { xp: 0 });
    a.men = 1300;
    world.spawn(1, 'light', v.x + 120, v.y + 90, { xp: 0 });
  }

  get current(): Step | undefined {
    return STEPS[this.step];
  }

  get total(): number {
    return STEPS.length;
  }

  onCommand(c: Command) {
    this.orders.push(c);
  }

  /** Check the current step; move on when it is done. */
  update(world: World, selected: Unit[]) {
    this.drive(world);
    const s = this.current;
    if (!s || this.finished) return;
    if (s.done(this, world, selected)) {
      this.step++;
      this.stepStart = world.time;
      this.orders = [];
      const next = this.current;
      if (next?.enter) next.enter(this, world);
      if (!next) this.finished = true;
    }
  }

  title(): string {
    return this.current?.title ?? 'Well done';
  }

  text(): string {
    if (!this.current) return `${this.villageName} is held and the attack is broken. You have the makings of an officer.`;
    return this.current.text(this).replaceAll('{v}', this.villageName);
  }

  marker(): Vec | null {
    return this.current?.marker?.(this) ?? null;
  }

  /** Once the battle starts the flag goes a good march out from where the regiments now stand, off to one side of the way to the village. */
  placeFlag(world: World) {
    const homes = OBJECTIVES.filter((o) => o.home === 0);
    const mid = { x: (homes[0].x + homes[1].x) / 2, y: (homes[0].y + homes[1].y) / 2 };
    const v = this.village;
    const ours = world.units.filter((u) => u.side === 0 && u.type === 'line');
    const room = (p: Vec) => Math.min(...ours.map((u) => dist(u, p)), dist(p, v) - 150);
    const candidates = [-700, -500, 500, 700].map((dy) => ({ x: mid.x + (v.x - mid.x) * 0.5, y: Math.max(300, Math.min(2700, mid.y + (v.y - mid.y) * 0.5 + dy)) }));
    this.flag = candidates.sort((a, b) => room(b) - room(a))[0];
  }

  /**
   * The enemy in the tutorial has no general thinking for it, only simple orders that serve the lesson: the garrison
   * stands in the village, and the counterattack marches straight on it, falling on whatever it meets there. The horse
   * keeps behind the foot until they reach the village, then charges the nearest of our regiments.
   */
  private drive(world: World) {
    if (!this.wave || world.time < this.nextDrive) return;
    this.nextDrive = world.time + 2;
    const ours = world.units.filter((u) => u.side === 0 && !isSupport(u) && u.state !== 'routing');
    const wave = this.waveIds.map((id) => world.units.find((u) => u.id === id)).filter((u): u is Unit => !!u && u.state !== 'routing');
    const footArrived = wave.some((u) => u.type !== 'cavalry' && dist(u, this.village) < 550);
    const order = (u: Unit, foe: Unit | undefined, x: number, y: number) => {
      if (foe) {
        if (u.order.kind !== 'attack' || u.order.target !== foe.id) world.apply({ kind: 'attack', side: 1, ids: [u.id], target: foe.id });
      } else if (dist(u, { x, y }) > 60 && (u.order.kind !== 'move' || dist(u.order, { x, y }) > 40)) {
        world.apply({ kind: 'move', side: 1, moves: [{ id: u.id, x, y }] });
      }
    };
    for (const u of wave) {
      if (u.meleeWith !== null) continue; // already at close quarters: let the fight run
      const nearest = (r: number, from: Vec) => ours.filter((o) => dist(o, from) < r).sort((a, b) => dist(a, u) - dist(b, u))[0];
      if (u.type === 'cavalry') {
        if (footArrived) order(u, nearest(900, this.village), this.village.x, this.village.y);
        else order(u, undefined, this.village.x + 500, this.village.y + 250);
      } else {
        order(u, nearest(450, u), this.village.x, this.village.y);
      }
    }
  }

  /** The enemy's answer: two line regiments and some horse march on the village from the east. */
  counterattack(world: World) {
    const from = { x: Math.min(this.village.x + 1500, 3700), y: this.village.y };
    const spots: [Vec, 'line' | 'cavalry'][] = [
      [{ x: from.x, y: from.y - 180 }, 'line'], [{ x: from.x, y: from.y + 180 }, 'line'], [{ x: from.x + 150, y: from.y + 450 }, 'cavalry'],
    ];
    for (const [p, type] of spots) {
      this.waveIds.push(world.spawn(1, type, p.x, p.y, { xp: 0 }).id);
    }
    this.wave = true;
    world.log(0, 'Enemy columns are marching on the village!');
  }
}
