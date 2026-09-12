#!/usr/bin/env node
// GENERATE THE PWA ICONS FROM THE APP'S OWN LOGO.
//
// Zach: "I would like this to work as a pwa for my phone."
//
// The repo already had a manifest.webmanifest listing seven icons -- and no
// icons/ directory at all, so every one of them 404'd. It was also never linked
// from index.html, so no browser ever read it. A manifest nothing loads,
// pointing at files that do not exist, is the kind of thing that looks done in
// a file listing and has never once worked.
//
// The logo is drawn with CSS custom properties (var(--logo-cover, #ff4747)) so
// it can follow the theme in the browser. Outside a browser those variables do
// not resolve, so the fallbacks are inlined here before rasterising -- rendering
// it as-is produces a transparent square.
//
// A MASKABLE ICON NEEDS PADDING. Android crops installed icons to whatever
// shape the launcher uses (circle, squircle, rounded square). An icon drawn
// edge-to-edge loses its corners. The safe zone is the middle 80%, so the logo
// is drawn at 80% on a solid background -- which also means no transparency,
// which iOS renders as black.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '../../frontend');
const OUT = path.join(ROOT, 'public/icons');
const BG = '#0a0f1d';           // matches the manifest background_color
const SIZES = [48, 72, 96, 128, 192, 256, 512];

const raw = fs.readFileSync(path.join(ROOT, 'public/logo.svg'), 'utf8');

// Resolve every var(--x, fallback) to its fallback.
const solid = raw.replace(/var\(--[a-z-]+,\s*([^)]+)\)/g, '$1');
if (solid.includes('var(')) {
  console.error('FAIL: a CSS variable survived; the icon would render blank');
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });

(async () => {
  for (const size of SIZES) {
    const inner = Math.round(size * 0.8);      // 80% safe zone for maskable
    const pad = Math.round((size - inner) / 2);

    const logo = await sharp(Buffer.from(solid))
      .resize(inner, inner, { fit: 'contain',
                              background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    await sharp({
      create: { width: size, height: size, channels: 4, background: BG },
    })
      .composite([{ input: logo, top: pad, left: pad }])
      .png()
      .toFile(path.join(OUT, `icon-${size}.png`));

    const { width, height, channels } = await sharp(
      path.join(OUT, `icon-${size}.png`)).metadata();
    console.log(`  icon-${size}.png  ${width}x${height}  ${channels}ch`);
  }

  // Prove the icons are not blank: a solid-colour image would have a single
  // dominant channel value and near-zero deviation. This is the check that
  // would have caught the CSS-variable problem if I had not reasoned it out.
  const stats = await sharp(path.join(OUT, 'icon-512.png')).stats();
  const spread = Math.max(...stats.channels.map(c => c.stdev));
  console.log(`  pixel spread on icon-512: ${spread.toFixed(1)}`);
  if (spread < 5) {
    console.error('FAIL: icon looks blank (no variation) -- did the SVG render?');
    process.exit(1);
  }
  console.log('  OK: icons generated and verified non-blank');
})().catch(e => { console.error('THREW:', e.message); process.exit(1); });
