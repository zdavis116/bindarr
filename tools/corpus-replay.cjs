// CORPUS REPLAY: what does every labelled scan resolve to, and how long does it
// take?
//
// Run BEFORE and AFTER the ORB/OCR reorder. The only acceptable outcome is that
// every scan resolves to the SAME printing as before -- this changes the code
// that decides which card Zach owns, and a faster scanner that occasionally
// picks a different card is a straight downgrade.
//
// Writes one JSON line per scan so the two runs can be diffed exactly rather
// than compared by eye or by summary statistics. A p50 that looks the same can
// hide two cards swapping identity.
//
// Usage:
//   INDEX_DATA_DIR=/var/lib/bindarr-dev/index \
//   RGBART_INDEX=/var/lib/bindarr-dev/rgbart-index.bin \
//   DB_PATH=/var/lib/bindarr-dev/bindarr.db \
//   node corpus-replay.cjs /tmp/before.jsonl
const fs = require('fs');
const path = require('path');

const BASE = '/opt/bindarr-dev/backend/src';
const scanMatch = require(`${BASE}/scanMatch.js`);
const collectorNumberOcr = require(`${BASE}/utils/collectorNumberOcr.js`);
const cardTitleOcr = require(`${BASE}/utils/cardTitleOcr.js`);
const { parseCollectorStrip } = require(`${BASE}/utils/collectorNumberParse.js`);
const { resolveScannedPrinting } = require(`${BASE}/utils/scanPrintingResolver.js`);

const DIR = '/var/lib/bindarr-dev/scandump';
const OUT = process.argv[2] || '/tmp/replay.jsonl';
const norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/^0+/, '');

(async () => {
  const jsons = fs.readdirSync(DIR).filter(f => f.endsWith('.json')).sort();
  const items = [];
  for (const f of jsons) {
    const jpg = path.join(DIR, f.replace(/\.json$/, '.jpg'));
    if (!fs.existsSync(jpg)) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      if (d?.truth?.number && d?.truth?.set_id) items.push({ id: f, jpg, truth: d.truth });
    } catch { /* skip */ }
  }

  const out = fs.createWriteStream(OUT);
  let done = 0;

  for (const it of items) {
    const buf = fs.readFileSync(it.jpg);
    const t0 = Date.now();
    const rec = { id: it.id, truth: `${norm(it.truth.set_id)}#${norm(it.truth.number)}` };

    try {
      const tMatch = Date.now();
      // THE PRODUCTION SHAPE, including the pre-read when it is available.
      // Mirrors routes/collection.js: detect once, read the strip, then match
      // with that reading as a stop condition.
      let preprocessed = null;
      let ocrHint = null;
      if (process.env.REPLAY_PREREAD === '1') {
        try {
          preprocessed = await scanMatch.preprocessCardWithDetection(buf);
          if (preprocessed?.detect) {
            const sImg = await scanMatch.rectifyCard(buf, {
              width: collectorNumberOcr.OCR_W, height: collectorNumberOcr.OCR_H,
              detection: preprocessed.detect, region: collectorNumberOcr.STRIP,
            });
            if (sImg) {
              const r = await collectorNumberOcr.readCollectorStrip(sImg, { preCropped: true });
              const p2 = parseCollectorStrip(r || '');
              const numbers = [p2.number, p2.numberAlt].filter(Boolean);
              const sets = (p2.setCandidates?.length ? p2.setCandidates : [p2.set]).filter(Boolean);
              if (numbers.length && sets.length) ocrHint = { sets, numbers };
            }
          }
        } catch { /* pre-read failure is free */ }
      }
      rec.hadHint = !!ocrHint;
      const m = await scanMatch.match(buf, 'mtg', 8, '', {
        recallK: Number(process.env.REPLAY_K || 50), orb: 500, ocrHint, preprocessed,
      });
      rec.msMatch = Date.now() - tMatch;
      rec.candidates = (m.candidates || []).length;
      rec.orbTop = m.candidates?.[0]
        ? `${norm(m.candidates[0].set)}#${norm(m.candidates[0].number)}` : null;
      rec.orbTopInliers = m.candidates?.[0]?.inliers ?? null;

      const tOcr = Date.now();
      const [stripImg, titleImg] = await Promise.all([
        scanMatch.rectifyCard(buf, {
          width: collectorNumberOcr.OCR_W, height: collectorNumberOcr.OCR_H,
          detection: m.detection || undefined, region: collectorNumberOcr.STRIP,
        }),
        scanMatch.rectifyCard(buf, {
          width: collectorNumberOcr.OCR_W, height: collectorNumberOcr.OCR_H,
          detection: m.detection || undefined, region: cardTitleOcr.TITLE_BAND,
        }),
      ]);
      const [rawStrip, rawTitle] = await Promise.all([
        stripImg ? collectorNumberOcr.readCollectorStrip(stripImg, { preCropped: true }) : '',
        titleImg ? cardTitleOcr.readCardTitle(titleImg, { preCropped: true }) : '',
      ]);
      rec.msOcr = Date.now() - tOcr;
      rec.rawStrip = (rawStrip || '').replace(/\n/g, ' ').slice(0, 70);

      const parsed = parseCollectorStrip(rawStrip || '');
      rec.ocrNumber = parsed.number || null;
      rec.ocrSet = parsed.set || null;
      rec.ocrConfident = !!parsed.confident;

      // THE ACTUAL DECISION, called exactly as routes/collection.js:771 calls
      // it -- raw text in, the resolver does its own parsing. Passing a
      // pre-parsed object would measure a pipeline that does not exist.
      const outcome = await resolveScannedPrinting({
        matchedName: m.candidates?.[0]?.name || '',
        titleText: rawTitle || '',
        ocrText: rawStrip || '',
        userId: 1,
        matchInliers: m.candidates?.[0]?.inliers ?? null,
      });
      rec.action = outcome?.action || 'unknown';
      rec.reason = outcome?.reason || null;
      rec.resolved = outcome?.printing
        ? `${norm(outcome.printing.set_id)}#${norm(outcome.printing.number)}` : null;
      rec.correct = rec.resolved === rec.truth;
    } catch (e) {
      rec.error = e.message;
    }

    rec.msTotal = Date.now() - t0;
    out.write(`${JSON.stringify(rec)}\n`);
    done += 1;
    if (done % 25 === 0) process.stderr.write(`  ${done}/${items.length}\n`);
  }

  await new Promise(r => out.end(r));
  console.log(`wrote ${done} rows to ${OUT}`);
  await collectorNumberOcr.shutdown().catch(() => {});
  await cardTitleOcr.shutdown?.().catch(() => {});
  process.exit(0);
})();
