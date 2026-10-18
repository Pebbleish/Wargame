// All tunable numbers live here so balance changes never need code changes.
// Distances are metres, times are seconds of battle clock, speeds are metres per second.

export type UnitTypeId = 'line' | 'light' | 'cavalry' | 'artillery' | 'engineers' | 'supply' | 'general';
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
  supply: {
    id: 'supply', label: 'Supply wagons', men: 300, speed: 5, range: 0, lethality: 0,
    shock: 0.1, sight: 700, cost: 150, arrival: 25, cooldown: 60,
  },
  // The army commander and staff: never called in, one per army.
  general: {
    id: 'general', label: 'Army HQ', men: 120, speed: 11, range: 0, lethality: 0,
    shock: 0.4, sight: 1200, cost: 0, arrival: 0, cooldown: 0,
  },
};

export const CALLIN_ORDER: UnitTypeId[] = ['supply', 'engineers', 'light', 'cavalry', 'line', 'artillery'];

export const FORMATION = {
  // fire: share of men that can fire; speed: multiplier on top speed; fireTaken: multiplier on casualties
  // received; moraleTaken: multiplier on morale lost per casualty; vsCavalry: melee strength vs cavalry
  marching: { fire: 0.25, speed: 1.0, fireTaken: 1.3, moraleTaken: 1.2, vsCavalry: 0.6 },
  formation: { fire: 1.0, speed: 0.55, fireTaken: 1.0, moraleTaken: 1.0, vsCavalry: 1.0 },
  fortified: { fire: 0.9, speed: 0.12, fireTaken: 0.7, moraleTaken: 0.65, vsCavalry: 2.0 },
} as const;


// Cavalry in formation is still quick enough to charge.
export const CAVALRY_FORMATION_SPEED = 0.85;

type Size = { w: number; d: number };
export const UNIT_SIZE: Record<UnitTypeId, Record<Formation, Size>> = {
  line: { marching: { w: 50, d: 90 }, formation: { w: 150, d: 30 }, fortified: { w: 150, d: 40 } },
  light: { marching: { w: 40, d: 70 }, formation: { w: 150, d: 20 }, fortified: { w: 150, d: 26 } },
  cavalry: { marching: { w: 40, d: 90 }, formation: { w: 90, d: 35 }, fortified: { w: 90, d: 40 } },
  artillery: { marching: { w: 40, d: 70 }, formation: { w: 70, d: 30 }, fortified: { w: 70, d: 34 } },
  engineers: { marching: { w: 40, d: 70 }, formation: { w: 110, d: 26 }, fortified: { w: 110, d: 34 } },
  supply: { marching: { w: 36, d: 70 }, formation: { w: 60, d: 36 }, fortified: { w: 60, d: 40 } },
  general: { marching: { w: 30, d: 44 }, formation: { w: 44, d: 30 }, fortified: { w: 44, d: 34 } },
};

export type Experience = 'green' | 'trained' | 'veteran' | 'elite';

// Experience points needed for each level, and what each level is worth.
// fire: multiplier on casualties dealt (musketry, shells and melee); morale: multiplier on morale lost.
export const EXPERIENCE: Record<Experience, { xp: number; fire: number; morale: number }> = {
  green: { xp: 0, fire: 0.85, morale: 1.2 },
  trained: { xp: 20, fire: 1.0, morale: 1.0 },
  veteran: { xp: 50, fire: 1.1, morale: 0.9 },
  elite: { xp: 90, fire: 1.2, morale: 0.8 },
};

export const RULES = {
  tickRate: 10,
  matchLength: 20 * 60,
  finalPushAt: 14 * 60,
  callInCutoff: 17 * 60,
  timePressureAt: 10 * 60, // army morale starts to drain on both sides from here
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
  rallyAtNearGeneral: 20, // routed troops reaching the general rally sooner
  generalRallyBoost: 3, // and get their nerve back this many times faster

  commandRadius: 600, // regiments this close to the general get orders at once and steadier morale
  courierSpeed: 100, // orders to regiments outside the command radius are carried by a rider
  courierInterceptRange: 80, // enemy cavalry this close to a rider captures the order
  commandMoraleTaken: 0.85, // morale loss multiplier inside the command radius
  commandMoraleRecovery: 1.5, // morale recovery multiplier inside the command radius
  generalLossMorale: 15, // army morale lost for good when the general falls
  brigadeSize: 4, // regiments per infantry brigade

  // Fatigue (0 fresh to 100 exhausted), points per second.
  fatigueMarch: 0.15,
  fatigueMove: 0.3,
  fatigueCharge: 1.2,
  fatigueMelee: 1.5,
  fatigueFiring: 0.25,
  fatigueRest: 0.8,
  fatigueSpeedLoss: 0.35, // share of speed lost when exhausted
  fatigueFireLoss: 0.3, // share of firepower lost when exhausted
  fatigueMeleeLoss: 0.4, // share of melee strength lost when exhausted

  // Ammunition (100 = full), points per second of firing.
  ammoUse: 0.5,
  shellAmmo: 1.5, // per shell
  lowAmmo: 25, // below this, fire is halved
  resupplyRate: 2, // per second inside a wagon train's supply area (half that at depots and in the deployment zone)
  supplyRange: 900, // wagons send carts to troops this far away, without driving there themselves
  supplyAreaRadius: 220, // size of the supply area
  cartSpeed: 35, // supply carts drive to the area at this speed
  cartInterval: 10, // seconds between carts from one wagon train
  cartLoad: 25, // seconds one cart keeps the area supplied
  cartLead: 10, // a new cart sets off when the current load has this long left
  cartDamage: 30, // cart health (of 100) lost per second per enemy in range; a shell burst destroys it
  supplyFatigueRelief: 1.2, // extra fatigue recovered per second inside the supply area
  depotSupplyRadius: 300, // held depots refill regiments this close
  supplyCap: 3, // supply wagons per side (each army starts with 2)
  autoSupplyMinNeed: 15, // carts only go where missing ammunition and fatigue add up to this much

  calledInXp: 0, // reinforcements arrive green
  coreXp: 25, // the starting army is trained
  xpPerKill: 60, // experience for destroying a regiment's worth of men
  xpCombat: 0.03, // per second in combat


  rallySafeDistance: 450,
  moraleRecovery: 0.6, // per second when not under pressure
  fortifyTime: 10, // digging in (only possible out of combat) takes this long before the bonuses apply
  artilleryFortifyTime: 5, // guns have to set up (fortify) before they can fire
  combatRange: 500, // a unit with a visible enemy this close, or under fire, counts as in combat
  moveSpeedScale: 4.5, // multiplies every unit's base speed

  artilleryCap: 3, // batteries per side, including ones on the way
  bombardRadius: 130, // shells land at random inside this circle
  shellBlast: 70, // radius of each shell's explosion
  shellDamage: 55, // casualties from a direct hit at full battery strength
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
  townDeployRadius: 450, // starting regiments can be repositioned this close to their home towns
  zoneStart: 0, // distance of each deployment strip from its own map edge
  zoneDepth: 700, // depth of each deployment strip
};

export const MAP = { width: 3800, height: 3000 };
