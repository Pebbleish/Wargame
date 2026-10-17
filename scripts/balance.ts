// Plays AI-vs-AI battles headlessly and prints how they went. Run: npx vite-node scripts/balance.ts

import { AI } from '../src/sim/ai';
import { World } from '../src/sim/world';

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
for (let seed = 1; seed <= 8; seed++) {
  const w = new World(seed);
  const ais = [new AI(0), new AI(1)];
  const marks: string[] = [];
  let nextMark = 300;
  while (w.phase !== 'ended') {
    for (const ai of ais) for (const c of ai.update(w)) w.apply(c);
    w.step();
    if (w.phase === 'battle' && w.time >= nextMark) {
      marks.push(`${fmt(w.time)} am ${w.sides[0].armyMorale.toFixed(0)}/${w.sides[1].armyMorale.toFixed(0)} u ${w.units.filter(u=>u.side===0).length}/${w.units.filter(u=>u.side===1).length} own ${w.owners.join('')}`);
      nextMark += 300;
    }
  }
  const s = w.sides;
  console.log(`seed ${seed}: ${fmt(w.time)} winner ${w.result?.winner} (${w.result?.reason}) score ${s[0].score.toFixed(1)}-${s[1].score.toFixed(1)} lost ${s[0].lostMen.toFixed(0)}/${s[1].lostMen.toFixed(0)} fielded ${s[0].fieldedMen}/${s[1].fieldedMen}`);
  for (const m of marks) console.log('   ', m);
}

