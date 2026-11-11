// Build guard: "no gradients, anywhere" is a hard product rule, so a bundle
// that reintroduces one must never ship. Runs after vite build.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DIST = path.resolve(import.meta.dirname, '..', 'dist');
const BANNED = /createRadialGradient|createLinearGradient|linear-gradient\(|radial-gradient\(|conic-gradient\(|<linearGradient|<radialGradient/;

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );

const hits = walk(DIST)
  .filter((f) => /\.(js|css|html|svg)$/.test(f))
  .filter((f) => BANNED.test(readFileSync(f, 'utf8')));

if (hits.length) {
  console.error('\n✗ gradient found in the build — flat colours only:');
  for (const h of hits) console.error('  ' + path.relative(DIST, h));
  process.exit(1);
}
console.log('✓ no gradients in bundle');
