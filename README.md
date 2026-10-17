# War Game

A browser real-time tactics game in the style of a battle-history map: whole regiments as blocks, 20 to 30 minute battles, manpower and reinforcements. Built with [Phaser 3](https://phaser.io) and TypeScript. The design is in the project's game design document.

## Play it locally

1. Install [Node.js](https://nodejs.org) (the LTS version).
2. In this folder run `npm install` once.
3. Run `npm run dev` and open the address it prints (usually http://localhost:5173).

`npm run build:single` makes `dist/wargame.html`, the whole game in one file you can open in a browser or share.

## Controls

| Action | Control |
| --- | --- |
| Select | Left-click; drag a box; Shift to add; double-click for all of a type; Ctrl+A for all |
| Move | Right-click the ground (the group keeps its shape) |
| Form a line | Right-drag: regiments spread along the drag and face away from it |
| Attack | Right-click an enemy |
| Formation | F (line, column, square or skirmish) |
| Hold | H |
| Call in troops | Click a card at the bottom, then click inside your deployment zone |
| Pause, speed | Space, + and − |
| Camera | WASD or arrows, mouse wheel, middle-drag |

## What is in this prototype

- One map (two villages, two railway stations, a bridge, fords, woods and hills), Valdmark against an AI-controlled Ostmark.
- 90 second deployment with 8 pre-placed regiments and a 1,500 manpower budget.
- Line infantry, light infantry, cavalry, artillery and engineers; formations; automatic column marching on long moves.
- Fire, melee, cavalry charges, flanking, cover, morale, wavering, routing and one rally.
- Manpower income from objectives, call-ins with arrival timers and cooldowns, field cap, 25:00 cut-off, requisition, catch-up bonus.
- Army morale, objective points (doubled after 22:00), and a hard end at 30:00.

Not yet: multiplayer, the nation creator, doctrines, the skirmish campaign, sound and final art.

## Code layout

- `src/sim/` is the game rules. It has no graphics, uses a seeded random generator and a fixed 10 ticks per second, so the same commands always give the same battle. That is what lockstep multiplayer will need.
  - `config.ts` holds every tunable number (unit stats, costs, timers, income).
  - `world.ts` runs the battle; `ai.ts` is the computer opponent; `map.ts` is the battlefield.
- `src/game/` draws the battle with Phaser and handles input and the on-screen panels.
- `tests/` checks battles always end by 30:00, are deterministic and respect the field cap: `npm test`.
- `scripts/balance.ts` plays eight AI-versus-AI battles and prints how they went: `npx vite-node scripts/balance.ts`.
