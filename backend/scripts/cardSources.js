// Shared card-image sources for the embedding build. Returns a flat list of
// { name, set, number, img } where img is a reasonably high-res image URL
// (better than the tiny hash images — CLIP resizes to 224 and benefits from a
// sharp downsample rather than an upscaled thumbnail).
const axios = require('axios');

function makeHttp() {
  return axios.create({
    timeout: 30000,
    headers: { 'User-Agent': 'Bindarr/1.0', 'Accept': 'application/json' },
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// MTG: Scryfall unique_artwork bulk.
//
// SCRYFALL CHANGED THIS API AND THIS SCRIPT WAS NEVER UPDATED, which is why no
// global scan index has ever existed on any Bindarr box: the build failed at
// the first download every time it was attempted. Two renames and a format
// change:
//
//   size          -> compressed_size
//   download_uri  -> jsonl_download_uri
//   one JSON array -> JSONL, one card object per line
//
// backend/src/cardCatalogue.js already handles the current shape (it was
// written later); the fallbacks below match its approach so the two cannot
// disagree about where the bulk file lives.
//
// The file is parsed as a STREAM rather than buffered. Decompressed it is
// several hundred MB, and the dev box has 2GB of RAM shared with the CLIP
// model - holding the whole text plus the parsed array would risk an OOM kill
// partway through a multi-hour build.
async function gatherMtg(http) {
  console.log('Fetching Scryfall bulk-data index...');
  const bulkIndex = await http.get('https://api.scryfall.com/bulk-data');
  const entry = (bulkIndex.data.data || []).find(d => d.type === 'unique_artwork');
  if (!entry) throw new Error('unique_artwork bulk entry not found');

  const url = entry.jsonl_download_uri || entry.download_uri;
  if (!url) {
    // Fail with the shape we actually got. A bare "cannot read undefined"
    // three frames deep in axios tells you nothing about which field moved.
    throw new Error(
      `unique_artwork entry has no download URL. Keys present: ${Object.keys(entry).join(', ')}`
    );
  }
  const bytes = entry.compressed_size || entry.size;
  const sizeLabel = bytes ? `${(bytes / 1e6).toFixed(0)} MB` : 'size unknown';
  const isJsonl = Boolean(entry.jsonl_download_uri);
  console.log(`Downloading ${entry.type} (${sizeLabel}, ${isJsonl ? 'JSONL' : 'JSON'})...`);

  // One image per scannable face: single-image layouts give one; double-faced
  // cards (transform, modal DFC, art series, reversible) give one per face so
  // scanning either side matches. Dedupe by image URL (unique_artwork already
  // yields one card per illustration, but a DFC may surface once per face).
  const faceImgs = (c) => {
    const top = c.image_uris?.normal || c.image_uris?.small;
    if (top) return [top];
    return (c.card_faces || []).map(f => f.image_uris?.normal || f.image_uris?.small).filter(Boolean);
  };

  const seen = new Set();
  const out = [];
  let cardCount = 0;
  const take = (c) => {
    if (!c || typeof c !== 'object') return;
    cardCount += 1;
    for (const img of faceImgs(c)) {
      if (seen.has(img)) continue;
      seen.add(img);
      out.push({ name: c.name || '', set: c.set || '', number: c.collector_number || '', img });
    }
  };

  if (isJsonl) {
    const readline = require('readline');
    const zlib = require('zlib');
    const { pipeline } = require('stream');
    const resp = await http.get(url, { responseType: 'stream' });

    // The jsonl endpoint serves a GZIPPED file (.jsonl.gz, content-type
    // application/gzip). axios in stream mode hands back the raw compressed
    // bytes, so it must be gunzipped before any line reading - feeding the
    // compressed stream straight to readline yields ~290k unparseable lines
    // and zero cards.
    //
    // Decided from the response itself rather than the filename: a URL can be
    // renamed, but the gzip magic number cannot lie.
    const enc = String(resp.headers?.['content-type'] || '');
    const gzipped = url.endsWith('.gz') || enc.includes('gzip');

    let input = resp.data;
    if (gzipped) {
      const gunzip = zlib.createGunzip();
      // pipeline (not .pipe) so a decompression failure propagates instead of
      // silently ending the stream and looking like an empty catalogue.
      pipeline(resp.data, gunzip, (err) => {
        if (err) gunzip.destroy(err);
      });
      input = gunzip;
    }

    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    let bad = 0;
    for await (const line of rl) {
      const t = line.trim();
      if (!t || t === '[' || t === ']') continue;
      // Tolerate a trailing comma if Scryfall ever serves an array-ish body
      // through the jsonl endpoint.
      const cleaned = t.endsWith(',') ? t.slice(0, -1) : t;
      try {
        take(JSON.parse(cleaned));
      } catch {
        bad += 1;
      }
    }
    // A handful of unparseable lines is tolerable; a mostly-unparseable file
    // means the format changed again and the caller must not proceed to build
    // an index from a fraction of the catalogue.
    if (bad > 0) console.warn(`Skipped ${bad} unparseable line(s).`);
    if (cardCount === 0) throw new Error('Bulk stream yielded no cards - format may have changed again');
  } else {
    const bulkResp = await http.get(url, { responseType: 'json' });
    const cards = bulkResp.data;
    if (!Array.isArray(cards)) throw new Error('Expected a JSON array of cards');
    for (const c of cards) take(c);
  }

  console.log(`Bulk contains ${cardCount} cards; ${out.length} scannable images.`);
  return out;
}

module.exports = { makeHttp, gatherMtg, sleep };
