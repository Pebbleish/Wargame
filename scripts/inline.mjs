// Inlines the built JavaScript into dist/index.html so the whole game is one shareable file.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const html = readFileSync('dist/index.html', 'utf8');
const js = readdirSync('dist/assets').find((f) => f.endsWith('.js'));
const code = readFileSync(`dist/assets/${js}`, 'utf8').replace(/<\/script/g, '<\\/script');
const out = html.replace(/<script type="module" crossorigin src="[^"]+"><\/script>/, () => `<script type="module">${code}</script>`);
if (out === html) throw new Error('Could not find the script tag to inline');
writeFileSync('dist/wargame.html', out);
console.log(`dist/wargame.html (${(out.length / 1024).toFixed(0)} KB)`);
