import { MAP_OPTIONS } from './map';

/**
 * Uneven maps are not mirror images, so some layouts favour one side. Map seeds 1 to 120 were each played 20 times
 * by the AI against itself. Maps where one side won 15 or more were dropped; maps where it won 13 or 14 were played
 * 20 more times and kept only if neither side won more than 26 of the 40. That kept 88 of the 120 (side 0 won 49.5%
 * over all of them). Any change to generateMap changes what each seed draws, so the list must then be vetted again
 * (scratch/vet.ts).
 */
export const FAIR_MAPS: number[] = [1, 4, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 22, 23, 24, 26, 27, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 40, 41, 43, 44, 46, 47, 48, 49, 50, 51, 53, 54, 56, 58, 59, 61, 62, 63, 64, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 88, 89, 91, 93, 94, 96, 97, 98, 100, 101, 102, 104, 105, 111, 112, 113, 114, 116, 118, 119, 120];

/** The battlefield for a battle seed: one of the vetted maps on uneven maps, else the seed itself. */
export function mapFor(seed: number): number {
  const n = FAIR_MAPS.length;
  return MAP_OPTIONS.uneven && n ? FAIR_MAPS[(((seed - 1) % n) + n) % n] : seed;
}
