/**
 * The campaign: a run of battles against Ostmark, each against a general with a different way of fighting, on its own
 * field. Winning a battle opens the next. Progress is kept in this browser.
 */
export interface Chapter {
  title: string;
  briefing: string;
  seed: number; // the battle (and so the field) it is fought on
  doctrine: number; // the enemy general's plan, an index into DOCTRINES
  enemyBonus: number; // extra manpower the enemy starts with
}

export const CHAPTERS: Chapter[] = [
  {
    title: 'The Border Towns',
    briefing: 'Ostmark has crossed the border and dug in around the towns it seized. Its general is cautious and fond of earthworks. Take the field back.',
    seed: 101, doctrine: 0, enemyBonus: 0,
  },
  {
    title: 'Horsemen on the Roads',
    briefing: 'Enemy cavalry is loose behind our lines, cutting up wagons and guns. Keep the supply trains safe and the general guarded while you win the fight in front.',
    seed: 102, doctrine: 4, enemyBonus: 0,
  },
  {
    title: 'The Hammer',
    briefing: 'Ostmark has massed its infantry for one great blow at our line. Hold it, then strike back before it can gather again.',
    seed: 103, doctrine: 1, enemyBonus: 150,
  },
  {
    title: 'Round the Flank',
    briefing: 'Scouts say the enemy means to march round one of our wings while pinning the rest. Watch your flanks and keep a reserve.',
    seed: 104, doctrine: 2, enemyBonus: 200,
  },
  {
    title: 'Under the Guns',
    briefing: 'The enemy has brought up a great many guns and waits for us behind them. Do not walk into the grand battery. Find a way round it, or wear it down.',
    seed: 105, doctrine: 3, enemyBonus: 250,
  },
  {
    title: 'Ostmark\'s Last Army',
    briefing: 'This is everything Ostmark has left, and more of it than we have. Win here and the war is over.',
    seed: 106, doctrine: 1, enemyBonus: 450,
  },
];

const KEY = 'wargame.campaign';

/** How many chapters have been won (the next one to fight is this index). */
export function campaignProgress(): number {
  try {
    const n = Number(localStorage.getItem(KEY) ?? 0);
    return Number.isFinite(n) ? Math.max(0, Math.min(CHAPTERS.length, n)) : 0;
  } catch {
    return 0;
  }
}

export function setCampaignProgress(n: number) {
  try {
    localStorage.setItem(KEY, String(n));
  } catch {
    // Storage blocked: progress lasts for this visit only.
  }
}
