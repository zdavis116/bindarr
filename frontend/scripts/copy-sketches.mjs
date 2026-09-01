// Copy the design mockups into the build output.
//
// `vite build` empties dist/, so mockups served from dist/sketches/ are deleted
// by every deploy -- meaning the links I send Zach 404 exactly when he clicks
// them, and he sees raw HTML instead of a rendered page.
//
// Run as part of `npm run build` so it cannot be forgotten.
import { existsSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '../../sketches');
const dest = join(here, '../dist/sketches');

if (existsSync(src)) {
  cpSync(src, dest, { recursive: true });
  console.log('sketches copied into dist/');
} else {
  console.log('no sketches directory; skipping');
}
