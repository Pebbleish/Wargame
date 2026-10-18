// All tunable numbers live here so balance changes never need code changes.
// Distances are metres, times are seconds of battle clock, speeds are metres per second.

export type UnitTypeId = 'line' | 'light' | 'cavalry' | 'artillery' | 'engineers';
export type Formation = 'marching' | 'formation' | 'fortified';
export const FORMATIONS: Formation[] = ['marching', 'formation', 'fortified'];

export interface UnitTypeDef {
  id: UnitTypeId;
  label: string;
  men: number;
  speed: number; // base marching speed in column / limbered
  range: number; // effective fire range
  lethality: number; // casualties per firing man per second at point-blank range
  shock: number; // melee strength multiplier
  sight: number;
  cost: number; // manpower
  arrival: number; // seconds from call-in to arrival at the home edge
  cooldown: number; // seconds before this type can be called again
}

export const UNIT_TYPES: Record<UnitTypeId, UnitTypeDef> = {
  line: {
    id: 'line', label: 'Line infantry', men: 2400, speed: 6, range: 260, lethality: 0.0022,
    shock: 1.0, sight: 900, cost: 400, arrival: 30, cooldown: 45,
  },
  light: {
    id: 'light', label: 'Light infantry', men: 900, speed: 7, range: 320, lethality: 0.0032,
    shock: 0.6, sight: 1100, cost: 250, arrival: 20, cooldown: 30,
  },
  cavalry: {
    id: 'cavalry', label: 'Cavalry', men: 900, speed: 13, range: 0, lethality: 0,
    shock: 2.6, sight: 1400, cost: 350, arrival: 20, cooldown: 60,
  },
  artillery: {
    id: 'artillery', label: 'Artillery', men: 400, speed: 5, range: 1500, lethality: 0,
    shock: 0.3, sight: 1000, cost: 450, arrival: 45, cooldown: 60,
  },
  engineers: {
    id: 'engineers', label: 'Engineers', men: 500, speed: 5.5, range: 200, lethality: 0.0015,
    shock: 0.5, sight: 800, cost: 200, arrival: 30, cooldown: 60,
  },
};

export const CALLIN_ORDER: UnitTypeId[] = ['engineers', 'light', 'cavalry', 'line', 'artillery'];

export const FORMATION = {
  // fire: share of men that can fire; speed: multiplier on top speed; fireTaken: multiplier on casualties
  // received; moraleTaken: multiplier on morale lost per casualty; vsCavalry: melee strength vs cavalry
  marching: { fire: 0.25, speed: 1.0, fireTaken: 1.3, moraleTaken: 1.2, vsCavalry: 0.6 },
  formation: { fire: 1.0, speed: 0.55, fireTaken: 1.0, moraleTaken: 1.0, vsCavalry: 1.0 },
  fortified: { fire: 0.9, speed: 0.12, fireTaken: 0.7, moraleTaken: 0.65, vsCavalry: 2.0 },
} as const;

// Fortifying while already in combat only gets a hasty position: weaker than digging in properly.
export const HASTY_FORTIFIED = { fire: 0.9, speed: 0.12, fireTaken: 0.85, moraleTaken: 0.8, vsCavalry: 1.5 } as const;

// Cavalry in formation is still quick enough to charge.
export const CAVALRY_FORMATION_SPEED = 0.85;

type Size = { w: number; d: number };
export const UNIT_SIZE: Record<UnitTypeId, Record<Formation, Size>> = {
  line: { marching: { w: 50, d: 90 }, formation: { w: 150, d: 30 }, fortified: { w: 150, d: 40 } },
  light: { marching: { w: 40, d: 70 }, formation: { w: 150, d: 20 }, fortified: { w: 150, d: 26 } },
  cavalry: { marching: { w: 40, d: 90 }, formation: { w: 90, d: 35 }, fortified: { w: 90, d: 40 } },
  artillery: { marching: { w: 40, d: 70 }, formation: { w: 70, d: 30 }, fortified: { w: 70, d: 34 } },
  engineers: { marching: { w: 40, d: 70 }, formation: { w: 110, d: 26 }, fortified: { w: 110, d: 34 } },
};

export const RULES = {
  tickRate: 10,
  matchLength: 20 * 60,
  finalPushAt: 14 * 60,
  callInCutoff: 17 * 60,
  timePressureAt: 12 * 60, // army morale starts to drain on both sides from here
  deploymentTime: 60,
  dominationHold: 60, // holding every objective this long wins outright

  startingBudget: 1500,
  stockpileCap: 1200,
  baseIncome: 60, // per minute
  objectiveIncome: 20,
  depotIncome: 40,
  requisitionAmount: 300,
  requisitionMoraleCost: 10,
  catchUpGap: 25,
  catchUpBonus: 0.15,
  fieldCap: 24,
  queueLimit: 3,
  arrivalWarning: 20,

  waveringAt: 40,
  rallyAt: 35,
  rallySafeDistance: 450,
  moraleRecovery: 0.6, // per second when not under pressure
  fortifyTime: 10, // digging in out of combat takes this long before the bonuses apply
  hastyFortifyTime: 4, // a hasty position in combat is quicker to make
  artilleryFortifyTime: 5, // guns have to set up (fortify) before they can fire
  combatRange: 500, // a unit with a visible enemy this close, or under fire, counts as in combat
  moveSpeedScale: 4.5, // multiplies every unit's base speed

  artilleryCap: 3, // batteries per side, including ones on the way
  bombardRadius: 130, // shells land at random inside this circle
  shellBlast: 45,
  shellDamage: 70, // casualties from a direct hit at full battery strength
  shellInterval: 3.5, // seconds between shells per battery
  shellVsFortified: 1.6, // shells are the answer to dug-in troops
  friendlyFire: 0.5, // share of shell damage your own troops take inside the circle

  buildTime: 20, // engineers: seconds to throw up earthworks
  pontoonTime: 30, // engineers: seconds to bridge a river
  maxWorks: 4, // earthworks and pontoon bridges per side
  engineerAura: 300, // friendly troops this close to engineers dig in twice as fast

  woodsSpotRange: 250, // units in woods are only seen by enemies this close
  firingReveals: 5, // seconds a battery stays visible after firing from woods

  captureRadius: 160,
  borderWidth: 40, // impassable strip around the map edge
  edgeDisperseTime: 30, // wavering or routing units pinned at the border this long disperse
  zoneDepth: 600, // depth of each home deployment zone from its map edge
};

export const MAP = { width: 4800, height: 3000 };
