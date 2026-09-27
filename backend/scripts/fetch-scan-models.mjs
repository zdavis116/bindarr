// Fetch the on-device scanner's models and write the charset the reader decodes
// against.
//
// THREE PIECES, ALL PUBLIC, AND THE PROVENANCE MATTERS:
//
//   cornelius.onnx (3.2 MB, MIT) -- predicts the card's four corners from a
//   384x384 frame. Outputs `corners` [1,8], `presence` [1], `sharpness` [1];
//   pipeline.mjs gates on sharpness before trusting the quad.
//
//   PP-OCRv6_small_rec.onnx (21.2 MB, Apache-2.0) -- the text recognizer, from
//   PaddlePaddle directly. This is the SAME model the upstream project uses; it
//   renames the file after content-hashing it, which is why searching for their
//   filename finds nothing. Input [N,3,48,W], output [N,T,18710].
//
//   rec-dict.txt -- the 18,708-entry charset the CTC decoder maps class indices
//   to. NOT a separate download: it is embedded in the model repo's
//   inference.yml under PostProcess/character_dict. A recognizer without its
//   exact charset decodes to confident-looking garbage, so this is extracted
//   from the same release as the weights rather than sourced independently.
//
// Usage: node fetch-scan-models.mjs <outDir>

import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2];
if (!OUT) { console.error('usage: node fetch-scan-models.mjs <outDir>'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const HF = 'https://huggingface.co';

// Sizes are ASSERTED, not assumed. A truncated ONNX file fails at session
// creation with a protobuf error that says nothing about the download, and a
// truncated charset decodes every read to the wrong characters while looking
// like a working scanner.
const ASSETS = [
  {
    name: 'cornelius.onnx',
    url: `${HF}/HanClinto/ccgdetector-fastweb-single/resolve/main/fastweb-single-1.39.onnx`,
    bytes: 3185226,
    license: 'MIT',
  },
  {
    name: 'rec.onnx',
    url: `${HF}/PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/main/inference.onnx`,
    bytes: 21159378,
    license: 'Apache-2.0',
  },
];

async function download(a) {
  const dest = path.join(OUT, a.name);
  if (fs.existsSync(dest) && fs.statSync(dest).size === a.bytes) {
    console.log(`${a.name}: already present (${a.bytes} bytes)`);
    return;
  }
  process.stdout.write(`${a.name}: downloading... `);
  const res = await fetch(a.url, { redirect: 'follow', signal: AbortSignal.timeout(600000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${a.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== a.bytes) {
    throw new Error(`${a.name}: expected ${a.bytes} bytes, got ${buf.length}. Refusing to write a truncated model.`);
  }
  fs.writeFileSync(dest, buf);
  console.log(`ok (${(buf.length / 1e6).toFixed(1)} MB, ${a.license})`);
}

for (const a of ASSETS) await download(a);

// --- the charset -------------------------------------------------------------
// inference.yml is ~150 KB of config with the character list inside it. Parsing
// it as YAML would pull in a dependency for one field; the list is a flat block
// of `  - <char>` lines under `character_dict:`, so it is read directly.
//
// Read from the MODEL'S OWN release, never from a third-party copy: the CTC
// decoder maps class index -> character positionally, so a charset that is
// correct-looking but differently ordered silently mistranslates every read.
const dictPath = path.join(OUT, 'rec-dict.txt');
if (!fs.existsSync(dictPath)) {
  process.stdout.write('rec-dict.txt: extracting from inference.yml... ');
  const yml = await (await fetch(`${HF}/PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/main/inference.yml`)).text();
  const lines = yml.split('\n');
  const start = lines.findIndex(l => /^\s*character_dict:\s*$/.test(l));
  if (start < 0) throw new Error('character_dict not found in inference.yml');
  const chars = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(\s*)- (.*)$/.exec(lines[i]);
    if (!m) break;                      // the block ended
    // A YAML scalar may be quoted; strip one layer if present.
    let c = m[2];
    if ((c.startsWith("'") && c.endsWith("'")) || (c.startsWith('"') && c.endsWith('"'))) c = c.slice(1, -1);
    chars.push(c);
  }
  // The model's output layer is 18710 wide: 18708 characters + CTC blank + a
  // trailing space class. If the extracted count disagrees, the decode would be
  // offset and every read would be subtly wrong, so this refuses instead.
  if (chars.length !== 18708) {
    throw new Error(`charset: expected 18708 entries, extracted ${chars.length}. Refusing to write a misaligned dict.`);
  }
  fs.writeFileSync(dictPath, chars.join('\n') + '\n');
  console.log(`ok (${chars.length} characters)`);
} else {
  console.log(`rec-dict.txt: already present`);
}

console.log(`\nwrote to ${OUT}`);
console.log('licenses: cornelius MIT, PP-OCRv6 Apache-2.0');
