import Phaser from 'phaser';
import { BattleScene } from './game/BattleScene';

function start() {
  new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: '#1d1b16',
    scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
    scene: [BattleScene],
  });
}

// Wait briefly for the serif font so map labels render in it, but never block the game on it.
Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]).then(start);
