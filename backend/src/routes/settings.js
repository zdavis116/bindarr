const express = require('express');
const axios = require('axios');
const db = require('../db');
const syncSchedule = require('../utils/syncSchedule');
const priceSources = require('../utils/priceSources');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// --- Version + update check ---

// backend/package.json is what the release workflow bumps, so it is the running
// build's version. The repo-root package.json is not bumped and would lie.
const APP_VERSION = require('../../package.json').version;
const RELEASES_API = 'https://api.github.com/repos/thenotoriousJeremy/bindarr/releases/latest';
const RELEASES_PAGE = 'https://github.com/thenotoriousJeremy/bindarr/releases';
// GitHub allows 60 unauthenticated calls/hour per IP, shared by every user of
// this instance. Cache hard: a new release is not urgent to the minute.
const UPDATE_CACHE_MS = 1000 * 60 * 60 * 6;
let updateCache = { at: 0, data: null };

// "1.4.9" < "1.4.10" — string compare gets this wrong, so compare numerically
// part by part. Anything non-numeric (a "-beta" suffix) is ignored.
function isNewer(candidate, current) {
  const parts = v => String(v).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

async function checkForUpdate() {
  if (updateCache.data && Date.now() - updateCache.at < UPDATE_CACHE_MS) return updateCache.data;
  const resp = await axios.get(RELEASES_API, {
    timeout: 8000,
    headers: { 'User-Agent': 'Bindarr', Accept: 'application/vnd.github+json' }
  });
  const latest = String(resp.data.tag_name || '').replace(/^v/i, '');
  const data = {
    latest,
    update_available: !!latest && isNewer(latest, APP_VERSION),
    release_url: resp.data.html_url || RELEASES_PAGE,
    published_at: resp.data.published_at || null
  };
  updateCache = { at: Date.now(), data };
  return data;
}

// Current version always answers offline; the update check is best-effort and
// reports its own failure rather than pretending the app is up to date.
router.get('/version', authenticateToken, async (req, res) => {
  const base = { version: APP_VERSION, releases_url: RELEASES_PAGE };
  if (req.query.check !== '1') return res.json(base);
  try {
    res.json({ ...base, ...(await checkForUpdate()) });
  } catch (error) {
    console.warn('Update check failed:', error.message);
    res.json({ ...base, check_failed: true });
  }
});

async function getEffectiveSettings() {
  const row = await db.get(`SELECT public_base_url FROM app_settings WHERE id = 1`);
  const public_base_url = (row && row.public_base_url) || process.env.PUBLIC_BASE_URL || '';
  return { public_base_url };
}

// Any logged-in user can read effective settings (needed to render share links)
router.get('/', authenticateToken, async (req, res) => {
  try {
    res.json(await getEffectiveSettings());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve settings' });
  }
});

// CARD CATALOGUE STATUS, read-only.
//
// Every figure here is measured, not derived on the client: the row count is a
// COUNT, and the timestamps are what the nightly refresh actually wrote. A
// settings screen that reports a stale or guessed catalogue size is worse than
// one that says nothing, because it is the screen you check when you suspect
// the catalogue is stale.
router.get('/catalogue', authenticateToken, async (req, res) => {
  try {
    const counts = await db.get(`SELECT COUNT(*) AS cards FROM card_cache`);
    const meta = await db.get(
      `SELECT card_catalogue_refreshed_at   AS refreshedAt,
              card_catalogue_updated_at     AS scryfallBuild,
              card_catalogue_refresh_started_at AS runningSince
       FROM app_settings WHERE id = 1`
    );
    res.json({
      cards: counts ? counts.cards : 0,
      refreshed_at: meta ? meta.refreshedAt : null,
      scryfall_build: meta ? meta.scryfallBuild : null,
      // Non-null while a refresh holds the lock, so the screen can say "running"
      // instead of showing a last-refreshed time that is about to change.
      running_since: meta ? meta.runningSince : null,
      // WHEN EACH SYNC RUNS NEXT, from the schedulers themselves.
      //
      // Zach: "I would like ... for each sync to show when the next sync to run
      // like a countdown." He asked because the numbers disagreed -- the UI said
      // 03:00, the scheduler said 04:00 UTC, and 04:00 UTC is midnight for him.
      //
      // Reported as ISO timestamps rather than a description, so the client can
      // render them in the reader's own timezone. null means that scheduler is
      // switched off, which the UI must state rather than count down to nothing.
      ...syncSchedule.getSchedule(),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to read catalogue status' });
  }
});

// Only admins can override settings
router.put('/', authenticateToken, requireAdmin, async (req, res) => {
  const { public_base_url } = req.body;

  if (public_base_url !== undefined) {
    const trimmed = public_base_url.trim();
    if (trimmed && !/^https?:\/\//i.test(trimmed)) {
      return res.status(400).json({ error: 'Public base URL must start with http:// or https://' });
    }
    const cleaned = trimmed.replace(/\/+$/, '');
    await db.run(`UPDATE app_settings SET public_base_url = ? WHERE id = 1`, [cleaned]);
  }

  try {
    res.json(await getEffectiveSettings());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// PRICE SOURCES: the order, and how fresh each one is.
//
// Zach: "Priority order in settings and scryfall last resort."
//
// GET returns every known source, the current order, and per-source freshness
// so a stale price is diagnosable in the UI rather than merely old.
router.get('/price-sources', authenticateToken, async (req, res) => {
  try {
    const row = await db.get(`SELECT price_source_order AS order_json FROM app_settings WHERE id = 1`);
    let stored = [];
    try { stored = JSON.parse(row?.order_json || '[]'); } catch { stored = []; }
    const order = priceSources.normaliseOrder(stored);

    const meta = await db.all(`SELECT * FROM source_price_meta`);
    const byId = new Map(meta.map(m => [m.source, m]));

    res.json({
      order,
      fallback: priceSources.FALLBACK_SOURCE,
      sources: order.map(id => {
        const def = priceSources.SOURCES[id] || { id, label: id };
        const m = byId.get(id) || {};
        return {
          id,
          label: def.label,
          kind: def.kind,
          // Scryfall cannot be dragged: it is the floor. The UI must show WHY
          // rather than silently refusing the drag.
          reorderable: def.reorderable !== false,
          last_success_at: m.last_success_at || null,
          last_error: m.last_error || null,
          row_count: m.row_count ?? null,
        };
      }),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to read price sources' });
  }
});

router.put('/price-sources', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const requested = Array.isArray(req.body?.order) ? req.body.order : null;
    if (!requested) return res.status(400).json({ error: 'order must be an array of source ids' });

    // REJECT UNKNOWN IDS RATHER THAN DROPPING THEM.
    //
    // normaliseOrder() silently discards anything it does not recognise, which
    // is right for reading a possibly-corrupt stored value but wrong for a
    // write: saving ["manpool"] would report success, drop the typo, and leave
    // him wondering why nothing changed.
    const unknown = requested.filter(id => !priceSources.SOURCES[id]);
    if (unknown.length) {
      return res.status(400).json({ error: `Unknown price source: ${unknown.join(', ')}` });
    }
    if (requested.includes(priceSources.FALLBACK_SOURCE)) {
      return res.status(400).json({
        error: `${priceSources.SOURCES[priceSources.FALLBACK_SOURCE].label} is always the last resort and cannot be reordered`,
      });
    }

    const order = priceSources.normaliseOrder(requested);
    // Stored WITHOUT the appended fallback: the floor is a rule, not a user
    // choice, and writing it into the setting would make it look editable.
    await db.run(`UPDATE app_settings SET price_source_order = ? WHERE id = 1`,
                 [JSON.stringify(requested)]);
    res.json({ order });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to save price sources' });
  }
});

// WHERE HIS CARDS GET SHIPPED.
//
// Mana Pool will not create an order without it. Stored once at his choice --
// "I'm fine with A makes sense" -- rather than retyped per order.
//
// GET never returns a partial address as if it were whole: either it is
// complete and usable, or `configured` is false and the UI asks for it.
router.get('/shipping', async (req, res) => {
  try {
    const row = await db.get(
      `SELECT ship_line1, ship_city, ship_state, ship_postal_code, ship_country
         FROM app_settings WHERE id = 1`) || {};
    const complete = Boolean(row.ship_line1 && row.ship_city
                          && row.ship_state && row.ship_postal_code);
    res.json({
      configured: complete,
      line1: row.ship_line1 || '',
      city: row.ship_city || '',
      state: row.ship_state || '',
      postal_code: row.ship_postal_code || '',
      country: row.ship_country || 'US',
    });
  } catch (error) {
    sendError(res, error, 'Failed to read the shipping address');
  }
});

router.put('/shipping', async (req, res) => {
  try {
    const b = req.body || {};
    // CLEARING IS EXPLICIT, not a side effect of sending blanks. He should be
    // able to remove his address from the app deliberately.
    if (b.clear === true) {
      await db.run(`UPDATE app_settings SET ship_line1 = NULL, ship_city = NULL,
                      ship_state = NULL, ship_postal_code = NULL WHERE id = 1`);
      return res.json({ configured: false });
    }
    const line1 = String(b.line1 || '').trim();
    const city = String(b.city || '').trim();
    const state = String(b.state || '').trim().toUpperCase();
    const postal = String(b.postal_code || '').trim();
    const country = String(b.country || 'US').trim().toUpperCase();

    // A PARTIAL ADDRESS IS REFUSED. Storing three of four fields would let the
    // send button look ready and then fail at the marketplace.
    const missing = [];
    if (!line1) missing.push('line1');
    if (!city) missing.push('city');
    if (!state) missing.push('state');
    if (!postal) missing.push('postal_code');
    if (missing.length) {
      return res.status(400).json({
        error: `Missing: ${missing.join(', ')}`,
        code: 'INCOMPLETE_ADDRESS',
      });
    }

    await db.run(
      `UPDATE app_settings SET ship_line1 = ?, ship_city = ?, ship_state = ?,
              ship_postal_code = ?, ship_country = ? WHERE id = 1`,
      [line1, city, state, postal, country]);
    res.json({ configured: true, line1, city, state, postal_code: postal, country });
  } catch (error) {
    sendError(res, error, 'Failed to save the shipping address');
  }
});

module.exports = router;
// Exported for tests.
module.exports.isNewer = isNewer;
