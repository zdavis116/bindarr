// SCAN STAGE PROFILER.
//
// WHY THIS EXISTS. Zach stopped scanning at ~20 cards because the scanner is
// too slow to use. Measured server time is 2.1-4.9s per scan against a
// ManaBox-class bar of ~1 card/second. But the stages we have already measured
// only account for ~2.2s:
//
//     ORB matching ~1.6s, detection ~350ms, warp ~160ms, rgbArt 112ms
//
// leaving up to 2.5s unaccounted for on the slow scans. Optimising the parts we
// happen to have measured, while 2.5s hides somewhere else, is how you spend a
// week making a scan 20% faster.
//
// So: time EVERY stage, including the ones nobody has looked at (base64 decode,
// JPEG re-encode of the crop thumbnail, JSON serialisation, DB hydration), and
// let the numbers choose the target.
//
// DESIGN RULES, same as the other diagnostics in this codebase:
//   - fire-and-forget, fully swallowed: it must never fail a scan of a card
//     Zach is physically holding
//   - off unless SCAN_PROFILE=1
//   - no behaviour change of any kind when on
'use strict';

const ENABLED = !!process.env.SCAN_PROFILE;

// A profiler instance per request. When disabled every method is a no-op, so
// the hot path pays a boolean test and nothing else.
function start(meta) {
  if (!ENABLED) return NOOP;
  const t0 = process.hrtime.bigint();
  return {
    _t0: t0,
    _last: t0,
    _stages: [],
    _meta: meta || {},
    // Record the time since the previous mark. Named stages, in order.
    mark(name) {
      const now = process.hrtime.bigint();
      this._stages.push([name, Number(now - this._last) / 1e6]);
      this._last = now;
    },
    // Wrap a promise so a stage can be timed without restructuring the caller.
    async time(name, fn) {
      const s = process.hrtime.bigint();
      try { return await fn(); } finally {
        const e = process.hrtime.bigint();
        this._stages.push([name, Number(e - s) / 1e6]);
        this._last = e;
      }
    },
    set(k, v) { this._meta[k] = v; },
    done() {
      try {
        const total = Number(process.hrtime.bigint() - this._t0) / 1e6;
        const named = this._stages.reduce((a, [, ms]) => a + ms, 0);
        console.log('SCAN_PROFILE ' + JSON.stringify({
          total: +total.toFixed(1),
          // UNACCOUNTED is the point of this whole exercise: if the named
          // stages do not add up to the total, the missing time is real and
          // it is somewhere we are not looking yet.
          unaccounted: +(total - named).toFixed(1),
          stages: this._stages.map(([n, ms]) => [n, +ms.toFixed(1)]),
          ...this._meta,
        }));
      } catch { /* a profiler must never affect a scan */ }
    },
  };
}

const NOOP = {
  mark() {},
  async time(_n, fn) { return fn(); },
  set() {},
  done() {},
};

module.exports = { start, ENABLED };
