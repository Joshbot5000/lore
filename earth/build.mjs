// Bundles the game, its data and three.js into ONE self-contained index.html so it can be
// installed to a home screen and played with no network at all.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
const out = new URL('../play/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const r = await build({ entryPoints: ['src/main.js'], bundle: true, minify: true, format: 'iife', target: 'es2020', write: false,
  loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.json': 'json' }, legalComments: 'none' });
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = readFileSync('src/index.html', 'utf8').replace('/*BUNDLE*/', () => js);
writeFileSync(out + 'index.html', html);
for (const f of ['sw.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png']) copyFileSync('static/' + f, out + f);
console.log('built', (html.length / 1e6).toFixed(2) + ' MB');
