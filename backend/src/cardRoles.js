// CARD ROLES — what a card DOES, from Scryfall's Tagger.
//
// The deck Curve tab stacks each mana-value bar by role (ramp, card draw,
// interaction, threat) rather than showing plain counts, because a 3-drop
// Rhystic Study and a 3-drop vanilla creature are not the same card and a
// plain histogram says they are.
//
// WHERE THE ROLES COME FROM
//
// Scryfall publishes community-curated Oracle tags through its Tagger project,
// exposed as an `oracle_tags` entry on GET /bulk-data: one gzipped JSONL file,
// ~6 MB, listing every tag and the oracle_ids it applies to. There is NO
// per-card endpoint — /cards/:id/tags is a 404 and ?include_tags=true is
// silently ignored (verified against the live API, Sept 2026). So this is a
// batch import, exactly like the card catalogue, and never a per-request call.
//
// WHY NOT CLASSIFY FROM ORACLE TEXT OURSELVES
//
// I wrote that first: a few dozen regexes over oracle_text. Measured against a
// hand-labelled 57-card Commander deck it agreed 79% of the time, and the
// failures were the kind you cannot regex your way out of — Farseek fetches a
// "Plains, Island, Swamp, or Mountain" and never says the word "land"; Sylvan
// Library says "draw two ADDITIONAL cards"; Fact or Fiction puts cards in hand
// without the word "draw". Tags + the rule below measure 95% on the same deck,
// and the code is a set lookup instead of a regex zoo to maintain.
//
// THE ONE RULE WE ADD ON TOP
//
// Tags describe what a card DOES. The curve asks what SLOT it fills. Those
// differ for creatures: Old Gnawbone is genuinely tagged `ramp` and Thundermaw
// Hellkite genuinely `removal`, and both are still the dragons you win with.
// So a creature or planeswalker is a THREAT unless taps-for-mana is its whole
// job. Using tags raw, without this rule, measured 67% — WORSE than the
// regexes. The rule is what makes the data useful.
//
// THE TAG HIERARCHY IS LOAD-BEARING
//
// `removal` and `draw` have ZERO cards tagged directly; every card lives in a
// child tag like `removal-creature` or `burst-draw`. Querying the parent alone
// returns nothing, which is what produced that bad 67%. Each tag entry carries
// child_ids, so we walk the tree and roll descendants up to their root.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { pipeline } = require('stream/promises');

const db = require('./db');

const BULK_INDEX_URL = 'https://api.scryfall.com/bulk-data';

// The roles the curve stacks by, in the order a tie is broken. Interaction
// before draw before ramp: a card tagged both `removal` and `draw` (Fire // Ice)
// is bucketed by the more specific job you keep it for.
const ROLE_ROOTS = [
  { role: 'removal', roots: ['counterspell', 'removal'] },
  { role: 'draw', roots: ['card-advantage'] },
  // RAMP INCLUDES LAND TUTORS.
  //
  // Zach: "Roost Seek is being considered a threat when its ramp I believe."
  // He was right twice over -- the per-face fix got it off 'threat', but it
  // landed on 'other' because Scryfall files land tutors under `tutor`, not
  // `ramp`. Their hierarchy classifies by MECHANISM (how the card works);
  // deckbuilding cares about PURPOSE (what it does for your mana).
  //
  // Measured on the tag file: the ramp family covers 2,912 taggings,
  // tutor-land another 1,075 that were falling through to 'other'. Cultivate,
  // Rampant Growth, Three Visits and every fetchland live in that gap.
  { role: 'ramp', roots: ['ramp', 'tutor-land'] },
];

const VALID_ROLES = ['ramp', 'draw', 'removal', 'threat', 'other'];

function httpClient() {
  // Required lazily so a missing optional dep cannot break server boot; the
  // catalogue module does the same.
  return require('axios');
}

// --- the bulk file -----------------------------------------------------------

async function fetchOracleTagsInfo() {
  const response = await httpClient().get(BULK_INDEX_URL, {
    timeout: 30000,
    headers: { 'User-Agent': 'Bindarr/1.0', Accept: 'application/json' },
  });
  const entries = (response.data && response.data.data) || [];
  const target = entries.find((entry) => entry.type === 'oracle_tags');
  if (!target) throw new Error('Scryfall bulk index has no oracle_tags entry');
  const url = target.jsonl_download_uri || target.download_uri;
  if (!url) throw new Error('Scryfall oracle_tags entry has no download URI');
  return { url, updatedAt: target.updated_at };
}

// --- classification ----------------------------------------------------------

// Walk child_ids from each root so a card tagged `removal-creature` counts as
// removal. Iterative, not recursive: the tag graph is community-edited and a
// cycle would blow the stack rather than produce a wrong answer.
function expandFamilies(tagsById, slugToId) {
  const families = new Map();
  for (const { role, roots } of ROLE_ROOTS) {
    const slugs = new Set();
    const stack = roots.map((r) => slugToId.get(r)).filter(Boolean);
    const seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const tag = tagsById.get(id);
      if (!tag) continue;
      slugs.add(tag.slug);
      for (const child of tag.child_ids || []) stack.push(child);
    }
    families.set(role, slugs);
  }
  return families;
}

// A card taps for mana as its whole job -> it is ramp even though it is a
// creature. Everything else with a body is a threat.
const TAPS_FOR_MANA = /\{t\}:\s*add/i;

// SPLIT A JOINED FACE STRING. Bindarr stores multi-face cards joined:
// type_line as 'Creature - Dragon // Sorcery - Omen', oracle_text under
// '=== Name ===' headers.
function faceTypeLines(typeLine) {
  return String(typeLine || '').split('//').map((s) => s.trim()).filter(Boolean);
}

function faceOracleTexts(oracleText) {
  const raw = String(oracleText || '');
  if (!raw.includes('===')) return [raw];
  const parts = [];
  const re = /===\s*(.+?)\s*===\n?/g;
  let m = re.exec(raw);
  while (m) {
    const start = re.lastIndex;
    const next = re.exec(raw);
    parts.push(raw.slice(start, next ? next.index : raw.length).trim());
    m = next;
  }
  return parts.length ? parts : [raw];
}

function roleForCard({ typeLine, oracleText, tagSlugs, families }) {
  const type = (typeLine || '').toLowerCase();
  const text = oracleText || '';

  if (type.includes('creature') || type.includes('planeswalker')) {
    const rampSlugs = families.get('ramp');
    const rampHit = [...tagSlugs].find((s) => rampSlugs.has(s));
    if (rampHit && TAPS_FOR_MANA.test(text)) {
      return { role: 'ramp', tag: rampHit };
    }
    return { role: 'threat', tag: null };
  }

  for (const { role } of ROLE_ROOTS) {
    const slugs = families.get(role);
    const hit = [...tagSlugs].sort().find((s) => slugs.has(s));
    if (hit) return { role, tag: hit };
  }
  return { role: 'other', tag: null };
}

/**
 * ROLES FOR EACH CASTABLE FACE.
 *
 * Zach: "Roost Seek is being considered a threat when its ramp I believe. So
 * cards like that, that have 2 different types should reflect appropriately."
 *
 * He is right. Roles were derived once per oracle_id from the JOINED type line
 * -- 'Creature - Dragon // Sorcery - Omen' contains 'creature', so the whole
 * card became a Threat, and the curve then showed that role on the Sorcery
 * half too. Every Adventure and Prepare card in the catalogue was a Threat on
 * both halves.
 *
 * The tags stay card-level: Scryfall tags an oracle_id, not a face. What
 * changes is the TYPE-LINE judgement, which is genuinely per-face -- a Sorcery
 * half is not a creature, so it falls through to the tag families and picks up
 * ramp / removal / draw properly.
 *
 * Returns { role, tag, backRole, backTag } -- backRole is null for
 * single-faced cards.
 */
function rolesForFaces({ typeLine, oracleText, tagSlugs, families }) {
  const types = faceTypeLines(typeLine);
  const texts = faceOracleTexts(oracleText);

  const front = roleForCard({
    typeLine: types[0] || typeLine,
    oracleText: texts[0] || oracleText,
    tagSlugs,
    families,
  });

  if (types.length < 2) {
    return { role: front.role, tag: front.tag, backRole: null, backTag: null };
  }

  const back = roleForCard({
    typeLine: types[1],
    oracleText: texts[1] || texts[0] || oracleText,
    tagSlugs,
    families,
  });

  return { role: front.role, tag: front.tag, backRole: back.role, backTag: back.tag };
}

// --- import ------------------------------------------------------------------

// Read the tag file once, building oracle_id -> Set(tag slugs). The file is
// keyed by TAG (each line is one tag with its taggings), so this inverts it.
async function readTagFile(url, { log = console } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-roles-'));
  const archivePath = path.join(tempDir, 'oracle-tags.jsonl.gz');

  try {
    const response = await httpClient().get(url, {
      responseType: 'stream',
      timeout: 300000,
      headers: { 'User-Agent': 'Bindarr/1.0' },
    });
    // Land it on disk before parsing, same reasoning as the catalogue: a
    // truncated transfer must be a hard error, not a malformed final line.
    await pipeline(response.data, fs.createWriteStream(archivePath));

    const tagsById = new Map();
    const slugToId = new Map();
    const byOracle = new Map();

    const lines = readline.createInterface({
      input: fs.createReadStream(archivePath).pipe(zlib.createGunzip()),
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let tag;
      try {
        tag = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!tag || tag.object !== 'tag' || !tag.slug) continue;
      tagsById.set(tag.id, tag);
      slugToId.set(tag.slug, tag.id);
      for (const tagging of tag.taggings || []) {
        const oid = tagging.oracle_id;
        if (!oid) continue;
        let set = byOracle.get(oid);
        if (!set) { set = new Set(); byOracle.set(oid, set); }
        set.add(tag.slug);
      }
    }

    log.log(`cardRoles: read ${tagsById.size} tags covering ${byOracle.size} cards`);
    return { tagsById, slugToId, byOracle };
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* scratch */ }
  }
}

// Refresh roles for every oracle_id the local catalogue knows about.
//
// Scoped to what we actually hold rather than all 36k tagged cards: the join
// target is card_cache, and a role for a card the user can never see is dead
// weight in a table that gets read on every deck view.
async function refreshRoles(options = {}) {
  const { force = false, log = console } = options;
  const startedAt = Date.now();

  const info = await fetchOracleTagsInfo();

  const settings = await db.get(`SELECT card_roles_updated_at FROM app_settings WHERE id = 1`).catch(() => null);
  const lastImported = settings && settings.card_roles_updated_at;
  if (!force && lastImported && info.updatedAt && lastImported === info.updatedAt) {
    log.log(`cardRoles: already current (Scryfall build ${info.updatedAt}); skipping download.`);
    return { skipped: true, reason: 'already_current', updatedAt: info.updatedAt };
  }

  const { tagsById, slugToId, byOracle } = await readTagFile(info.url, { log });
  const families = expandFamilies(tagsById, slugToId);
  for (const [role, slugs] of families) {
    log.log(`cardRoles: ${role} family covers ${slugs.size} tags`);
  }

  // ONE query for the distinct oracle_ids we hold, not one per card. db.js
  // serializes every query onto a single queue, so N lookups in a loop is N
  // sequential waits and would starve every other reader for the duration.
  const cards = await db.all(`
    SELECT oracle_id,
           MIN(type_line) AS type_line,
           MIN(oracle_text) AS oracle_text
      FROM card_cache
     WHERE oracle_id IS NOT NULL AND oracle_id != ''
     GROUP BY oracle_id
  `);

  let classified = 0;
  let untagged = 0;
  const rows = [];
  for (const card of cards) {
    const tagSlugs = byOracle.get(card.oracle_id) || new Set();
    if (!tagSlugs.size) untagged += 1;
    const { role, tag, backRole, backTag } = rolesForFaces({
      typeLine: card.type_line,
      oracleText: card.oracle_text,
      tagSlugs,
      families,
    });
    rows.push([card.oracle_id, role, tag, backRole, backTag]);
    classified += 1;
  }

  // Preserve overrides: user_role is never written here. INSERT ... ON CONFLICT
  // updates only the derived columns, so a card the user has re-labelled keeps
  // its label across every future refresh.
  await db.run('BEGIN');
  try {
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const placeholders = chunk.map(() => '(?, ?, ?, ?, ?)').join(', ');
      const params = chunk.flat();
      await db.run(
        `INSERT INTO card_roles (oracle_id, role, source_tag, back_role, back_source_tag)
         VALUES ${placeholders}
         ON CONFLICT(oracle_id) DO UPDATE SET
           role = excluded.role,
           source_tag = excluded.source_tag,
           back_role = excluded.back_role,
           back_source_tag = excluded.back_source_tag,
           updated_at = CURRENT_TIMESTAMP`,
        params
      );
    }
    await db.run(
      `UPDATE app_settings SET card_roles_updated_at = ? WHERE id = 1`,
      [info.updatedAt]
    );
    await db.run('COMMIT');
  } catch (error) {
    await db.run('ROLLBACK').catch(() => {});
    throw error;
  }

  const seconds = Math.round((Date.now() - startedAt) / 1000);
  log.log(
    `cardRoles: classified ${classified} cards in ${seconds}s ` +
    `(${untagged} had no Scryfall tags and fell back to type line)`
  );
  return { classified, untagged, updatedAt: info.updatedAt, seconds };
}

module.exports = {
  refreshRoles,
  // exported for tests
  expandFamilies,
  roleForCard,
  rolesForFaces,
  VALID_ROLES,
  ROLE_ROOTS,
};
