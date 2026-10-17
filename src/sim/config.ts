// All tunable numbers live here so balance changes never need code changes.
// Distances are metres, times are seconds of battle clock, speeds are metres per second.

export type UnitTypeId = 'line' | 'light' | 'cavalry' | 'artillery' | 'engineers';
export type Formation = 'line' | 'column' | 'square' | 'skirmish' | 'limbered' | 'unlimbered';

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
  formations: Formation[];
}

export const UNIT_TYPES: Record<UnitTypeId, UnitTypeDef> = {
  line: {
    id: 'line', label: 'Line infantry', men: 2400, speed: 6, range: 260, lethality: 0.0022,
    shock: 1.0, sight: 900, cost: 400, arrival: 60, cooldown: 90, formations: ['line', 'column', 'square'],
  },
  light: {
    id: 'light', label: 'Light infantry', men: 900, speed: 7, range: 320, lethality: 0.0032,
    shock: 0.6, sight: 1100, cost: 250, arrival: 45, cooldown: 60, formations: ['skirmish', 'column'],
  },
  cavalry: {
    id: 'cavalry', label: 'Cavalry', men: 900, speed: 13, range: 0, lethality: 0,
    shock: 2.6, sight: 1400, cost: 350, arrival: 45, cooldown: 120, formations: ['line'],
  },
  artillery: {
    id: 'artillery', label: 'Artillery', men: 400, speed: 5, range: 1500, lethality: 0,
    shock: 0.3, sight: 1000, cost: 450, arrival: 90, cooldown: 120, formations: ['limbered', 'unlimbered'],
  },
  engineers: {
    id: 'engineers', label: 'Engineers', men: 500, speed: 5.5, range: 200, lethality: 0.0015,
    shock: 0.5, sight: 800, cost: 200, arrival: 60, cooldown: 120, formations: ['line', 'column'],
  },
};

export const CALLIN_ORDER: UnitTypeId[] = ['engineers', 'light', 'cavalry', 'line', 'artillery'];

export const FORMATION = {
  // fire: share of men that can fire; speed: multiplier on base speed;
  // fireTaken: multiplier on casualties received from fire; vsCavalry: melee strength vs cavalry
  line: { fire: 1.0, speed: 0.55, fireTaken: 1.0, vsCavalry: 1.0, w: 150, d: 30 },
  column: { fire: 0.25, speed: 1.0, fireTaken: 1.4, vsCavalry: 0.8, w: 50, d: 90 },
  square: { fire: 0.45, speed: 0.15, fireTaken: 1.6, vsCavalry: 4.0, w: 60, d: 60 },
  skirmish: { fire: 0.8, speed: 0.8, fireTaken: 0.5, vsCavalry: 0.4, w: 150, d: 20 },
  limbered: { fire: 0, speed: 1.0, fireTaken: 1.2, vsCavalry: 0.3, w: 40, d: 70 },
  unlimbered: { fire: 1.0, speed: 0, fireTaken: 1.0, vsCavalry: 0.5, w: 70, d: 30 },
} as const;

export const CAVALRY_SIZE = { w: 90, d: 35 };

export const RULES = {
  tickRate: 10,
  matchLength: 30 * 60,
  finalPushAt: 22 * 60,
  callInCutoff: 25 * 60,
  deploymentTime: 90,

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
  limberTime: 5,
  moveSpeedScale: 4.5, // multiplies every unit's base speed

  artilleryCap: 3, // batteries per side, including ones on the way
  bombardRadius: 130, // shells land at random inside this circle
  shellBlast: 45,
  shellDamage: 70, // casualties from a direct hit at full battery strength
  shellInterval: 3.5, // seconds between shells per battery

  captureRadius: 160,
  zoneDepth: 600, // depth of each home deployment zone from its map edge
};

export const MAP = { width: 4800, height: 3000 };
