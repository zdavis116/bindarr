#!/usr/bin/env node
/**
 * READ-ONLY LOAD MEASUREMENT.
 *
 * Zach: "I would like you measure a bunch of load times across the app
 * especially the catalogue because I want to make sure in the future it can
 * handle 10k cards."
 *
 * WHAT THIS IS NOT: a fix. It changes nothing and optimises nothing. It
 * produces the numbers we argue from, because a performance decision made from
 * a guess is how you spend a week on the wrong query.
 *
 * METHOD
 *   - Every endpoint is called WARM (one discarded call first), then N times.
 *   - Reports median and p95, not mean: one 2-second outlier hidden in an
 *     average is exactly the stall a user notices.
 *   - GET only, plus explicitly listed safe POSTs. Nothing here mutates.
 *
 * Usage: node bench.js <baseUrl> <user> <pass> [runs]
 */
const BASE = process.argv[2] || 'http://localhost:3002';
const USER = process.argv[3] || 'admin';
const PASS = process.argv[4] || 'bindarr';
const RUNS = Number(process.argv[5] || 7);

const ms = (a, b) => Number(b - a) / 1e6;

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { median: at(0.5), p95: at(0.95), min: s[0], max: s[s.length - 1] };
}

async function timed(url, opts) {
  const t0 = process.hrtime.bigint();
  const res = await fetch(url, opts);
  const body = await res.arrayBuffer();          // include transfer, as a client would
  return { ms: ms(t0, process.hrtime.bigint()), status: res.status, bytes: body.byteLength };
}

(async () => {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS })
  });
  const { token } = await login.json();
  if (!token) { console.error('login failed'); process.exit(1); }
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const decks = await (await fetch(`${BASE}/api/decks`, { headers: H })).json();
  const deckList = Array.isArray(decks) ? decks : (decks.decks || []);
  const d = deckList[0]?.id;

  // Scale context, so a number is never reported without the size it was measured at.
  const stats_ = await (await fetch(`${BASE}/api/stats`, { headers: H })).json().catch(() => ({}));

  const targets = [
    ['health',                 `/api/health`],
    ['auth/me',                `/api/auth/me`],
    ['DECK LIST',              `/api/decks`],
    ['deck detail',            d && `/api/decks/${d}`],
    ['deck buylist',           d && `/api/decks/${d}/buylist`],
    ['deck repoint-cands',     d && `/api/decks/${d}/repoint-candidates`],
    ['deck locations',         d && `/api/decks/${d}/locations`],
    ['COLLECTION p1 (50)',     `/api/collection?page=1&limit=50`],
    ['collection p1 (200)',    `/api/collection?page=1&limit=200`],
    ['collection deep page',   `/api/collection?page=20&limit=50`],
    ['collection sort:price',  `/api/collection?page=1&limit=50&sort=price`],
    ['collection search',      `/api/collection?page=1&limit=50&search=dragon`],
    ['CATALOGUE search',       `/api/search?name=dragon&game=mtg`],
    ['catalogue search (1ch)', `/api/search?name=a&game=mtg`],
    ['catalogue commanders',   `/api/search?name=dragon&game=mtg&commanders=1`],
    ['settings/catalogue',     `/api/settings/catalogue`],
    ['stats',                  `/api/stats`],
    ['sets',                   `/api/sets`],
    ['moxfield account',       `/api/moxfield/account`],
    ['moxfield decks (LIVE)',  `/api/moxfield/decks`],
    ['scan-queue',             `/api/scan-queue`],
    ['scan-stage',             `/api/scan-stage`],
  ].filter(([, u]) => u);

  const out = [];
  for (const [label, path] of targets) {
    try {
      await timed(BASE + path, { headers: H });            // warm
      const runs = [];
      let status = 0, bytes = 0;
      for (let i = 0; i < RUNS; i++) {
        const r = await timed(BASE + path, { headers: H });
        runs.push(r.ms); status = r.status; bytes = r.bytes;
      }
      out.push({ label, path, status, bytes, ...stats(runs) });
    } catch (e) {
      out.push({ label, path, status: 'ERR', error: e.message });
    }
  }

  console.log(JSON.stringify({
    base: BASE,
    when: new Date().toISOString(),
    runs: RUNS,
    scale: { collection: stats_.total_cards ?? stats_.cards ?? null, unique: stats_.unique_cards ?? null },
    results: out
  }, null, 2));
})();
