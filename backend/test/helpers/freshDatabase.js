const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sqlite3 = require('sqlite3').verbose();

function openDatabase(dbPath) {
  return new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(dbPath, (error) => {
      if (error) reject(error);
      else resolve(connection);
    });
  });
}

function query(connection, method, sql, params = []) {
  return new Promise((resolve, reject) => {
    connection[method](sql, params, function callback(error, result) {
      if (error) reject(error);
      else if (method === 'run') resolve({ lastID: this.lastID, changes: this.changes });
      else resolve(result);
    });
  });
}

async function createFreshDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-fresh-db-'));
  const dbPath = path.join(directory, 'bindarr.db');
  const initialized = spawnSync(process.execPath, [__filename, '--initialize', dbPath], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      DB_PATH: dbPath,
      DEFAULT_ADMIN_PASSWORD: 'fixture-admin-password'
    }
  });

  if (initialized.error || initialized.signal || initialized.status !== 0) {
    fs.rmSync(directory, { recursive: true, force: true });
    const outcome = initialized.error
      ? initialized.error.message
      : initialized.signal
        ? `terminated by ${initialized.signal}`
        : `exited with status ${initialized.status}`;
    throw new Error(
      `Fresh database initialization failed (${outcome}):\n${initialized.stderr || initialized.stdout}`
    );
  }

  let connection;
  try {
    connection = await openDatabase(dbPath);
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  let closed = false;

  return {
    directory,
    dbPath,
    all: (sql, params) => query(connection, 'all', sql, params),
    get: (sql, params) => query(connection, 'get', sql, params),
    run: (sql, params) => query(connection, 'run', sql, params),
    cleanup: async () => {
      let closeError;
      if (!closed) {
        try {
          await new Promise((resolve, reject) => {
            connection.close((error) => error ? reject(error) : resolve());
          });
          closed = true;
        } catch (error) {
          closeError = error;
        }
      }
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } finally {
        if (closeError) throw closeError;
      }
    }
  };
}

async function initialize(dbPath) {
  process.env.DB_PATH = dbPath;
  const db = require('../../src/db');
  try {
    await db.initDb();
  } finally {
    await new Promise((resolve, reject) => {
      db.dbConnection.close((error) => error ? reject(error) : resolve());
    });
  }
}

if (require.main === module) {
  const [, , command, dbPath] = process.argv;
  if (command !== '--initialize' || !dbPath) {
    console.error('Usage: node freshDatabase.js --initialize <database-path>');
    process.exitCode = 1;
  } else {
    initialize(dbPath).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}

module.exports = { createFreshDatabase };
