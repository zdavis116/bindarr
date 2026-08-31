# PHASE 1b — rgbArt SHADOW MODE

**Status: running on dev, verified end-to-end. Gate 1b NOT yet decided — it
needs a real scanning session.**

Shadow mode computes the rgbArt hash on every scan and logs its answer beside
ORB's. Nothing the user sees changes. The point is to measure rgbArt against the
live path on Zach's real photos before trusting it with an identification.

---

## Deployed

```
dev host   bindarr-dev (100.87.9.55), /opt/bindarr-dev, branch feat/scanner-rebuild
index      /var/lib/bindarr-dev/rgbart-index.bin   9.2 MB, md5 verified after copy
switch     /etc/systemd/system/bindarr-dev.service.d/rgbart.conf
             RGBART_SHADOW=1
             RGBART_INDEX=/var/lib/bindarr-dev/rgbart-index.bin
```

Delete the drop-in and `systemctl daemon-reload && systemctl restart
bindarr-dev` to turn shadow logging off. The app runs identically without it.

---

## Verified end to end, not just deployed

A running service proves nothing here — the index loads lazily, so a missing
file or a corrupt transfer stays invisible until a real photo goes through.
15 of Zach's dumped scans were pushed through the live route:

```
15 scans   9 rgbArt answered   6 skipped (no detection)
agreement with ORB: 8/9 (88.9%)
rgbArt time: p50 113ms   p95 154ms
```

**The 6 skips are not rgbArt failures.** SCAN_TRACE reports `detection:false` on
exactly those six photos — the card was never located, so neither method got a
turn. They are logged as `skipped` rather than counted against rgbArt.

---

## What the first 9 scans suggest (NOT a verdict)

Encouraging: on clean scans rgbArt lands **32–58 bits** from the right card with
the runner-up **40–64 bits** further out. That is the wide margin §3.3 predicted.

Two observations that matter more than the agreement rate:

1. **The one disagreement was rgbArt's fault.** A Forest read as `Hell's
   Thunder` at distance 112 with a margin of 4. Distance 112 is far outside the
   26–64 band, and margin 4 means the runner-up was equally plausible — so the
   σ-test confidence rule (§2.2) would have **correctly rejected this answer**
   rather than returning it. Evidence for confidence-by-separation, not against
   rgbArt.

2. **Distance spread is wider than Gate 1a's 26–64 estimate** — p95 of 112 here.
   Expected: Gate 1a's figure came from 12 hand-held photos, and this includes
   harder ones. Worth watching; if p50 stays high over a real session, the
   rectified image differs from the index images more than assumed.

**9 scans is not a gate.** The report tool refuses to judge under 30 comparable
scans, deliberately.

---

## What the report can and cannot tell you

`backend/scripts/shadow-report.js` reports **agreement, not accuracy.** Shadow
mode has no ground truth — nobody tells the server what card was really in front
of the camera.

Where the two disagree, the OCR'd collector number adjudicates: it is read from
the same photo by completely unrelated code, so it is genuine independent
evidence. Disagreements with no OCR evidence are reported **UNDECIDED** and must
be resolved by looking at the card. They are never silently assigned to either
side — that would let the tool flatter whichever method it was written to favour.

The tool was tested against synthetic logs in both directions: a run where
rgbArt wins reports PASS, a run where it loses reports **"ORB currently ahead.
Do NOT promote rgbArt."** It is not rigged to pass.

---

## To decide Gate 1b

1. Scan a stack — **at least 30 cards**, ideally a mix of clean and awkward
   ones, on https://bindarr-dev.tail387aa3.ts.net
2. Then:

```bash
ssh root@bindarr-dev 'journalctl -u bindarr-dev --since "1 hour ago" --no-pager' \
  > /tmp/shadow.log
node backend/scripts/shadow-report.js /tmp/shadow.log
```

3. Resolve any UNDECIDED rows by hand before calling the gate.

Gate 1b passes when rgbArt is **at least as good as** ORB on real scans. If it
loses, do not promote it in Phase 2 — that is the whole point of measuring.

---

## Safety

Shadow mode cannot break a scan. Every failure mode returns "no opinion":

- missing index, corrupt index → feature disables itself permanently, no retry
- garbage buffer, empty buffer, null → `identify()` returns null
- any unexpected throw → caught at the call site in `collection.js`

This is enforced by `backend/test/rgbart-shadow-safety.test.js`, not just
asserted in comments.

The runtime hash is **duplicated** from `build-hash-index.js` on purpose — the
build script runs on a host that can reach the Scryfall CDN and must not depend
on server code. Duplication invites drift, and drift here is silent: every
distance would still compute and mean nothing. `rgbart-equivalence.test.js` pins
the two bit-for-bit.

All three tests are in `npm test` (371 cases, 25/25 suites green). The suite is
an explicit file list — new test files must be added to `package.json` or they
never run.
