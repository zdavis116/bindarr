const db = require('../db');
const mox = require('./moxfieldApi');
const { planSync } = require('./moxfieldSync');

// BACKGROUND MOXFIELD POLLING.
//
// Zach: "I would typically be building the decks in moxfield and then having
// them sync to Bindarr so I can see what cards I currently own vs what I need
// to buy." That only works if Bindarr notices on its own.
//
// WHAT THIS DOES NOT DO: apply anything. It detects that a deck has drifted and
// records it, so the UI can offer the sync. Zach's standing rule is that silent
// state changes are unacceptable, and a decklist rewriting itself overnight is
// the clearest case of one -- he would open a deck he had curated and find it
// different, with nothing to point at.
//
// The cheap check is Moxfield's own lastUpdatedAtUtc, which comes back in the
// author deck LIST -- one request covers every deck. A deck is only fetched in
// full when that timestamp has moved past what we last saw.

// Every user with a linked account. Bindarr is single-user in practice, but the
// schema is per-user and a poller that assumes otherwise silently syncs the
// wrong person's decks the day that changes.
async function linkedAccounts() {
  return db.all(
    `SELECT id, user_id, username FROM moxfield_accounts ORDER BY id ASC`
  );
}

// One user's decks, checked against Moxfield.
//
// Returns a summary rather than logging it, so the caller decides what is worth
// saying out loud -- and so this is testable without capturing console output.
async function checkAccount(account) {
  const summary = {
    username: account.username,
    checked: 0,
    changed: [],
    unreachable: false,
    error: null
  };

  let remote;
  try {
    remote = await mox.getAuthorDeckSummaries(account.username);
  } catch (err) {
    // A Moxfield outage is not a Bindarr fault and must not look like one. It
    // is recorded so the UI can say "sync is stale because Moxfield is
    // unreachable" rather than showing an old list as though it were current.
    summary.unreachable = true;
    summary.error = err.message;
    await db.run(
      `UPDATE moxfield_accounts SET last_checked_at = datetime('now'), last_error = ?
        WHERE id = ?`,
      [err.message, account.id]
    );
    return summary;
  }

  const byPublicId = new Map(remote.map(d => [d.public_id, d]));

  // Only decks Bindarr already mirrors. A deck he has never synced is not
  // "changed" -- it is simply not his problem yet, and offering it as a change
  // would make the badge meaningless.
  const linked = await db.all(
    `SELECT id, name, moxfield_public_id, moxfield_updated_at
       FROM decks
      WHERE user_id = ? AND moxfield_public_id IS NOT NULL`,
    [account.user_id]
  );

  for (const deck of linked) {
    const upstream = byPublicId.get(deck.moxfield_public_id);
    if (!upstream) {
      // Deleted on Moxfield, or made private. NOT treated as an instruction to
      // delete the local deck: the search index has already been observed
      // listing a deck that returns 404, and acting on its silence would let a
      // transient index gap wipe a decklist.
      continue;
    }
    summary.checked += 1;

    const seen = deck.moxfield_updated_at;
    const now = upstream.last_updated_at;
    if (seen && now && seen === now) continue;   // unchanged, no fetch needed

    // The timestamp moved, so ask what actually differs. A Moxfield edit can
    // be cosmetic (a description, a tag) and produce no card changes at all --
    // reporting those as "changes" would train him to ignore the badge.
    let payload;
    try {
      payload = await mox.getDeckDetails(deck.moxfield_public_id);
    } catch (err) {
      summary.error = err.message;
      continue;
    }

    const plan = await planSync(account.user_id, deck.id, payload);
    if (plan.changes > 0) {
      summary.changed.push({
        deck_id: deck.id,
        name: deck.name,
        add: plan.add.length,
        remove: plan.remove.length,
        moveBoard: plan.moveBoard.length,
        requantify: plan.requantify.length
      });
    }

    // Record the timestamp we have now RECONCILED AGAINST, whether or not it
    // produced changes. Otherwise a cosmetic edit re-fetches the full deck on
    // every tick forever.
    await db.run(
      `UPDATE decks SET moxfield_updated_at = ? WHERE id = ?`,
      [now, deck.id]
    );
  }

  await db.run(
    `UPDATE moxfield_accounts SET last_checked_at = datetime('now'), last_error = NULL
      WHERE id = ?`,
    [account.id]
  );
  return summary;
}

// One tick. Never throws: a background job that can crash the process is worse
// than one that occasionally misses a poll.
async function runPoll() {
  const results = [];
  try {
    for (const account of await linkedAccounts()) {
      results.push(await checkAccount(account));
    }
  } catch (err) {
    console.error('Moxfield poll failed:', err.message);
  }
  return results;
}

module.exports = { runPoll, checkAccount, linkedAccounts };
