#!/usr/bin/env node
// WHERE DOES THE SCAN TIME GO?
//
// Reads SCAN_PROFILE lines and reports the per-stage breakdown, sorted by total
// cost. The output is meant to answer one question: what should we fix first?
//
// The number to watch is UNACCOUNTED. If it is large, there is real time we are
// still not measuring and the breakdown below it is not the whole story.
//
//   ssh root@bindarr-dev 'journalctl -u bindarr-dev --since "1 hour ago" --no-pager' \
//     | node scripts/profile-report.js
'use strict';

const fs = require('fs');
const readline = require('readline');

const src = process.argv[2] && process.argv[2] !== '-'
  ? fs.createReadStream(process.argv[2]) : process.stdin;

const rows = [];
readline.createInterface({ input: src, crlfDelay: Infinity })
  .on('line', (line) => {
    const i = line.indexOf('SCAN_PROFILE ');
    if (i < 0) return;
    try { rows.push(JSON.parse(line.slice(i + 'SCAN_PROFILE '.length))); } catch { /* partial */ }
  })
  .on('close', () => {
    if (!rows.length) {
      console.log('No SCAN_PROFILE lines. Is SCAN_PROFILE=1 set on the service?');
      process.exit(0);
    }

    const pc = (arr, p) => {
      const v = [...arr].sort((a, b) => a - b);
      return v[Math.min(v.length - 1, Math.floor(v.length * p / 100))];
    };
    const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(2) + 's' : Math.round(n) + 'ms');

    const totals = rows.map(r => r.total);
    console.log('='.repeat(70));
    console.log(`SCAN PROFILE — ${rows.length} scans`);
    console.log('='.repeat(70));
    console.log(`\n  TOTAL   p50 ${fmt(pc(totals, 50))}   p95 ${fmt(pc(totals, 95))}   ` +
      `min ${fmt(Math.min(...totals))}   max ${fmt(Math.max(...totals))}`);
    console.log(`  Bar to beat: ManaBox ~1 card/second (1000ms)\n`);

    // Aggregate every stage across every scan.
    const agg = new Map();
    for (const r of rows) {
      for (const [name, ms] of r.stages || []) {
        if (!agg.has(name)) agg.set(name, []);
        agg.get(name).push(ms);
      }
      if (!agg.has('UNACCOUNTED')) agg.set('UNACCOUNTED', []);
      agg.get('UNACCOUNTED').push(r.unaccounted ?? 0);
    }

    const p50Total = pc(totals, 50);
    const table = [...agg.entries()]
      .map(([name, v]) => ({ name, p50: pc(v, 50), p95: pc(v, 95), n: v.length }))
      .sort((a, b) => b.p50 - a.p50);

    console.log('  STAGE                      p50        p95      share of p50 scan');
    console.log('  ' + '-'.repeat(66));
    for (const s of table) {
      const share = p50Total ? (100 * s.p50 / p50Total) : 0;
      const bar = '#'.repeat(Math.max(0, Math.round(share / 2.5)));
      console.log(`  ${s.name.padEnd(24)} ${fmt(s.p50).padStart(7)}  ${fmt(s.p95).padStart(8)}` +
        `   ${share.toFixed(1).padStart(5)}%  ${bar}`);
    }

    // Payload sizes -- the upload is the client-side cost the server never sees
    // in its own timings, and it is a prime suspect for the felt slowness.
    const bytes = rows.filter(r => r.bytes).map(r => r.bytes);
    const resp = rows.filter(r => r.respBytes).map(r => r.respBytes);
    if (bytes.length) {
      console.log(`\n  UPLOAD   p50 ${(pc(bytes, 50) / 1024).toFixed(0)}KB   ` +
        `p95 ${(pc(bytes, 95) / 1024).toFixed(0)}KB`);
      console.log('    NOTE: the phone spends time uploading this BEFORE the server');
      console.log('    starts timing. Server total understates what Zach feels.');
    }
    if (resp.length) {
      console.log(`  RESPONSE p50 ${(pc(resp, 50) / 1024).toFixed(0)}KB   ` +
        `p95 ${(pc(resp, 95) / 1024).toFixed(0)}KB  (mostly the base64 thumbnail)`);
    }

    const shadow = rows.filter(r => r.shadowMs != null).map(r => r.shadowMs);
    if (shadow.length) {
      console.log(`\n  shadow mode cost (would disappear if turned off): p50 ${fmt(pc(shadow, 50))}`);
    }

    // What is actually worth fixing.
    console.log('\n' + '='.repeat(70));
    const un = pc(agg.get('UNACCOUNTED') || [0], 50);
    if (un > p50Total * 0.15) {
      console.log(`  ${fmt(un)} of the p50 scan is UNACCOUNTED (${(100 * un / p50Total).toFixed(0)}%).`);
      console.log('  Find that before optimising anything below it.');
    }
    const top = table.filter(s => s.name !== 'UNACCOUNTED').slice(0, 3);
    console.log('\n  Biggest measured costs:');
    for (const s of top) {
      console.log(`    ${s.name.padEnd(24)} ${fmt(s.p50)}  ` +
        `-> removing it entirely gets p50 to ${fmt(p50Total - s.p50)}`);
    }
    const removable = top.reduce((a, s) => a + s.p50, 0);
    console.log(`\n  Even removing all three: ${fmt(p50Total - removable)} ` +
      `(bar is 1000ms)`);
    console.log('='.repeat(70));
  });
