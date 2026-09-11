require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const db = require('./db');
const syncSchedule = require('./utils/syncSchedule');
const scryfallApi = require('./scryfallApi');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const collectionRoutes = require('./routes/collection');
const storageRoutes = require('./routes/storage');
const statsRoutes = require('./routes/stats');
const importExportRoutes = require('./routes/importExport');
const setsRoutes = require('./routes/sets');
const decksRoutes = require('./routes/decks');
const moxfieldRoutes = require('./routes/moxfield');
const settingsRoutes = require('./routes/settings');
const tagsRoutes = require('./routes/tags');
const notesRoutes = require('./routes/notes');
const { getAuditLogs, revertAuditEvent } = require('./utils/auditLogger');
const { startHttps, selfSignedTls } = require('./utils/tls');


const app = express();
const PORT = process.env.PORT || 3001;

// Behind a reverse proxy (nginx/Traefik/Caddy terminating TLS — effectively
// required, since mobile camera access needs HTTPS), set TRUST_PROXY so req.ip
// and the rate limiters use the real client IP from X-Forwarded-For instead of
// the proxy's. Leave it UNSET when the app is directly exposed: trusting that
// header otherwise lets any client spoof its IP and defeat the rate limiter.
// Accepts a hop count ("1"), "true", or an express trust-proxy string ("loopback").
if (process.env.TRUST_PROXY) {
  const tp = process.env.TRUST_PROXY;
  app.set('trust proxy', tp === 'true' ? true : (Number.isNaN(Number(tp)) ? tp : Number(tp)));
}

// Content Security Policy. Card identification is server-side (the client just
// POSTs a photo to /api/scan-match), so the browser needs nothing beyond the
// app's own bundle plus the card-image hosts. Kept Report-Only for now: flip
// `reportOnly` to false to enforce once a production smoke test confirms the
// scan flow and card images load cleanly under these directives.
// ponytail: Report-Only ceiling — enforce after a prod verification pass.
app.use(helmet({
  // HSTS pins the host to HTTPS in the browser. When we terminate TLS ourselves
  // with a self-signed certificate that is a lockout: Chrome stops offering the
  // "proceed anyway" bypass, and http://<host>:3001 gets upgraded too. Left at
  // helmet's default (on) for every other deployment, including a reverse proxy
  // with a real certificate.
  hsts: !selfSignedTls(),
  contentSecurityPolicy: {
    reportOnly: true,
    directives: {
      defaultSrc: ["'self'"],
      // 'wasm-unsafe-eval' IS REQUIRED BY THE ON-DEVICE CARD DETECTOR.
      //
      // onnxruntime-web compiles a WebAssembly module, and every browser gates
      // WASM compilation behind this directive. Without it the detector fails
      // to load and the preview silently falls back to the edge detector --
      // which finds a card in only 9 of 33 real scans, the exact bug this
      // replaces.
      //
      // It is added NOW even though the policy is reportOnly, because the day
      // someone enforces it the failure would be silent, remote, and would look
      // like the scanner regressing for no reason.
      //
      // It is much narrower than it sounds: it permits WASM compilation ONLY.
      // It does NOT enable eval() or any other JavaScript string execution --
      // that would be 'unsafe-eval', which stays off.
      scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://cards.scryfall.io', 'https://c1.scryfall.com', 'https://img.scryfall.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: null
    }
  }
}));

// Restrict cross-origin access to known frontend origins. Localhost + private-
// LAN origins are ALWAYS allowed (see PRIVATE_ORIGIN below); CORS_ORIGIN adds
// public origins on top (e.g. a reverse-proxy domain) rather than replacing the
// LAN allowance, so a self-hosted instance behind a proxy stays reachable both
// ways without listing the LAN IP. The Vite dev server runs with host:true +
// HTTPS so the mobile scanner can reach it over the LAN, which makes the
// browser send an Origin like https://192.168.1.20:5173 on writes (PUT/POST/
// DELETE) — GETs are same-origin and send none, which is why only writes were
// being rejected before.
const explicitOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// The reverse-proxy domain is already configured as PUBLIC_BASE_URL for share
// links, so reuse its origin as an allowed CORS origin — setting it alone is
// enough for proxied logins, no separate CORS_ORIGIN needed.
if (process.env.PUBLIC_BASE_URL) {
  try { explicitOrigins.push(new URL(process.env.PUBLIC_BASE_URL).origin); }
  catch { /* malformed URL — ignore */ }
}

// Loopback + RFC1918 private ranges (10/8, 172.16-31/12, 192.168/16) and
// *.local, with any scheme/port. Not internet-routable, so this is safe for a
// self-hosted app while still blocking arbitrary public websites.
const PRIVATE_ORIGIN = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|\[::1\]|[a-z0-9-]+\.local)(:\d+)?$/i;

function isAllowedOrigin(origin) {
  if (!origin) return true; // same-origin / non-browser client
  if (PRIVATE_ORIGIN.test(origin)) return true; // localhost + private LAN, always
  return explicitOrigins.includes(origin);
}

app.use(cors({
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));
// Default 100kb body limit is too small for the collection import/export
// feature: a JSON backup wraps the export payload in a string field, which
// added escaping overhead pushed a ~90-card collection past the default
// limit already. 15mb comfortably covers even large (multi-thousand card)
// collections.
app.use(express.json({ limit: '15mb' }));

// Initialize Database on startup
db.initDb()
  .then(async () => {
    console.log('Database tables verified/created successfully.');

    // Un-stack legacy multi-quantity entries so every copy is its own row (one
    // physical card = one storage slot). No-op once migrated.
    const { splitStackedEntries } = require('./utils/collectionHelpers');
    const splitCount = await splitStackedEntries(db);
    if (splitCount > 0) console.log(`Split ${splitCount} stacked collection copies into individual rows.`);

    // Sync Scryfall sets on startup.
    await scryfallApi.fetchAndCacheSets();

    // Load sets into compartmentSort memory cache
    const { loadSetsCache } = require('./utils/compartmentSort');
    await loadSetsCache(db);
    
    // Weekly: refresh sets (picks up newly released ones) and reload the
    // in-memory sets cache so chronological sorting stays current without a
    // restart. Scryfall's guidance is that gameplay/set data changes rarely and
    // weekly is plenty — prices are on their own schedule below.
    setInterval(async () => {
      try {
        await scryfallApi.fetchAndCacheSets(true);
        await loadSetsCache(db);
      } catch (err) {
        console.error('Weekly sets refresh failed:', err);
      }
    }, 1000 * 60 * 60 * 24 * 7);

    // Daily: prices. Scryfall refreshes prices once a day, so this is both the
    // most often worth doing and the most often allowed. `force` because the
    // interval itself is already the right cadence.
    setInterval(() => {
      scryfallApi.updateCollectionPrices(true);
    }, 1000 * 60 * 60 * 24);

    // Shortly after startup, catch up if the last sweep was over a day ago.
    // NOT forced: without that gate this re-ran on every restart, which under
    // nodemon meant a full sweep on every code edit — for data that cannot have
    // changed since the last one.
    setTimeout(() => {
      scryfallApi.updateCollectionPrices();
    }, 30000);

    // Periodically purge expired sessions so the table doesn't grow unbounded
    setInterval(() => {
      db.run(`DELETE FROM sessions WHERE expires_at <= DATETIME('now')`).catch(err => {
        console.error('Failed to purge expired sessions:', err);
      });
    }, 1000 * 60 * 60 * 24);

    // Periodic auto-backup (BACKUP_INTERVAL_HOURS, default 24; 0 disables)
    require('./backup').startAutoBackup();

    // Nightly: refresh the full local card catalogue (see cardCatalogue.js).
    //
    // In-process rather than a systemd timer or cron, for three reasons:
    //   1. It works identically in dev and production, and in Docker, with no
    //      per-host unit files to keep in sync. The other scheduled work in
    //      this app (prices, sets, backups) already lives here.
    //   2. It shares the app's database handle, so the refresh takes its turn
    //      on the same serialized queue as everything else. An external process
    //      opening the same SQLite file would be contending for write locks
    //      with a live server.
    //   3. Duplicate downloads are prevented by the Scryfall build timestamp,
    //      not by scheduling. Dev and production both check the small bulk
    //      index first and neither pulls the large file twice for the same
    //      build, so running two instances costs one download between them.
    //
    // CARD_CATALOGUE_REFRESH=off disables it entirely for hosts that should
    // never pull hundreds of megabytes.
    if (process.env.CARD_CATALOGUE_REFRESH !== 'off') {
      const cardCatalogue = require('./cardCatalogue');
      const runCatalogueRefresh = () => {
        cardCatalogue.refreshCatalogue({ lockLabel: 'server' }).catch((err) => {
          // A refresh already in flight is the GUARD WORKING, not a failure.
          // Logging it as an error would train an operator to ignore genuine
          // catalogue errors in this same line. It is worth a note, though:
          // it tells them the nightly tick found a manual run underway.
          if (err.code === 'CATALOGUE_REFRESH_IN_PROGRESS') {
            console.log(`Card catalogue refresh skipped: ${err.message}`);
            return;
          }
          // Already logged in detail, INCLUDING the verified resulting state —
          // which is why this line no longer claims the cache is intact. It
          // does not know that, and PR 6I item 7 is exactly the bug caused by
          // a layer asserting a state it had not checked.
          console.error('Card catalogue refresh failed:', err.message);
        });
      };
      // THE SYNC DOES NOT HANG OFF RESTARTS.
      //
      // Zach: "I feel like the sync should run independently of the app being
      // stopped and started."
      //
      // It used to catch up 60 seconds after every boot. That made DEPLOYING
      // the thing that triggered a 4-minute import — so every deploy looked
      // like it broke the app, twice now, and the second time cost him a
      // dashboard that would not load. A restart is not new information about
      // Scryfall; the bulk file changes roughly daily regardless of what this
      // process is doing.
      //
      // Now it runs on a WALL-CLOCK schedule: the next 04:00 local, then every
      // 24h. Nothing is pulled because a service bounced.
      //
      // THE CATCH-UP STILL EXISTS, but only when the catalogue is genuinely
      // stale — more than a day since the last successful import. A machine
      // that was off for a week must not wait until 04:00 to notice, and that
      // is a real gap rather than a restart. It is also deferred well past
      // boot so it cannot collide with someone opening the app right after a
      // deploy.
      const MINUTE = 60 * 1000;
      const DAY = 24 * 60 * MINUTE;
      const STALE_CATALOGUE_MS = DAY;

      const startupCatchUp = async () => {
        try {
          const age = await cardCatalogue.msSinceLastRefresh();
          if (age === null || age > STALE_CATALOGUE_MS) {
            console.log('Card catalogue is stale; running a catch-up refresh.');
            runCatalogueRefresh();
          }
        } catch (err) {
          console.error('Could not check catalogue age:', err.message);
        }
      };

      // 04:00 UTC.
      //
      // WAS "04:00 local", WHICH WAS NOT LOCAL TO ZACH. Both hosts run Etc/UTC,
      // so setHours(4) meant 04:00 UTC = MIDNIGHT for him in EDT. Meanwhile
      // Settings displayed a hardcoded "Nightly at 03:00" that matched neither.
      // He caught all three: "you say scryfall syncs at 0400 but I see on the
      // site 0300 hundred is that local time zone adjusted".
      //
      // The server now states the schedule once and PUBLISHES the real next-run
      // timestamp; the UI renders it in the reader's own zone. A time typed into
      // the UI is a second source of truth, and it had already drifted.
      const CATALOGUE_HOUR_UTC = 4;
      const nextCatalogueRun = () => {
        const d = new Date();
        d.setUTCHours(CATALOGUE_HOUR_UTC, 0, 0, 0);
        if (d <= new Date()) d.setUTCDate(d.getUTCDate() + 1);
        return d;
      };
      const nextRun = nextCatalogueRun();
      const msUntilNextRun = nextRun.getTime() - Date.now();
      syncSchedule.setCatalogueNextRun(nextRun.toISOString());

      setTimeout(() => {
        runCatalogueRefresh();
        // RE-PUBLISH after each run, or the countdown freezes at the first
        // value and quietly becomes wrong — the failure mode this whole change
        // exists to remove.
        syncSchedule.setCatalogueNextRun(nextCatalogueRun().toISOString());
        setInterval(() => {
          runCatalogueRefresh();
          syncSchedule.setCatalogueNextRun(nextCatalogueRun().toISOString());
        }, DAY);
      }, msUntilNextRun);

      console.log(
        `Card catalogue refresh scheduled for ${nextRun.toISOString()} `
        + `(in ${Math.round(msUntilNextRun / MINUTE)} min), then every 24h.`
      );

      // Five minutes, not sixty seconds: long enough that a deploy is finished
      // and anyone testing it has already loaded the screens they care about.
      setTimeout(startupCatchUp, 5 * MINUTE);
    }

    // MANA POOL PRICES.
    //
    // Zach: "manapool should sync prices every 6hrs if possible instead of once
    // a day."
    //
    // Six hours is justified by the feed itself, not by preference: its meta
    // block carries an as_of stamp, and two observations four hours apart read
    // 03:14:03Z then 07:15:50Z. Mana Pool republishes through the day, so a
    // daily fetch would show prices up to 24 hours behind what the site shows
    // when he clicks through -- and a price Bindarr states that the marketplace
    // contradicts is worse than no price.
    //
    // SEPARATE SCHEDULE FROM THE CATALOGUE, deliberately. The Scryfall
    // catalogue is a 500MB rebuild of the card identity everything joins to;
    // this is a 51MB price feed that replaces nothing structural. Tying them
    // together would mean either the catalogue runs four times a day or prices
    // run once.
    if (process.env.MANAPOOL_PRICES !== 'off') {
      const { refreshManaPoolPrices, msSinceLastRefresh } = require('./manaPoolPrices');
      const MINUTE_MS = 60 * 1000;
      const PRICE_INTERVAL_MS = 6 * 60 * MINUTE_MS;
      // Half the interval: old enough to be worth 201MB, new enough that a
      // deploy during the day never triggers one.
      const PRICE_STALE_MS = 3 * 60 * MINUTE_MS;

      const runPriceRefresh = () => {
        refreshManaPoolPrices()
          .then(({ written, skipped, asOf }) => {
            console.log(`Mana Pool prices: ${written} rows updated`
              + `${skipped ? `, ${skipped} skipped` : ''}`
              + `${asOf ? ` (feed as of ${asOf})` : ''}.`);
          })
          .catch((err) => {
            // Logged, not thrown: a failed price fetch must not take the app
            // down, and the previous prices are still there. The failure is
            // recorded in source_price_meta.last_error so Settings can say WHY
            // a price is stale rather than just showing an old number.
            console.error('Mana Pool price refresh failed:', err.message);
          });
        syncSchedule.setManaPoolNextRun(
          new Date(Date.now() + PRICE_INTERVAL_MS).toISOString());
      };

      // A RESTART IS NOT A REASON TO RE-IMPORT.
      //
      // Zach: "where is there a delay in loading total... about a minute later
      // it updated." Every restart armed this 8-minute timer, so four deploys in
      // an hour meant four full 201MB imports -- and an import holds the single
      // database queue, so his reads waited behind it. He opened the export
      // sheet mid-import and watched it fill in a minute later.
      //
      // The catalogue was fixed this way weeks ago ("I feel like the sync should
      // run independently of the app being stopped and started") and I did not
      // apply the same rule here. Now a boot only imports if the stored feed is
      // genuinely old; otherwise it waits for its normal slot.
      const startupPriceRefresh = async () => {
        let age = null;
        try {
          age = await msSinceLastRefresh();
        } catch (err) {
          console.error('Could not read Mana Pool price freshness:', err.message);
        }
        // null means it has NEVER succeeded -- that is stale, not fresh.
        if (age !== null && age < PRICE_STALE_MS) {
          const mins = Math.round(age / MINUTE_MS);
          console.log(`Mana Pool prices are ${mins} min old; skipping the startup`
            + ` import and waiting for the scheduled run.`);
          return;
        }
        runPriceRefresh();
      };

      // Published before the first run so the countdown is right immediately.
      syncSchedule.setManaPoolNextRun(new Date(Date.now() + 8 * MINUTE_MS).toISOString());

      // EIGHT minutes after boot, then every six hours.
      //
      // Deliberately AFTER the catalogue's five-minute stale check. On a cold
      // start where the catalogue IS stale, a 500MB rebuild and a 51MB price
      // import would otherwise run through the same serialized database queue
      // at once -- which is precisely the pile-up that made Zach's dashboard
      // take 26 seconds. (My first version used three minutes and the comment
      // claimed it ran after the catalogue check; 3 < 5, so it did not. Checked
      // the numbers rather than trusting the sentence I had just written.)
      setTimeout(() => {
        startupPriceRefresh();
        setInterval(runPriceRefresh, PRICE_INTERVAL_MS);
      }, 8 * MINUTE_MS);

      console.log('Mana Pool price refresh scheduled: first check in 8 min'
        + ' (skipped if prices are under 3h old), then every 6h.');
    }

    // CARD KINGDOM PRICES.
    //
    // Zach: "would it be possible to now add tcgplayer and card kingdom in the
    // same way as manapool." Card Kingdom yes -- public feed, per condition,
    // keyed by scryfall_id. TCGplayer no: their API has been closed to new
    // developers since the eBay acquisition, and the only redistribution
    // available carries a market average with no condition, stock or listing
    // URL. He chose to leave it out rather than mix an average in with real
    // listings.
    //
    // Same shape as the Mana Pool schedule and for the same reasons: every 6
    // hours, first check well after boot, and SKIPPED if the stored prices are
    // recent -- a restart is not a reason to pull 67MB. Offset from Mana Pool's
    // slot so two imports never share the database queue.
    if (process.env.CARDKINGDOM_PRICES !== 'off') {
      const { refreshCardKingdomPrices, msSinceLastRefresh: ckAge } =
        require('./cardKingdomPrices');
      const MINUTE = 60 * 1000;
      const CK_INTERVAL_MS = 6 * 60 * MINUTE;
      const CK_STALE_MS = 3 * 60 * MINUTE;

      const runCk = () => {
        refreshCardKingdomPrices()
          .then(({ written, skipped, asOf }) => {
            console.log(`Card Kingdom prices: ${written} printings updated`
              + `${skipped ? `, ${skipped} skipped` : ''}`
              + `${asOf ? ` (feed as of ${asOf})` : ''}.`);
          })
          .catch((err) => {
            // Logged, never thrown: a failed price fetch must not take the app
            // down, and the previous prices are still there. The failure is
            // recorded in source_price_meta so Settings can say WHY a price is
            // stale rather than just showing an old number.
            console.error('Card Kingdom price refresh failed:', err.message);
          });
        syncSchedule.setCardKingdomNextRun(
          new Date(Date.now() + CK_INTERVAL_MS).toISOString());
      };

      const startupCk = async () => {
        let age = null;
        try { age = await ckAge(); }
        catch (err) { console.error('Could not read Card Kingdom freshness:', err.message); }
        // null means it has NEVER succeeded -- stale, not fresh.
        if (age !== null && age < CK_STALE_MS) {
          console.log(`Card Kingdom prices are ${Math.round(age / MINUTE)} min old;`
            + ' skipping the startup import and waiting for the scheduled run.');
          return;
        }
        runCk();
      };

      syncSchedule.setCardKingdomNextRun(new Date(Date.now() + 11 * MINUTE).toISOString());
      // ELEVEN minutes: three past Mana Pool's slot, so a cold start cannot run
      // two large imports through the single operation queue at once.
      setTimeout(() => {
        startupCk();
        setInterval(runCk, CK_INTERVAL_MS);
      }, 11 * MINUTE);

      console.log('Card Kingdom price refresh scheduled: first check in 11 min'
        + ' (skipped if prices are under 3h old), then every 6h.');
    }

    // MOXFIELD BACKGROUND POLL.
    //
    // Zach builds decks in Moxfield and wants Bindarr to notice on its own.
    // This DETECTS drift and records it; it never applies a change. A decklist
    // rewriting itself overnight is the silent state change he has ruled out --
    // he would open a curated deck, find it different, and have nothing to
    // point at.
    //
    // Cheap by design: one author-list request covers every deck, and a deck is
    // only fetched in full when Moxfield's own lastUpdatedAtUtc has moved.
    //
    // MOXFIELD_POLL=off disables it. MOXFIELD_POLL_MINUTES overrides the
    // interval for anyone who wants a looser loop; the floor is 1 minute.
    if (process.env.MOXFIELD_POLL !== 'off') {
      const { runPoll } = require('./utils/moxfieldPoll');
      // Minutes, because six hours meant he could edit a deck at breakfast and
      // still not see it in Bindarr at lunch. One tick is a single request to
      // the author deck list -- decks are only fetched individually when their
      // upstream timestamp has actually moved -- so five minutes is ~288
      // requests on a quiet day.
      const minutes = Math.max(1, Number(process.env.MOXFIELD_POLL_MINUTES) || 5);
      const MINUTE_MS = 60 * 1000;
      const publishNextPoll = () =>
        syncSchedule.setMoxfieldNextRun(
          new Date(Date.now() + minutes * MINUTE_MS).toISOString());
      const tick = () => {
        // Published BEFORE the work, not after: a poll that takes a few seconds
        // should still show the next tick, and a poll that throws must not
        // leave the countdown stuck on a time that has already passed.
        publishNextPoll();
        runPoll().then((results) => {
          for (const r of results) {
            if (r.unreachable) {
              // Not logged as an error: Moxfield being down is not a Bindarr
              // fault, and treating it as one trains an operator to ignore this
              // line when something genuinely breaks.
              console.log(`Moxfield poll: ${r.username} unreachable (${r.error})`);
            } else if (r.changed.length) {
              console.log(`Moxfield poll: ${r.changed.length} deck(s) changed upstream ` +
                          `for ${r.username}`);
            }
          }
        }).catch(err => console.error('Moxfield poll failed:', err.message));
      };
      // The first tick is 90s away; publish that, not "now + interval", or the
      // countdown reads 5 minutes while the poll is actually 90 seconds out.
      syncSchedule.setMoxfieldNextRun(new Date(Date.now() + 90000).toISOString());
      setTimeout(tick, 90000);
      setInterval(tick, 1000 * 60 * minutes);
    }
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
  });

// Readiness/liveness probe for orchestrators (Docker HEALTHCHECK, etc.).
// Unauthenticated; pings the DB so a wedged database reads as unhealthy.
// Declared before the /api collection mount so nothing shadows it.
app.get('/api/health', async (req, res) => {
  res.setHeader('X-App-Name', 'Bindarr');
  try {
    await db.get('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'db_unavailable' });
  }
});

// --- API ROUTES ---
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', collectionRoutes);
app.use('/api', storageRoutes);
app.use('/api', statsRoutes);
app.use('/api', importExportRoutes);
app.use('/api', tagsRoutes);
app.use('/api', notesRoutes);
app.get('/api/audit-logs', getAuditLogs);
app.post('/api/audit-logs/:id/revert', revertAuditEvent);
app.use('/api/sets', setsRoutes);
app.use('/api/decks', decksRoutes);
// Paths inside are /moxfield/..., so this mounts at bare /api like collection.
app.use('/api', moxfieldRoutes);
app.use('/api/settings', settingsRoutes);

// PHASE 4a SPIKE — throwaway detector benchmark, dev only.
//
// Mounted before the SPA catch-all so /spike/phase4a/ resolves to the spike
// page rather than index.html. Off unless SPIKE_PHASE4A=1, so it cannot appear
// in production by accident. Delete this block and backend/spike/ once Gate 4a
// is decided — it is a measurement, not a feature.
if (process.env.SPIKE_PHASE4A) {
  const spikeDir = path.join(__dirname, '../spike/phase4a');
  app.use('/spike/phase4a', express.static(spikeDir));
  console.log('Phase 4a spike served at /spike/phase4a/');
}

// Serve production static assets from Frontend
const frontendBuildPath = path.join(__dirname, '../../frontend/dist');
app.use(express.static(frontendBuildPath));

// Catch-all route to serve Index.html in production
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  res.sendFile(path.join(frontendBuildPath, 'index.html'));
});

// Generic error handler (e.g. rejected CORS origins) — never leak stack traces to clients
app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Upload too large. Try exporting/importing in smaller batches.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start Express Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`=========================================`);
  console.log(`Bindarr Server running on port ${PORT}`);
  console.log(`Access local: http://localhost:${PORT}`);
  console.log(`=========================================`);
  // Camera scanning needs a secure context, so a LAN/Docker install serves TLS
  // too when HTTPS_PORT is set. Certificates live beside the database.
  startHttps(app, path.join(path.dirname(db.dbPath), 'ssl'));
  // Warm the scan worker pool so the first set-scoped scan doesn't pay worker
  // spawn + opencv-wasm load. No-op when SCAN_WORKERS=0.
  try { require('./scanPool').getPool(); } catch (e) { console.warn('scanPool warmup skipped:', e.message); }
});
