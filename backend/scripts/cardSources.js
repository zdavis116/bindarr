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

// MTG: Scryfall unique_artwork bulk — one JSON file, no key.
async function gatherMtg(http) {
  console.log('Fetching Scryfall bulk-data index...');
  const bulkIndex = await http.get('https://api.scryfall.com/bulk-data');
  const entry = (bulkIndex.data.data || []).find(d => d.type === 'unique_artwork');
  if (!entry) throw new Error('unique_artwork bulk entry not found');
  console.log(`Downloading ${entry.type} (${(entry.size / 1e6).toFixed(0)} MB)...`);
  const bulkResp = await http.get(entry.download_uri, { responseType: 'json' });
  const cards = bulkResp.data;
  console.log(`Bulk contains ${cards.length} cards.`);
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
  for (const c of cards) {
    for (const img of faceImgs(c)) {
      if (seen.has(img)) continue;
      seen.add(img);
      out.push({ name: c.name || '', set: c.set || '', number: c.collector_number || '', img });
    }
  }
  return out;
}

module.exports = { makeHttp, gatherMtg, sleep };
