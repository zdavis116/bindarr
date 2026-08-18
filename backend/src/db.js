const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const DB_FILENAME = 'bindarr.db';

// Ensure database directory exists
const requestedDbPath = process.env.DB_PATH || path.join(__dirname, `../database/${DB_FILENAME}`);
const fs = require('fs');
const dbDir = path.dirname(requestedDbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const dbPath = requestedDbPath;

console.log(`Connecting to SQLite database at: ${dbPath}`);
const dbConnection = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Database connection established successfully.');
    dbConnection.run('PRAGMA foreign_keys = ON');
    dbConnection.run('PRAGMA journal_mode = WAL');
    dbConnection.run('PRAGMA busy_timeout = 5000');
  }
});

// SQLite has one shared connection. Every operation that is not owned by the
// currently active transaction takes a turn on this queue, so ordinary queries
// cannot slip between BEGIN and COMMIT (or between two transaction statements).
const transactionContext = new AsyncLocalStorage();
let activeTransactionToken = null;
let operationQueue = Promise.resolve();
let poisonedError = null;
let databaseLifecycle = 'open';
let closePromise = null;
let closeFailure = null;
let rawOperationTouchCount = 0;
let nextControlStatementFailure = null;
// Test-only fault injection for the collection rebuild's copy verification.
//
// The verification exists to refuse a partial migration, and a guard that has
// never been observed failing is only a guess that it works. SQLite will not
// silently drop rows from an INSERT..SELECT -- it raises -- so the only honest
// way to exercise the mismatch branch is to corrupt the copy deliberately.
// Gated behind BINDARR_DB_TEST_HOOKS so it cannot exist in a running server.
let corruptNextCollectionCopy = false;
let nextCloseFailure = null;

function databaseUnavailableError() {
  const error = new Error('Database state is unknown; restart the process before retrying');
  error.code = 'DB_STATE_UNKNOWN';
  error.cause = poisonedError;
  return error;
}

function databaseLifecycleError() {
  const closed = databaseLifecycle === 'closed';
  const closeFailed = databaseLifecycle === 'close_failed';
  const error = new Error(closed
    ? 'Database is closed'
    : closeFailed ? 'Database close failed; database is unavailable' : 'Database is closing');
  error.code = closed ? 'DB_CLOSED' : 'DB_CLOSING';
  if (closeFailed) error.cause = closeFailure;
  return error;
}

function closeInsideTransactionError() {
  const error = new Error('Cannot close the database from a transaction context');
  error.code = 'DB_CLOSE_IN_TRANSACTION';
  return error;
}

function enqueue(operation) {
  if (poisonedError) return Promise.reject(databaseUnavailableError());
  const result = operationQueue.then(() => {
    if (poisonedError) throw databaseUnavailableError();
    return operation();
  });
  operationQueue = result.catch(() => {});
  return result;
}

function rawRun(sql, params = []) {
  rawOperationTouchCount++;
  const normalizedSql = String(sql).trim().toUpperCase();
  if (nextControlStatementFailure?.statement === normalizedSql) {
    const failure = nextControlStatementFailure.error;
    nextControlStatementFailure = null;
    return Promise.reject(failure);
  }
  return new Promise((resolve, reject) => {
    dbConnection.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function rawGet(sql, params = []) {
  rawOperationTouchCount++;
  return new Promise((resolve, reject) => {
    dbConnection.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function rawAll(sql, params = []) {
  rawOperationTouchCount++;
  return new Promise((resolve, reject) => {
    dbConnection.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function currentTransactionStore() {
  return transactionContext.getStore();
}

function ownsActiveTransaction() {
  const token = currentTransactionStore()?.token;
  return !!token && token.active && token === activeTransactionToken;
}

function staleTransactionError() {
  const error = new Error('Transaction context is stale');
  error.code = 'STALE_TRANSACTION';
  return error;
}

function transactionTimeoutError(timeoutMs) {
  const error = new Error(`Transaction timed out after ${timeoutMs}ms`);
  error.code = 'TRANSACTION_TIMEOUT';
  return error;
}

function registerOwnedPromise(token, promise) {
  token.pending.add(promise);
  promise.then(
    () => token.pending.delete(promise),
    error => {
      token.pending.delete(promise);
      if (!token.failure) token.failure = error;
    }
  );
  return promise;
}

async function settleOwnedPromises(token) {
  while (token.pending.size > 0) {
    await Promise.all([...token.pending].map(promise => promise.catch(() => undefined)));
  }
}

function ownedOrQueued(rawOperation) {
  const store = currentTransactionStore();
  if (ownsActiveTransaction()) {
    return registerOwnedPromise(store.token, rawOperation());
  }
  if (store?.token) return Promise.reject(staleTransactionError());
  if (databaseLifecycle !== 'open') return Promise.reject(databaseLifecycleError());
  return enqueue(rawOperation);
}

function run(sql, params = []) {
  return ownedOrQueued(() => rawRun(sql, params));
}

function get(sql, params = []) {
  return ownedOrQueued(() => rawGet(sql, params));
}

function all(sql, params = []) {
  return ownedOrQueued(() => rawAll(sql, params));
}

function close(callback) {
  if (currentTransactionStore()?.token) {
    const rejected = Promise.reject(closeInsideTransactionError());
    if (typeof callback === 'function') rejected.catch(error => callback(error));
    return rejected;
  }
  if (!closePromise) {
    databaseLifecycle = 'closing';
    closePromise = operationQueue.then(() => new Promise((resolve, reject) => {
      if (nextCloseFailure) {
        const failure = nextCloseFailure;
        nextCloseFailure = null;
        reject(failure);
        return;
      }
      dbConnection.close(error => error ? reject(error) : resolve());
    })).then(result => {
      databaseLifecycle = 'closed';
      return result;
    }, error => {
      databaseLifecycle = 'close_failed';
      closeFailure = error;
      throw error;
    });
    operationQueue = closePromise.catch(() => {});
  }
  if (typeof callback === 'function') {
    closePromise.then(() => callback(null), callback);
  }
  return closePromise;
}

const DEFAULT_TRANSACTION_TIMEOUT_MS = 30_000;
const MAX_TRANSACTION_TIMEOUT_MS = 2_147_483_647;

// Supported forms are withTransaction(fn, { timeoutMs }) and the legacy
// withTransaction(db, fn, { timeoutMs }). The timeout covers the callback and
// all transaction-owned promises registered before owner completion.
function withTransaction(dbOrFn, asyncFn, maybeOptions) {
  const store = currentTransactionStore();
  if (store?.token && !ownsActiveTransaction()) return Promise.reject(staleTransactionError());
  if (!ownsActiveTransaction() && databaseLifecycle !== 'open') {
    return Promise.reject(databaseLifecycleError());
  }
  const fn = typeof dbOrFn === 'function' ? dbOrFn : asyncFn;
  const options = (typeof dbOrFn === 'function' ? asyncFn : maybeOptions) || {};
  const timeoutMs = options.timeoutMs ?? DEFAULT_TRANSACTION_TIMEOUT_MS;
  if (typeof fn !== 'function') return Promise.reject(new TypeError('withTransaction requires a callback'));
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new TypeError('withTransaction timeoutMs must be a positive finite integer'));
  }
  if (timeoutMs > MAX_TRANSACTION_TIMEOUT_MS) {
    return Promise.reject(new RangeError(
      `withTransaction timeoutMs must not exceed ${MAX_TRANSACTION_TIMEOUT_MS}`
    ));
  }
  const tx = { run, get, all, withTransaction };
  if (ownsActiveTransaction()) {
    const nested = transactionContext.run(
      { token: store.token },
      () => Promise.resolve().then(() => fn(tx))
    );
    return registerOwnedPromise(store.token, nested);
  }
  if (poisonedError) return Promise.reject(databaseUnavailableError());

  return enqueue(async () => {
    const token = { active: false, pending: new Set(), failure: null };
    await rawRun('BEGIN IMMEDIATE TRANSACTION');
    token.active = true;
    activeTransactionToken = token;
    let timer;
    try {
      const ownerWork = (async () => {
        let result;
        let callbackError;
        try {
          result = await transactionContext.run(
            { token },
            () => fn(tx)
          );
        } catch (error) {
          callbackError = error;
        }
        await settleOwnedPromises(token);
        if (callbackError) throw callbackError;
        if (token.failure) throw token.failure;
        return result;
      })();
      const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          reject(transactionTimeoutError(timeoutMs));
        }, timeoutMs);
      });
      const result = await Promise.race([ownerWork, timeout]);
      clearTimeout(timer);
      token.active = false;
      activeTransactionToken = null;
      await rawRun('COMMIT');
      return result;
    } catch (error) {
      clearTimeout(timer);
      token.active = false;
      activeTransactionToken = null;
      try {
        await rawRun('ROLLBACK');
      } catch (rollbackError) {
        const combined = new AggregateError(
          [error, rollbackError],
          'Transaction failed and rollback cleanup also failed'
        );
        poisonedError = combined;
        throw combined;
      }
      throw error;
    }
  });
}

const PBKDF2_ITERATIONS = 210000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 64, 'sha512').toString('hex');
  return `${PBKDF2_ITERATIONS}:${salt}:${hash}`;
}

// Initialize tables
async function initDb() {
  const existingCollectionCols = await all(`PRAGMA table_info(collection)`).catch(() => []);
  if (existingCollectionCols.some(c => c.name === 'sub_location_1')) {
    console.log('Resetting locations/collection tables for the new compartment-based storage schema...');
    await run(`PRAGMA foreign_keys = OFF`);
    await run(`DROP TABLE IF EXISTS collection`);
    await run(`DROP TABLE IF EXISTS locations`);
    await run(`PRAGMA foreign_keys = ON`);
  }

  // Create users table
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT CHECK(role IN ('admin', 'member')) NOT NULL DEFAULT 'member',
      share_token TEXT UNIQUE NOT NULL,
      share_enabled INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create sessions table
  await run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at DATETIME NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      public_base_url TEXT DEFAULT '',
      mtg_prices_swept_at DATETIME
    )
  `);
  await run(`INSERT OR IGNORE INTO app_settings (id, public_base_url) VALUES (1, '')`);

  await run(`
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT CHECK(type IN ('Binder', 'Toploader Binder', 'Box', 'Toploader Box', 'Graded Slab Box', 'Display Shelf / Stand', 'Deck Box', 'Tin / Case', 'Other')) NOT NULL,
      sort_order TEXT DEFAULT '[{"by":"name","dir":"asc"}]',
      foil_sorting TEXT DEFAULT 'normals_first',
      rule_type TEXT DEFAULT 'any',
      rule_config TEXT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS compartments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      label TEXT,
      capacity INTEGER NOT NULL DEFAULT 40,
      rule_config TEXT,
      UNIQUE(location_id, idx)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS compartment_assignments (
      compartment_id INTEGER NOT NULL REFERENCES compartments(id) ON DELETE CASCADE,
      filter_value TEXT NOT NULL,
      PRIMARY KEY(compartment_id, filter_value)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS sets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      series TEXT,
      printed_total INTEGER,
      total INTEGER,
      release_date TEXT,
      ptcgo_code TEXT,
      symbol_url TEXT,
      logo_url TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS card_cache (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      supertype TEXT,
      subtypes TEXT,
      types TEXT,
      rarity TEXT,
      set_id TEXT,
      set_name TEXT,
      number TEXT,
      image_url TEXT,
      price_trend REAL,
      price_normal REAL,
      price_holofoil REAL,
      price_reverse_holofoil REAL,
      price_avg1 REAL,
      price_avg7 REAL,
      price_avg30 REAL,
      cmc REAL,
      color_identity TEXT,
      oracle_id TEXT NOT NULL,
      oracle_name TEXT,
      mana_cost TEXT,
      oracle_text TEXT,
      type_line TEXT,
      keywords TEXT,
      legalities TEXT,
      finishes TEXT,
      layout TEXT,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS collection (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id TEXT NOT NULL,
      quantity INTEGER DEFAULT 1,
      condition TEXT CHECK(condition IN ('Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged')) DEFAULT 'Near Mint',
      printing TEXT CHECK(printing IN ('Normal', 'Foil', 'Etched')) DEFAULT 'Normal',
      purchase_price REAL,
      location_id INTEGER,
      compartment_id INTEGER,
      position REAL DEFAULT 0,
      favorite INTEGER DEFAULT 0,
      is_trade INTEGER DEFAULT 0,
      list_type TEXT DEFAULT 'collection',
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(location_id) REFERENCES locations(id) ON DELETE SET NULL,
      FOREIGN KEY(compartment_id) REFERENCES compartments(id) ON DELETE SET NULL,
      FOREIGN KEY(card_id) REFERENCES card_cache(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#3B82F6',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, name)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS collection_tags (
      collection_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (collection_id, tag_id),
      FOREIGN KEY (collection_id) REFERENCES collection(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      action_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      before_state TEXT,
      after_state TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS saved_filter_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      filter_config TEXT NOT NULL,
      sort_config TEXT NOT NULL,
      is_default INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, name)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id TEXT NOT NULL,
      price REAL NOT NULL,
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_price_history_card_time ON price_history(card_id, recorded_at, id)`);

  // A deck has NO 'considering' status.
  //
  // PR 6C briefly gave decks a status column with 'active' and 'considering'
  // values. That was a modelling mistake and PR 6D removes it. "Considering"
  // is a statement about ONE CARD -- "I am thinking about putting this in" --
  // and it is expressed by the per-entry `board` column below. A whole deck is
  // never in a considering state: the user either has a deck or they do not,
  // and the deck-level statuses the app actually shows (Building, Ready, In
  // Play) are DERIVED at read time from card count vs target_size and the
  // checked_out flag. Deriving them is the point -- a stored duplicate of a
  // count would go stale the moment a card was added.
  //
  // The consequence for reservation is a simplification: whether an entry
  // reserves inventory now depends on its board and nothing else. See
  // utils/deckIdentity.js.
  await run(`
    CREATE TABLE IF NOT EXISTS decks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      checked_out INTEGER DEFAULT 0,
      checked_out_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Exact-only deck identity.
  //
  // The old table keyed on (deck_id, card_id) with no finish at all, which made
  // "four Lightning Bolts" a statement about a NAME rather than about four
  // physical objects. Every column here is NOT NULL by design: a nullable
  // desired printing is a flexible-matching backdoor, and the only way to keep
  // that door shut across every future code path is to let the database refuse
  // the row.
  //
  // oracle_id is carried for rules/grouping display only. It NEVER widens
  // inventory matching -- two printings of one Oracle card are two unrelated
  // piles of cardboard as far as reservation and checkout are concerned.
  //
  // The surrogate `id` primary key matters beyond convenience: reservation
  // priority is defined as deck_cards.id ASC, so requirements need a stable,
  // monotonic, insertion-ordered identity. A composite key gives no such order.
  await run(`
    CREATE TABLE IF NOT EXISTS deck_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deck_id INTEGER NOT NULL,
      oracle_id TEXT NOT NULL,
      desired_card_id TEXT NOT NULL,
      desired_finish TEXT NOT NULL CHECK(desired_finish IN ('nonfoil', 'foil', 'etched')),
      board TEXT NOT NULL DEFAULT 'mainboard'
        CHECK(board IN ('commander', 'mainboard', 'sideboard', 'considering')),
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      checked_out INTEGER NOT NULL DEFAULT 0,
      UNIQUE(deck_id, oracle_id, desired_card_id, desired_finish, board),
      FOREIGN KEY(deck_id) REFERENCES decks(id) ON DELETE CASCADE,
      FOREIGN KEY(desired_card_id) REFERENCES card_cache(id)
    )
  `);

  // Which PHYSICAL collection row was pulled for a checked-out deck.
  //
  // Reservation is derived on every read (see deckIdentity.js) precisely so it
  // can never drift out of sync with the requirements. Physical allocation is
  // the opposite case and must be STORED: once the user has walked to the
  // binder, pulled a specific sleeve, and put it in a deck box, the app is no
  // longer free to recompute a different answer. A derived allocation would
  // silently point at a different copy the moment any unrelated collection row
  // was added or removed, and the user would have no way to reconcile the app
  // against the cards physically in their hand.
  await run(`
    CREATE TABLE IF NOT EXISTS deck_card_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deck_card_id INTEGER NOT NULL,
      collection_entry_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      allocated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(deck_card_id, collection_entry_id),
      FOREIGN KEY(deck_card_id) REFERENCES deck_cards(id) ON DELETE CASCADE,
      FOREIGN KEY(collection_entry_id) REFERENCES collection(id) ON DELETE CASCADE
    )
  `);


  await run(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT DEFAULT '',
      body TEXT DEFAULT '',
      pinned INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // --- MIGRATIONS ---
  // When each game's price sweep last ran. Scryfall updates prices once a day,
  // so a sweep more often than that cannot return anything new — and the boot
  // sweep would otherwise re-run on every restart (constantly, under nodemon).
  // Persisted rather than in-memory precisely because restarts are the problem.
  const appSettingsCols = await all(`PRAGMA table_info(app_settings)`);
  if (!appSettingsCols.some(c => c.name === 'mtg_prices_swept_at')) {
    await run(`ALTER TABLE app_settings ADD COLUMN mtg_prices_swept_at DATETIME`);
  }

  const cardCacheCols = await all(`PRAGMA table_info(card_cache)`);
  // Marketplace links as the PROVIDER gives them. Building them from name+set+number
  // only works for English cards: searching TCGplayer for "ヒトカゲ ポケモンカード151"
  // Provider-supplied marketplace links are stored verbatim.
  for (const col of ['tcgplayer_url', 'cardmarket_url']) {
    if (!cardCacheCols.some(c => c.name === col)) {
      await run(`ALTER TABLE card_cache ADD COLUMN ${col} TEXT`);
    }
  }

  const collectionCols = await all(`PRAGMA table_info(collection)`);
  if (!collectionCols.some(c => c.name === 'user_id')) {
    await run(`ALTER TABLE collection ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`);
  }
  if (!collectionCols.some(c => c.name === 'is_trade')) {
    await run(`ALTER TABLE collection ADD COLUMN is_trade INTEGER DEFAULT 0`);
  }
  if (!collectionCols.some(c => c.name === 'favorite')) {
    await run(`ALTER TABLE collection ADD COLUMN favorite INTEGER DEFAULT 0`);
  }
  if (!collectionCols.some(c => c.name === 'list_type')) {
    await run(`ALTER TABLE collection ADD COLUMN list_type TEXT DEFAULT 'collection'`);
  }
  if (!collectionCols.some(c => c.name === 'compartment_id')) {
    await run(`ALTER TABLE collection ADD COLUMN compartment_id INTEGER REFERENCES compartments(id) ON DELETE SET NULL`);
  }
  if (!collectionCols.some(c => c.name === 'position')) {
    await run(`ALTER TABLE collection ADD COLUMN position REAL DEFAULT 0`);
  }
  if (!collectionCols.some(c => c.name === 'notes')) {
    await run(`ALTER TABLE collection ADD COLUMN notes TEXT DEFAULT ''`);
  }
  // Canonical MTG finish on the PHYSICAL row.
  //
  // Deck requirements match on (desired_card_id, desired_finish). That match is
  // only meaningful if the collection row states its finish in the SAME
  // vocabulary. The legacy `printing` column carries Pokemon-era values
  // ('Normal', 'Holofoil', ...) and cannot be compared to 'nonfoil'/'foil'
  // without a translation at every call site -- and a translation at every call
  // site is exactly the kind of duplicated rule that drifts.
  //
  // Scope note: this is the minimum needed to make exact matching enforceable.
  // Full finish handling (scanner confirmation, per-printing finish options in
  // the add/import UI) remains PR 9 per the plan.
  if (!collectionCols.some(c => c.name === 'finish')) {
    await run(
      `ALTER TABLE collection ADD COLUMN finish TEXT NOT NULL DEFAULT 'nonfoil'
       CHECK(finish IN ('nonfoil', 'foil', 'etched'))`
    );
  }

  // MTG finishes on the display column (PR 6E).
  //
  // The `printing` CHECK above used to permit only Pokemon finishes
  // ('Normal', 'Holofoil', 'Reverse Holofoil', '1st Edition', 'Promo'), left
  // over from before this fork went MTG-only. Magic has three finishes, and the
  // API sends the display form 'Foil' -- which that constraint forbade. The
  // result was that EVERY foil add failed with SQLITE_CONSTRAINT and returned
  // HTTP 500. Since PR 6C made finish part of card identity, that made
  // exact-only deck matching unusable for every foil card the user owns.
  //
  // `finish` is now the source of truth and `printing` is its display mirror
  // (see utils/finishes.js). A fresh database gets the corrected CHECK from the
  // CREATE TABLE above; an existing dev database needs this rebuild, because
  // SQLite cannot alter a CHECK constraint in place.
  //
  // Data is MIGRATED, not dropped. The mapping is the only one that preserves
  // what the row physically means: Holofoil was the only value this fork's
  // MTG-only UI could produce for a foil card, so it becomes 'Foil'; every
  // other legacy value described a Pokemon-only concept that an MTG card cannot
  // have, so it becomes 'Normal'. Rows are then made self-consistent by
  // deriving `finish` from the migrated display value, so the authoritative
  // column agrees with the mirror on every pre-existing row.
  const collectionSchema = await get(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'collection'`
  );
  if (collectionSchema && collectionSchema.sql && collectionSchema.sql.includes("'Holofoil'")) {
    console.log('Migrating collection.printing from Pokemon finishes to MTG finishes...');
    await run(`PRAGMA foreign_keys = OFF`);
    try {
      await run(`BEGIN`);

      // The translation happens DURING the copy, never as an in-place UPDATE.
      //
      // The obvious-looking version of this migration normalised the data first
      // ("UPDATE collection SET printing = 'Foil' WHERE printing = 'Holofoil'")
      // and rebuilt the table afterwards. That cannot work, and it is worth
      // spelling out why so nobody reintroduces it: the UPDATE runs while the
      // OLD CHECK is still attached to the table, and the old CHECK is exactly
      // the thing that forbids 'Foil'. The step whose job is to escape the
      // constraint is rejected BY the constraint. initDb() threw, and because
      // server.js awaits initDb(), an existing database simply did not boot.
      //
      // Writing every row straight into the new table with the mapping applied
      // inline means no row is ever written while a constraint that forbids its
      // value is in force. There is no intermediate state to be rejected.
      //
      // The mapping is the only one that preserves what the row physically
      // means: 'Holofoil' was the only value this fork's MTG-only UI could
      // produce for a foil card, so it becomes 'Foil'; every other legacy value
      // ('Reverse Holofoil', '1st Edition', 'Promo', NULL) describes a
      // Pokemon-only concept that an MTG card cannot have, so it becomes
      // 'Normal'. Values that are already valid MTG display forms pass through.
      const printingExpr = `
        CASE
          WHEN printing = 'Holofoil' THEN 'Foil'
          WHEN printing IN ('Normal', 'Foil', 'Etched') THEN printing
          ELSE 'Normal'
        END`;

      // `finish` is the source of truth and `printing` its display mirror, so
      // the canonical column is derived from the MIGRATED display value in the
      // same copy -- the two cannot come out of this disagreeing. A row whose
      // finish was already set deliberately (anything other than the column
      // default) is trusted and left alone.
      const finishExpr = `
        CASE
          WHEN finish IS NOT NULL AND finish <> 'nonfoil' THEN finish
          WHEN printing = 'Holofoil' THEN 'foil'
          WHEN printing = 'Foil' THEN 'foil'
          WHEN printing = 'Etched' THEN 'etched'
          ELSE 'nonfoil'
        END`;

      // Copy every column the live table actually has, so a column added by an
      // earlier ALTER above is carried over without this block having to be
      // kept in sync with that list by hand.
      const cols = (await all(`PRAGMA table_info(collection)`)).map(c => c.name);
      const colList = cols.join(', ');
      const selectList = cols
        .map(c => (c === 'printing' ? `${printingExpr} AS printing`
          : c === 'finish' ? `${finishExpr} AS finish`
            : c))
        .join(', ');

      // Build the replacement ALONGSIDE the original rather than renaming the
      // original out of the way first.
      //
      // This ordering is load-bearing, not stylistic. SQLite rewrites foreign
      // key clauses in OTHER tables to follow a renamed table, and it does so
      // even with `PRAGMA foreign_keys = OFF` (that pragma governs enforcement,
      // not schema rewriting). collection_tags and deck_card_allocations both
      // reference collection(id); renaming collection to a scratch name would
      // silently repoint their FKs at the scratch table, and dropping the
      // scratch table afterwards would leave both pointing at a table that no
      // longer exists. Creating collection_new, dropping collection, then
      // renaming collection_new into place leaves those clauses untouched --
      // verified below before we commit.
      await run(`
        CREATE TABLE collection_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          card_id TEXT NOT NULL,
          quantity INTEGER DEFAULT 1,
          condition TEXT CHECK(condition IN ('Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged')) DEFAULT 'Near Mint',
          printing TEXT CHECK(printing IN ('Normal', 'Foil', 'Etched')) DEFAULT 'Normal',
          purchase_price REAL,
          location_id INTEGER,
          compartment_id INTEGER,
          position REAL DEFAULT 0,
          favorite INTEGER DEFAULT 0,
          is_trade INTEGER DEFAULT 0,
          list_type TEXT DEFAULT 'collection',
          added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          notes TEXT DEFAULT '',
          finish TEXT NOT NULL DEFAULT 'nonfoil' CHECK(finish IN ('nonfoil', 'foil', 'etched')),
          FOREIGN KEY(location_id) REFERENCES locations(id) ON DELETE SET NULL,
          FOREIGN KEY(compartment_id) REFERENCES compartments(id) ON DELETE SET NULL,
          FOREIGN KEY(card_id) REFERENCES card_cache(id)
        )
      `);
      await run(`INSERT INTO collection_new (${colList}) SELECT ${selectList} FROM collection`);

      // Deliberately damage the copy when a test asks for it, so the guard
      // below is proven to fire rather than assumed to.
      if (corruptNextCollectionCopy) {
        corruptNextCollectionCopy = false;
        await run(`DELETE FROM collection_new WHERE id = (SELECT MIN(id) FROM collection_new)`);
      }

      // Prove the copy before dropping the source.
      //
      // Row count alone is not enough for software that tracks physical
      // objects: the same seven rows can be copied while a quantity is
      // mangled, and the user would have no way to notice that their playset
      // quietly became a single. Both the number of rows AND the number of
      // physical copies must match, or the whole thing rolls back and the
      // original table stays exactly where it was. A migration that cannot
      // complete correctly must leave the database as it found it rather than
      // commit a collection that is quietly short some cards.
      const oldTotals = await get(`SELECT COUNT(*) AS rows, COALESCE(SUM(quantity), 0) AS copies FROM collection`);
      const newTotals = await get(`SELECT COUNT(*) AS rows, COALESCE(SUM(quantity), 0) AS copies FROM collection_new`);
      if (oldTotals.rows !== newTotals.rows) {
        throw new Error(`collection migration lost rows: ${oldTotals.rows} -> ${newTotals.rows}`);
      }
      if (oldTotals.copies !== newTotals.copies) {
        throw new Error(`collection migration lost copies: ${oldTotals.copies} -> ${newTotals.copies}`);
      }
      // No row may survive the copy still speaking the old vocabulary. If the
      // CASE above ever misses a value, that is a bug in this migration and it
      // must surface here rather than as a constraint failure at some later
      // write.
      const unmapped = await get(
        `SELECT COUNT(*) AS n FROM collection_new WHERE printing NOT IN ('Normal', 'Foil', 'Etched')`
      );
      if (unmapped.n > 0) {
        throw new Error(`collection migration left ${unmapped.n} row(s) on a non-MTG printing value`);
      }

      await run(`DROP TABLE collection`);
      await run(`ALTER TABLE collection_new RENAME TO collection`);

      // Confirm the swap did not repoint anybody's foreign key.
      //
      // Deliberately NOT `PRAGMA foreign_key_check`: that scans the whole
      // database and would fail the boot over a pre-existing orphan row this
      // migration neither created nor touched. Refusing to start over damage
      // we did not cause is not conservatism, it is a self-inflicted outage.
      // What must be verified is the specific hazard of a table rebuild --
      // that every table referencing collection still names `collection`.
      const referrers = await all(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'table' AND sql LIKE '%REFERENCES%collection%' AND name <> 'collection'`
      );
      const stranded = referrers.filter(t => /REFERENCES\s+"?collection_(new|legacy_printing)"?/i.test(t.sql));
      if (stranded.length > 0) {
        throw new Error(
          `collection migration stranded foreign key(s) on: ${stranded.map(t => t.name).join(', ')}`
        );
      }

      await run(`COMMIT`);
      console.log(`Migrated ${newTotals.rows} collection row(s) to MTG finishes.`);
    } catch (error) {
      await run(`ROLLBACK`).catch(() => {});
      throw error;
    } finally {
      await run(`PRAGMA foreign_keys = ON`);
    }
  }

  const locationsCols = await all(`PRAGMA table_info(locations)`);
  if (!locationsCols.some(c => c.name === 'user_id')) {
    await run(`ALTER TABLE locations ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`);
  }
  if (!locationsCols.some(c => c.name === 'sort_order')) {
    await run(`ALTER TABLE locations ADD COLUMN sort_order TEXT DEFAULT '[{"by":"name","dir":"asc"}]'`);
  }
  if (!locationsCols.some(c => c.name === 'foil_sorting')) {
    await run(`ALTER TABLE locations ADD COLUMN foil_sorting TEXT DEFAULT 'normals_first'`);
  }
  const usersCols = await all(`PRAGMA table_info(users)`);
  if (!usersCols.some(c => c.name === 'share_locations')) {
    await run(`ALTER TABLE users ADD COLUMN share_locations INTEGER DEFAULT 0`);
  }

  // No deck_cards/decks column migrations here. PR 6C rebuilt both tables in
  // their final exact-only shape above, and this fork starts from a fresh v2
  // database (plan section 7), so there is no legacy deck row to upgrade. An
  // ALTER guard here would be worse than useless: it would quietly re-add a
  // column to a table that no longer has the shape the guard assumes.
  const decksCols = await all(`PRAGMA table_info(decks)`);

  if (!decksCols.some(c => c.name === 'format')) {
    await run(`ALTER TABLE decks ADD COLUMN format TEXT DEFAULT 'Standard'`);
  }
  if (!decksCols.some(c => c.name === 'category')) {
    await run(`ALTER TABLE decks ADD COLUMN category TEXT DEFAULT 'Competitive'`);
  }
  if (!decksCols.some(c => c.name === 'accent_color')) {
    await run(`ALTER TABLE decks ADD COLUMN accent_color TEXT DEFAULT '#eab308'`);
  }
  if (!decksCols.some(c => c.name === 'target_size')) {
    await run(`ALTER TABLE decks ADD COLUMN target_size INTEGER DEFAULT 60`);
  }

  // Lock flags: a locked compartment/location is skipped by auto-filing
  // (recommendSlot) so it never receives new cards; existing cards stay put and
  // manual moves still work.
  const compartmentsCols = await all(`PRAGMA table_info(compartments)`);
  if (!compartmentsCols.some(c => c.name === 'locked')) {
    await run(`ALTER TABLE compartments ADD COLUMN locked INTEGER NOT NULL DEFAULT 0`);
  }
  const locationsLockCols = await all(`PRAGMA table_info(locations)`);
  if (!locationsLockCols.some(c => c.name === 'locked')) {
    await run(`ALTER TABLE locations ADD COLUMN locked INTEGER NOT NULL DEFAULT 0`);
  }

  // --- PERFORMANCE INDEXES ---
  await run(`CREATE INDEX IF NOT EXISTS idx_collection_comp_user_qty ON collection(compartment_id, user_id, quantity)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_collection_loc_pos ON collection(location_id, position)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_card_cache_set_num ON card_cache(set_id, number)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_card_cache_oracle ON card_cache(oracle_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_deck_cards_checkout ON deck_cards(deck_id, checked_out)`);
  // Reservation scans every requirement for one exact variant across all of a
  // user's decks, ordered by deck_cards.id. Without this index that is a full
  // table scan per requirement rendered, i.e. quadratic in deck size.
  await run(`CREATE INDEX IF NOT EXISTS idx_deck_cards_variant ON deck_cards(desired_card_id, desired_finish, id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_collection_variant ON collection(user_id, card_id, finish, list_type)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_deck_allocations_entry ON deck_card_allocations(collection_entry_id)`);

  await run(`CREATE INDEX IF NOT EXISTS idx_collection_tags_tag_id ON collection_tags(tag_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user_date ON audit_logs(user_id, created_at DESC)`);

  // --- SEED DATA & MIGRATION TO DEFAULT ADMIN ---
  const userCount = await get(`SELECT COUNT(*) as count FROM users`);
  let adminId = null;
  if (userCount.count === 0) {
    const generatedPassword = process.env.DEFAULT_ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    const defaultPassHash = hashPassword(generatedPassword);
    const defaultShareToken = crypto.randomBytes(16).toString('hex');
    const result = await run(`
      INSERT INTO users (username, password_hash, role, share_token, share_enabled)
      VALUES (?, ?, ?, ?, ?)
    `, ['admin', defaultPassHash, 'admin', defaultShareToken, 0]);
    adminId = result.lastID;
    console.log('=========================================');
    console.log(`Created default admin user. ID: ${adminId}`);
    console.log(`  username: admin`);
    console.log(`  password: ${generatedPassword}`);
    console.log('Log in and change this password immediately via Settings.');
    console.log('=========================================');
  } else {
    const adminUser = await get(`SELECT id FROM users WHERE username = ?`, ['admin']);
    if (adminUser) {
      adminId = adminUser.id;
    }
  }

  if (adminId) {
    await run(`UPDATE collection SET user_id = ? WHERE user_id IS NULL`, [adminId]);
    await run(`UPDATE locations SET user_id = ? WHERE user_id IS NULL`, [adminId]);
  }

  const locCount = await get(`SELECT COUNT(*) as count FROM locations`);
  if (locCount.count === 0 && adminId) {
    console.log('Populating default locations for admin user...');
    const binder = await run(`INSERT INTO locations (name, type, user_id) VALUES (?, ?, ?)`, [
      'Main Binder', 'Binder', adminId
    ]);
    await createCompartments(binder.lastID, 10, 9);

    const box = await run(`INSERT INTO locations (name, type, user_id) VALUES (?, ?, ?)`, [
      'Bulk Storage Box 1', 'Box', adminId
    ]);
    await createCompartments(box.lastID, 2, 100);
  }
}

async function createCompartments(locationId, count, capacity) {
  for (let i = 1; i <= count; i++) {
    await run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [locationId, i, capacity]);
  }
}

const exportedDatabase = {
  dbPath,
  run,
  get,
  all,
  close,
  withTransaction,
  initDb,
  createCompartments,
  hashPassword,
  DB_FILENAME,
  DEFAULT_TRANSACTION_TIMEOUT_MS,
  MAX_TRANSACTION_TIMEOUT_MS
};

if (process.env.BINDARR_DB_TEST_HOOKS === '1') {
  exportedDatabase.testHooks = {
    failNextClose(message) {
      nextCloseFailure = new Error(message);
    },
    failNextControlStatement(statement, message) {
      const normalizedStatement = String(statement).trim().toUpperCase();
      if (normalizedStatement !== 'COMMIT' && normalizedStatement !== 'ROLLBACK') {
        throw new TypeError('Test hooks can only fail COMMIT or ROLLBACK');
      }
      nextControlStatementFailure = {
        statement: normalizedStatement,
        error: new Error(message)
      };
    },
    getRawOperationTouchCount() {
      return rawOperationTouchCount;
    },
    resetRawOperationTouchCount() {
      rawOperationTouchCount = 0;
    },
    // Make the next collection rebuild produce a short copy, so the migration's
    // row/quantity verification and its rollback can be observed for real.
    corruptNextCollectionMigrationCopy() {
      corruptNextCollectionCopy = true;
    }
  };
}

module.exports = exportedDatabase;
