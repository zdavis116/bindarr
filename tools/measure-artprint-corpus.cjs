// MEASURE THE ARTWORK FINGERPRINT AGAINST ZACH'S REAL SCANS.
//
// Claim under test, from his session on 7629f47:
//   "The scanner just keeps scanning doesn't wait for a new card to be put
//    down."
//
// The fingerprint decides "is this a DIFFERENT card?" A false "different"
// re-arms capture on a card that never moved -- which is continuous scanning.
//
// The threshold (10) was tuned on SYNTHETIC consecutive frames. This measures it
// on the real capture pipeline instead: same-card pairs must sit well below the
// threshold, different-card pairs well above.
const fs = require('fs');
const path = require('path');
const sharp = require('/opt/bindarr-dev/backend/node_modules/sharp');

const DIR = '/var/lib/bindarr-dev/scandump';
const ART = { left: 0.12, top: 0.13, width: 0.76, height: 0.42 };
const GRID = 8;
const DW = 160;

// Reproduce artFingerprint over a whole-frame box, matching the preview loop's
// detection buffer size.
function fingerprint(data, w, h, box) {
  const ax = box.x + box.w * ART.left;
  const ay = box.y + box.h * ART.top;
  const aw = box.w * ART.width;
  const ah = box.h * ART.height;
  const out = new Float64Array(GRID * GRID);
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const px = Math.round(ax + aw * ((gx + 0.5) / GRID));
      const py = Math.round(ay + ah * ((gy + 0.5) / GRID));
      if (px < 0 || py < 0 || px >= w || py >= h) return null;
      const i = (py * w + px) * 3;
      out[gy * GRID + gx] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
  }
  return out;
}

function dist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

(async () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.jpg')).sort();
  // Pair each scan with its ground-truth sidecar so we know which pairs are
  // genuinely the same card.
  const items = [];
  for (const f of files) {
    const j = path.join(DIR, f.replace(/\.jpg$/, '.json'));
    if (!fs.existsSync(j)) continue;
    let truth;
    try { truth = JSON.parse(fs.readFileSync(j, 'utf8')).truth; } catch { continue; }
    if (!truth || !truth.name) continue;
    const img = sharp(path.join(DIR, f)).resize(DW, null).removeAlpha().raw();
    const { data, info } = await img.toBuffer({ resolveWithObject: true });
    const fp = fingerprint(data, info.width, info.height,
      { x: 0, y: 0, w: info.width, h: info.height });
    if (!fp) continue;
    items.push({ f, key: `${truth.name}|${truth.set_id}|${truth.number}`, fp, t: Number(f.match(/\d+/)[0]) });
  }
  items.sort((a, b) => a.t - b.t);
  console.log(`labelled scans usable: ${items.length}`);

  const same = [];
  const diff = [];
  for (let i = 1; i < items.length; i++) {
    const d = dist(items[i].fp, items[i - 1].fp);
    (items[i].key === items[i - 1].key ? same : diff).push(d);
  }
  const stat = (a) => {
    if (!a.length) return 'n=0';
    const s = [...a].sort((x, y) => x - y);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
    return `n=${s.length} min=${s[0].toFixed(1)} p50=${q(0.5).toFixed(1)} p95=${q(0.95).toFixed(1)} max=${s[s.length - 1].toFixed(1)}`;
  };
  console.log('CONSECUTIVE captures, SAME card :', stat(same));
  console.log('CONSECUTIVE captures, DIFF card :', stat(diff));

  const T = 10;
  const falseDiff = same.filter((d) => d >= T).length;
  const missed = diff.filter((d) => d < T).length;
  console.log(`\nat threshold ${T}:`);
  console.log(`  same-card pairs called DIFFERENT (=> nonstop rescan): ${falseDiff}/${same.length}`);
  console.log(`  diff-card pairs called SAME (=> missed card, tap):    ${missed}/${diff.length}`);
})();
