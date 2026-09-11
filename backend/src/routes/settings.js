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
    let stored = null;
    try { stored = JSON.parse(row?.order_json || 'null'); } catch { stored = null; }
    const order = priceSources.normaliseOrder(stored);
    const [selected] = order;

    const meta = await db.all(`SELECT * FROM source_price_meta`);
    const byId = new Map(meta.map(m => [m.source, m]));

    const describe = (id) => {
      const def = priceSources.SOURCES[id] || { id, label: id };
      const m = byId.get(id) || {};
      return {
        id,
        label: def.label,
        kind: def.kind,
        last_success_at: m.last_success_at || null,
        last_error: m.last_error || null,
        row_count: m.row_count ?? null,
      };
    };

    res.json({
      // The shop he picked, and the floor behind it. `order` is kept so every
      // existing caller that walks a chain keeps working unchanged.
      selected,
      order,
      fallback: priceSources.FALLBACK_SOURCE,
      // Every shop he COULD pick. The old endpoint returned only the configured
      // order, so a UI built on it could never offer an alternative.
      choices: priceSources.selectableSources().map(x => describe(x.id)),
      sources: order.map(describe),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to read price sources' });
  }
});

// WHICH SHOP HIS PRICES COME FROM.
//
// Zach: "I would like to get rid of the priority list and it be a selection
// whether I used mana pool or card kingdom but the fallback is always scryfall."
//
// Accepts { source: 'cardkingdom' }. The legacy { order: [...] } body is still
// honoured and collapsed to its first real shop, so an older cached client
// cannot wipe the setting.
router.put('/price-sources', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const requested = typeof req.body?.source === 'string'
      ? req.body.source
      : (Array.isArray(req.body?.order) ? req.body.order[0] : null);
    if (!requested) {
      return res.status(400).json({ error: 'source must be a price source id' });
    }

    // REJECT UNKNOWN IDS RATHER THAN DROPPING THEM. normaliseOrder falls back to
    // the default for anything it does not recognise, which is right when
    // reading a possibly-stale stored value and wrong for a write: saving
    // "manpool" would report success, quietly use Mana Pool anyway, and leave
    // him wondering why his choice did nothing.
    const def = priceSources.SOURCES[requested];
    if (!def) {
      return res.status(400).json({ error: `Unknown price source: ${requested}` });
    }
    if (!def.selectable) {
      return res.status(400).json({
        error: `${def.label} is the fallback for cards the chosen shop does not `
             + `carry. It cannot be the main source: it is an average of past `
             + `sales, not a price anyone will honour today.`,
      });
    }

    const order = priceSources.normaliseOrder(requested);
    // Stored WITHOUT the fallback: the floor is a rule, not a user choice, and
    // writing it into the setting would make it look editable.
    await db.run(`UPDATE app_settings SET price_source_order = ? WHERE id = 1`,
                 [JSON.stringify(requested)]);
    res.json({ selected: requested, order });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to save the price source' });
  }
});

module.exports = router;
// Exported for tests.
module.exports.isNewer = isNewer;
