// RULINGS ON THE CARD TAB.
//
// Zach: "I would like to add to the card tab a ruling section so I can see all
// rulings made for that card."
//
// He asks rules questions about his own decks -- Alhammarret's Archive and
// Library of Leng both came up in conversation and both have rulings that
// settle the question outright. These are answers, not trivia.
//
// Verified against real dev data: 78,948 rulings across 19,938 cards imported
// in 30s; the API returns 5 for Alhammarret's Archive, 9 for Library of Leng,
// 2 for Seedborn Muse and 0 for Island -- matching Scryfall exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const insp = readFileSync(
  join(repo, 'frontend/src/components/CardInspectorModal.jsx'), 'utf8');
const inspCode = strip(insp);
const importer = readFileSync(join(repo, 'backend/src/cardRulings.js'), 'utf8');
const importerCode = strip(importer);
const route = strip(readFileSync(join(repo, 'backend/src/routes/collection.js'), 'utf8'));
const dbCode = strip(readFileSync(join(repo, 'backend/src/db.js'), 'utf8'));
const en = JSON.parse(readFileSync(join(repo, 'frontend/src/locales/en.json'), 'utf8'));

test('RUL-TC1: rulings are keyed by ORACLE id, not by printing', () => {
  // A ruling is true of the CARD, so it applies to every printing of it. The
  // catalogue holds ~105,800 printings for ~34,700 oracle ids -- keying on the
  // printing would triplicate every row AND let two printings of one card
  // disagree about the rules, which is the "same question answered in two
  // places" failure this codebase keeps hitting.
  assert.match(dbCode, /CREATE TABLE IF NOT EXISTS card_rulings[\s\S]{0,200}oracle_id TEXT NOT NULL/,
    'card_rulings must key on oracle_id');
  assert.match(importerCode, /WHERE oracle_id = \?/,
    'the lookup must be by oracle_id');
  assert.match(route, /rulingsFor\(card\.oracle_id\)/,
    'the route must pass the oracle id, not the card id');
});

test('RUL-TC2: a truncated download must not wipe the rulings we have', () => {
  // The importer replaces every row. If a download yields nothing -- a network
  // drop, a bad gzip, Scryfall serving an empty file -- swapping it in would
  // delete all 78,948 rulings and report success. Refusing an empty import is
  // the difference between "today's refresh failed" and "the feature is gone".
  assert.match(importerCode, /if \(!staged\.accepted\)[\s\S]{0,200}throw new Error/,
    'an import that staged zero rows must throw, not swap');

  // And the swap itself must be atomic, so a reader never sees a half-empty
  // table between the DELETE and the INSERT.
  const apply = importerCode.slice(importerCode.indexOf('async function applyStaged'));
  assert.match(apply.slice(0, 500), /withTransaction/,
    'the delete+insert swap must be one transaction');
  assert.match(apply.slice(0, 500), /DELETE FROM card_rulings[\s\S]*INSERT INTO card_rulings/,
    'the swap must replace the table inside that transaction');
});

test('RUL-TC3: a missing rulings table must not take down the card sheet', () => {
  // A fresh database has the table but no rows until the first import runs.
  // "No rulings" is a NORMAL state -- every basic land has none -- so it must
  // render as an empty section, never as a failed card sheet.
  const call = route.slice(route.indexOf('rulingsFor(card.oracle_id)'));
  assert.match(call.slice(0, 400), /\.catch\(/,
    'a rulings read failure must be caught');
  assert.match(call.slice(0, 400), /return \[\]/,
    'and must fall back to an empty list, not propagate');
});

test('RUL-TC4: the section is collapsed by default and only shown when it has content', () => {
  const block = inspCode.slice(inspCode.indexOf('ci-rulings') - 600,
                               inspCode.indexOf('ci-rulings') + 400);

  // DEFAULT CLOSED. Path of Ancestry has 7 rulings and Library of Leng has 9;
  // open by default they push the rules text -- the thing you opened the card
  // to read -- off a 390px screen. Measured: the tab's scroll height goes from
  // 218px to 987px with the section open.
  assert.doesNotMatch(block, /<details[^>]*\bopen\b/,
    'the rulings section must not be open by default');

  // AND HIDDEN WHEN EMPTY. An always-present "Rulings (0)" row on every basic
  // land is a control that teaches you to ignore it.
  assert.match(block, /rulings\.length > 0 &&/,
    'the section must only render when there are rulings');
});

test('RUL-TC5: every ruling shows its date', () => {
  // A later ruling supersedes an earlier one -- Doubling Season's planeswalker
  // rulings were rewritten in 2024 and its 2006 ones are history. Undated,
  // they would all read as equally current, which is worse than not showing
  // them: it is a confident wrong answer.
  // ASSERT THE GATE, NOT THE MENTION. An earlier version matched
  // /r\.published_at/ anywhere in the block, which stayed green when the whole
  // date row was disabled with `{false && (` -- the reference survived inside
  // the dead branch. The mutation harness caught it.
  const block = inspCode.slice(inspCode.indexOf('ci-rulings'),
                               inspCode.indexOf('ci-rulings') + 2000);
  assert.match(block, /\{r\.published_at && \(/,
    'each ruling must render its published date, gated on the date existing');

  // Newest first, for the same reason.
  assert.match(importerCode, /ORDER BY published_at DESC/,
    'rulings must come back newest first');
});

test('RUL-TC6: the counted label has plural forms', () => {
  // translate() selects .one/.other via Intl.PluralRules whenever count is a
  // number. A flat "Rulings ({count})" renders "Rulings (1)" for a card with
  // one ruling -- the exact bug this project has already shipped once.
  assert.ok(en['inspector.rulings.one'], 'a .one form must exist');
  assert.ok(en['inspector.rulings.other'], 'a .other form must exist');
  assert.match(en['inspector.rulings.one'], /\{count\}/, '.one must use the count');
  assert.match(en['inspector.rulings.other'], /\{count\}/, '.other must use the count');
  assert.ok(!en['inspector.rulings'],
    'a flat key beside the plural forms would win and render "Rulings (1)"');
});

test('RUL-TC7: the import skips the download when Scryfall has not rebuilt', () => {
  // A few-kilobyte index check instead of 5.1 MB, so the job is safe to run
  // often and safe to re-run by hand -- the same guard the card catalogue uses
  // to stop dev and production each pulling the file every night.
  assert.match(importerCode, /card_rulings_updated_at/,
    'the last imported build must be recorded');
  assert.match(importerCode, /already_current/,
    'an unchanged build must skip the download');

  // Its OWN column, not the catalogue's: the two bulk files are rebuilt on
  // different schedules, so sharing a timestamp would make one skip when the
  // other changed.
  assert.notEqual(
    importerCode.indexOf('card_rulings_updated_at'), -1);
  assert.equal(importerCode.indexOf('card_catalogue_updated_at'), -1,
    'rulings must not read the catalogue\'s build timestamp');
});

test('RUL-TC8: rulings are imported AFTER the catalogue, and cannot break it', () => {
  const server = strip(readFileSync(join(repo, 'backend/src/server.js'), 'utf8'));
  const chain = server.slice(server.indexOf('refreshCatalogue'));

  // ORDER IS THE CORRECTNESS CONDITION. Rulings key on oracle_id, so importing
  // them beside a half-swapped card_cache attaches them to ids about to be
  // replaced.
  const rolesAt = chain.indexOf('refreshRoles');
  const rulingsAt = chain.indexOf('refreshRulings');
  assert.ok(rulingsAt > rolesAt && rolesAt > 0,
    'rulings must be chained after the catalogue and roles');

  // AND MUST NOT TAKE THE REFRESH DOWN. A missing ruling makes the Card tab
  // less useful; prices and legality depend on the catalogue finishing.
  //
  // ANCHORED TO THE CALL ITSELF. An earlier version searched the 300 chars
  // after `refreshRulings` for `.catch(` and stayed green when that catch was
  // turned into a `.then(` -- because the ROLES catch a few lines above was
  // still inside the window. A guard that can be satisfied by a different
  // line's error handling is not guarding anything.
  assert.match(chain, /refreshRulings\(\{\}\)\.catch\(/,
    'a rulings failure must be caught on the rulings call, not somewhere near it');
});
