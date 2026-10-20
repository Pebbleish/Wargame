/**
 * The win-chance model: how likely a side is to win from here, given what it knows (AI.features). A logistic
 * regression fitted on 48,000 moments from 400 AI battles (a quarter of them against the sparring bots), checked on
 * battles it was not fitted on: it picks the eventual winner 77% of the time at minutes 3 to 6, 87% at 6 to 9
 * and 91% after that (army morale alone: 74%, 83%, 87%).
 * Features: morale gap, morale gap x time, towns held gap / 3, the same x time, points gap / 5,
 * log strength ratio, the same x time, own morale x time, enemy morale x time, own manpower / 1000.
 */
const WEIGHTS = [2.3111, 10.811, 0.0767, -0.0829, 0.1089, 0.0479, 6.3589, 4.4227, -3.8506, -0.053];
const BIAS = -0.1588;

export function winChance(f: number[]): number {
  let z = BIAS;
  for (let i = 0; i < WEIGHTS.length; i++) z += WEIGHTS[i] * f[i];
  return 1 / (1 + Math.exp(-z));
}

/** The same features after a change: towns held (in towns), army morale gap (in points), and log strength ratio. */
export function whatIf(f: number[], t: number, dHeld: number, dMorale: number, dRatio: number): number[] {
  const g = f.slice();
  g[0] += dMorale / 100;
  g[1] += (dMorale / 100) * t;
  g[2] += dHeld / 3;
  g[3] += (dHeld / 3) * t;
  g[5] += dRatio;
  g[6] += dRatio * t;
  g[7] += (dMorale / 200) * t;
  g[8] -= (dMorale / 200) * t;
  return g;
}
