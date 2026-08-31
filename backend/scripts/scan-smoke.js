// SMOKE TEST — push real dumped scans through the LIVE route and confirm
// shadow mode actually fires. Run ON the dev box.
//
// The service starting is not evidence that shadow mode works: the index loads
// lazily on the first scan, so every interesting failure (missing file, bad
// path, corrupt transfer, hash mismatch) is invisible until a real photo goes
// through. This forces that to happen.
//
//   TOK=<session token> node scripts/scan-smoke.js 12
//
// The token comes from the sessions table; the route is authenticated. Three
// things that cost time the first time round, recorded so they don't again:
//   - dev serves plain HTTP on 3002, not HTTPS
//   - the route is /api/scan-match — collection.js mounts at BARE /api
//   - without TOK you get 401, with a wrong path 404; neither looks like a
//     scanner problem, so check those before suspecting the pipeline
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const DIR = '/var/lib/bindarr-dev/scandump';
const N = Number(process.argv[2] || 3);
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.jpg')).slice(0, N);

function post(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: 3002, path: '/api/scan-match',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
                 Authorization: 'Bearer ' + (process.env.TOK || '') },
    }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  for (const f of files) {
    const img = fs.readFileSync(path.join(DIR, f)).toString('base64');
    const t0 = Date.now();
    const r = await post({ image: `data:image/jpeg;base64,${img}`, ocr: true });
    let top = null;
    try { top = JSON.parse(r.body).candidates?.[0]?.name; } catch { /* non-JSON */ }
    console.log(`${f}  HTTP ${r.status}  ${Date.now() - t0}ms  top=${top}`);
  }
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
