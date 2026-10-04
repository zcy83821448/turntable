import { build } from 'esbuild';
import { statSync } from 'node:fs';

const out = 'dist/app.js';
await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  outfile: out,
  format: 'iife',
  target: ['chrome110', 'firefox110', 'safari16'],
  minify: process.argv.includes('--min'),
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  /* The deck is a real exported model rather than code, and it has to reach the
     page without a single network request — `GLTFLoader` fetches, and a fetch
     from a `file://` page is blocked as a cross-origin request. esbuild's
     `binary` loader is the whole fix: the GLB becomes a Uint8Array inside the
     bundle, so the page still opens by double-clicking it. */
  loader: { '.glb': 'binary' },
});
console.log(`\n🎛  dist/app.js  ${(statSync(out).size / 1024).toFixed(0)} KB`);
