import Phaser from 'phaser';
import { BattleScene } from './game/BattleScene';
import { CampaignScene } from './game/CampaignScene';
import { EditorScene } from './game/EditorScene';
import { TitleScreen } from './game/title';

function start() {
  new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: '#1d1b16',
    scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
    scene: [BattleScene, EditorScene, CampaignScene],
  });
  new TitleScreen(document.getElementById('app')!);
}

// Wait briefly for the serif font so map labels render in it, but never block the game on it.
Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]).then(start);
