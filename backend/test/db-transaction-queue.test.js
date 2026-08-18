const assert = require('assert');
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-db-queue-${process.pid}.db`);
process.env.BINDARR_DB_TEST_HOOKS = '1';
const db = require('../src/db');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const withTimeout = (promise, label, ms = 1500) => Promise.race([
  promise,
  delay(ms).then(() => { throw new Error(`${label} timed out`); })
]);

async function reset() {
  await db.run('DROP TABLE IF EXISTS tx_queue_test');
  await db.run('CREATE TABLE tx_queue_test (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL)');
}

async function testRawConnectionIsEncapsulatedBehindNarrowTestHooks() {
  const rawConnectionKey = ['db', 'Connection'].join('');
  assert.strictEqual(Object.hasOwn(db, rawConnectionKey), false);
  assert.deepStrictEqual(
    Object.keys(db.testHooks).sort(),
    [
      'failNextClose',
      'failNextControlStatement',
      'getRawOperationTouchCount',
      'resetRawOperationTouchCount',
      // Added for the PR 6E migration suite: forces the collection rebuild's
      // copy to come out short so the row/quantity verification and its
      // rollback can be observed rather than assumed. Listed explicitly, like
      // every other hook, so widening this surface stays a deliberate act.
      'corruptNextCollectionMigrationCopy'
    ].sort()
  );
}

async function testProductionExportsHaveNoRawBypassOrTestMutators() {
  const childDbPath = path.join(os.tmpdir(), `bindarr-db-public-api-${process.pid}.db`);
  const script = `
    const db = require('./src/db');
    const rawConnectionKey = ['db', 'Connection'].join('');
    const result = {
      rawConnectionExposed: Object.hasOwn(db, rawConnectionKey),
      testHooksExposed: Object.hasOwn(db, 'testHooks'),
      rawMethodsExposed: ['rawRun', 'rawGet', 'rawAll'].some(key => Object.hasOwn(db, key))
    };
    db.close().then(() => process.stdout.write('PUBLIC_API:' + JSON.stringify(result)));
  `;
  const env = { ...process.env, DB_PATH: childDbPath };
  delete env.BINDARR_DB_TEST_HOOKS;
  const output = execFileSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env,
    encoding: 'utf8'
  });
  const marker = 'PUBLIC_API:';
  const result = JSON.parse(output.slice(output.lastIndexOf(marker) + marker.length));
  assert.deepStrictEqual(result, {
    rawConnectionExposed: false,
    testHooksExposed: false,
    rawMethodsExposed: false
  });
}

async function testTopLevelWorkCannotInterleave() {
  await reset();
  const transactionStarted = deferred();
  const releaseTransaction = deferred();

  const transaction = db.withTransaction(async tx => {
    await tx.run('INSERT INTO tx_queue_test (value) VALUES (?)', ['tx-first']);
    transactionStarted.resolve();
    await releaseTransaction.promise;
    await tx.run('INSERT INTO tx_queue_test (value) VALUES (?)', ['tx-second']);
  });

  await transactionStarted.promise;
  const ordinary = db.run('INSERT INTO tx_queue_test (value) VALUES (?)', ['ordinary']);
  const secondTransaction = db.withTransaction(tx =>
    tx.run('INSERT INTO tx_queue_test (value) VALUES (?)', ['second-transaction'])
  );
  releaseTransaction.resolve();
  await withTimeout(
    Promise.all([transaction, ordinary, secondTransaction]),
    'serialized top-level work'
  );

  const rows = await db.all('SELECT value FROM tx_queue_test ORDER BY id');
  assert.deepStrictEqual(
    rows.map(row => row.value),
    ['tx-first', 'tx-second', 'ordinary', 'second-transaction']
  );
}

async function testRollbackIsAtomic() {
  await reset();
  await assert.rejects(
    db.withTransaction(async tx => {
      await tx.run('INSERT INTO tx_queue_test (value) VALUES (?)', ['rolled-back']);
      throw new Error('force rollback');
    }),
    /force rollback/
  );
  assert.strictEqual((await db.get('SELECT COUNT(*) AS count FROM tx_queue_test')).count, 0);
}

async function testRollbackExpiresEveryContinuationCreatedInTransactionContext() {
  await reset();
  const releaseContinuation = deferred();
  let continuation;

  await assert.rejects(
    db.withTransaction(async tx => {
      await tx.run('INSERT INTO tx_queue_test (value) VALUES (?)', ['rolled-back']);
      continuation = releaseContinuation.promise.then(async () => {
        const operations = [
          () => tx.run('INSERT INTO tx_queue_test (value) VALUES (?)', ['stale-tx-run']),
          () => db.run('INSERT INTO tx_queue_test (value) VALUES (?)', ['stale-db-run']),
          () => tx.get('SELECT 1'),
          () => db.all('SELECT 1'),
          () => tx.withTransaction(null),
          () => tx.withTransaction(nested => nested.run(
            'INSERT INTO tx_queue_test (value) VALUES (?)',
            ['stale-nested']
          ))
        ];
        for (const operation of operations) {
          await assert.rejects(operation(), error => error.code === 'STALE_TRANSACTION');
        }
      });
      throw new Error('force rollback with delayed continuation');
    }),
    /force rollback with delayed continuation/
  );

  releaseContinuation.resolve();
  await withTimeout(continuation, 'rollback continuation');
  assert.strictEqual((await db.get('SELECT COUNT(*) AS count FROM tx_queue_test')).count, 0);
}

async function testNestedTransactionsReuseOwner() {
  await reset();
  await withTimeout(db.withTransaction(async tx => {
    await tx.run('INSERT INTO tx_queue_test (value) VALUES (?)', ['outer']);
    const nestedResult = await tx.withTransaction(async nested => {
      await nested.run('INSERT INTO tx_queue_test (value) VALUES (?)', ['nested']);
      return 'nested-result';
    });
    assert.strictEqual(nestedResult, 'nested-result');
  }), 'nested transaction');
  const rows = await db.all('SELECT value FROM tx_queue_test ORDER BY id');
  assert.deepStrictEqual(rows.map(row => row.value), ['outer', 'nested']);
}

async function testDetachedNestedTransactionIsOwnedUntilItSettles() {
  await reset();
  const nestedStarted = deferred();
  const releaseNested = deferred();

  const transaction = db.withTransaction(tx => {
    tx.withTransaction(async nested => {
      nestedStarted.resolve();
      await releaseNested.promise;
      await nested.run('INSERT INTO tx_queue_test (value) VALUES (?)', ['nested-detached']);
      throw new Error('detached nested failure');
    });
    return 'outer-result';
  });

  await nestedStarted.promise;
  let settled = false;
  transaction.finally(() => { settled = true; }).catch(() => {});
  await delay(25);
  assert.strictEqual(settled, false, 'owner must wait for a detached nested transaction');
  releaseNested.resolve();
  await assert.rejects(withTimeout(transaction, 'detached nested transaction'), /detached nested failure/);
  assert.strictEqual((await db.get('SELECT COUNT(*) AS count FROM tx_queue_test')).count, 0);
}

async function testCommitExpiresEveryContinuationCreatedInTransactionContext() {
  await reset();
  const releaseContinuation = deferred();
  let continuation;

  await db.withTransaction(async tx => {
    await tx.run('INSERT INTO tx_queue_test (value) VALUES (?)', ['committed']);
    continuation = releaseContinuation.promise.then(async () => {
      const operations = [
        () => tx.run('INSERT INTO tx_queue_test (value) VALUES (?)', ['stale-tx-run']),
        () => db.run('INSERT INTO tx_queue_test (value) VALUES (?)', ['stale-db-run']),
        () => tx.get('SELECT 1'),
        () => db.all('SELECT 1'),
        () => tx.withTransaction(nested => nested.run(
          'INSERT INTO tx_queue_test (value) VALUES (?)',
          ['stale-nested']
        ))
      ];
      for (const operation of operations) {
        await assert.rejects(operation(), error => error.code === 'STALE_TRANSACTION');
      }
    });
  });

  releaseContinuation.resolve();
  await withTimeout(continuation, 'commit continuation');
  const rows = await db.all('SELECT value FROM tx_queue_test ORDER BY id');
  assert.deepStrictEqual(rows.map(row => row.value), ['committed']);
}

function failNextControlStatement(statement, message) {
  db.testHooks.failNextControlStatement(statement, message);
}

async function testCommitFailureExpiresTransactionContextAndQueueRecovers() {
  await reset();
  const releaseContinuation = deferred();
  let continuation;
  failNextControlStatement('COMMIT', 'injected commit failure');

  await assert.rejects(
    db.withTransaction(async tx => {
      await tx.run('INSERT INTO tx_queue_test (value) VALUES (?)', ['not-committed']);
      continuation = releaseContinuation.promise.then(() => db.run(
        'INSERT INTO tx_queue_test (value) VALUES (?)',
        ['stale-after-commit-failure']
      ));
    }),
    /injected commit failure/
  );
  releaseContinuation.resolve();
  await assert.rejects(continuation, error => error.code === 'STALE_TRANSACTION');

  await db.run('INSERT INTO tx_queue_test (value) VALUES (?)', ['after-commit-failure']);
  const rows = await db.all('SELECT value FROM tx_queue_test ORDER BY id');
  assert.deepStrictEqual(rows.map(row => row.value), ['after-commit-failure']);
}

async function testRejectedQueueOperationDoesNotPoisonLaterWork() {
  await reset();
  await assert.rejects(db.run('INSERT INTO missing_table (value) VALUES (?)', ['bad']));
  await db.run('INSERT INTO tx_queue_test (value) VALUES (?)', ['queue-still-usable']);
  assert.strictEqual((await db.get('SELECT COUNT(*) AS count FROM tx_queue_test')).count, 1);
}

async function testTransactionTimeoutExpiresOwnerContinuationAndQueueRecovers() {
  await reset();
  const callbackStarted = deferred();
  const releaseCallback = deferred();
  let ownerContinuation;

  const transaction = db.withTransaction(async tx => {
    await tx.run('INSERT INTO tx_queue_test (value) VALUES (?)', ['rolled-back-timeout']);
    callbackStarted.resolve();
    ownerContinuation = releaseCallback.promise.then(async () => {
      const operations = [
        () => tx.run('INSERT INTO tx_queue_test (value) VALUES (?)', ['stale-tx-run']),
        () => db.run('INSERT INTO tx_queue_test (value) VALUES (?)', ['stale-db-run']),
        () => tx.get('SELECT 1'),
        () => db.all('SELECT 1'),
        () => tx.withTransaction(nested => nested.run(
          'INSERT INTO tx_queue_test (value) VALUES (?)',
          ['stale-nested']
        ))
      ];
      for (const operation of operations) {
        await assert.rejects(operation(), error => error.code === 'STALE_TRANSACTION');
      }
    });
    await ownerContinuation;
  }, { timeoutMs: 50 });

  await callbackStarted.promise;
  await assert.rejects(
    withTimeout(transaction, 'transaction timeout'),
    error => error.code === 'TRANSACTION_TIMEOUT'
  );
  releaseCallback.resolve();
  await withTimeout(ownerContinuation, 'owner continuation after timeout');

  await db.run('INSERT INTO tx_queue_test (value) VALUES (?)', ['outside-after-timeout']);
  const rows = await db.all('SELECT value FROM tx_queue_test ORDER BY id');
  assert.deepStrictEqual(rows.map(row => row.value), ['outside-after-timeout']);
}

async function testLegacyThreeArgumentTransactionFormHonorsTimeout() {
  await reset();
  const callbackStarted = deferred();
  const releaseCallback = deferred();
  let callbackContinuation;

  const transaction = db.withTransaction(db, async tx => {
    await tx.run('INSERT INTO tx_queue_test (value) VALUES (?)', ['legacy-rolled-back']);
    callbackStarted.resolve();
    callbackContinuation = releaseCallback.promise;
    await callbackContinuation;
  }, { timeoutMs: 20 });

  await callbackStarted.promise;
  await assert.rejects(transaction, error => error.code === 'TRANSACTION_TIMEOUT');
  releaseCallback.resolve();
  await callbackContinuation;
  assert.strictEqual((await db.get('SELECT COUNT(*) AS count FROM tx_queue_test')).count, 0);
}

async function testTransactionTimeoutContractAndValidation() {
  assert.strictEqual(db.DEFAULT_TRANSACTION_TIMEOUT_MS, 30_000);
  for (const timeoutMs of [0, -1, 1.5, Infinity, NaN, '50']) {
    await assert.rejects(
      db.withTransaction(() => Promise.resolve(), { timeoutMs }),
      error => error instanceof TypeError && /positive finite integer/.test(error.message)
    );
  }
}

async function testTransactionTimeoutHonorsNodeTimerMaximum() {
  assert.strictEqual(db.MAX_TRANSACTION_TIMEOUT_MS, 2_147_483_647);
  assert.strictEqual(
    await db.withTransaction(() => 'maximum accepted', {
      timeoutMs: db.MAX_TRANSACTION_TIMEOUT_MS
    }),
    'maximum accepted'
  );

  db.testHooks.resetRawOperationTouchCount();
  await assert.rejects(
    db.withTransaction(() => Promise.resolve(), {
      timeoutMs: db.MAX_TRANSACTION_TIMEOUT_MS + 1
    }),
    error => error instanceof RangeError && /must not exceed 2147483647/.test(error.message)
  );
  assert.strictEqual(
    db.testHooks.getRawOperationTouchCount(),
    0,
    'an invalid timeout must reject before transaction or queue work'
  );
}

async function testRollbackFailureExpiresContextAndPoisonsDatabase() {
  await reset();
  const releaseContinuation = deferred();
  let continuation;
  failNextControlStatement('ROLLBACK', 'injected rollback failure');
  const error = await db.withTransaction(async tx => {
    await tx.run('INSERT INTO tx_queue_test (value) VALUES (?)', ['unknown-state']);
    continuation = releaseContinuation.promise.then(async () => {
      for (const operation of [
        () => db.run('SELECT 1'),
        () => db.get('SELECT 1'),
        () => db.all('SELECT 1'),
        () => db.withTransaction(() => Promise.resolve())
      ]) {
        await assert.rejects(operation(), reason => reason.code === 'STALE_TRANSACTION');
      }
    });
    throw new Error('primary callback failure');
  }).then(() => null, reason => reason);

  assert(error instanceof AggregateError, 'rollback failure must preserve both errors');
  assert(error.errors.some(reason => /primary callback failure/.test(reason.message)));
  assert(error.errors.some(reason => /injected rollback failure/.test(reason.message)));
  releaseContinuation.resolve();
  await withTimeout(continuation, 'rollback failure continuation');

  db.testHooks.resetRawOperationTouchCount();
  for (const operation of [
    () => db.run('SELECT 1'),
    () => db.get('SELECT 1'),
    () => db.all('SELECT 1'),
    () => db.withTransaction(() => Promise.resolve())
  ]) {
    await assert.rejects(operation(), error => error.code === 'DB_STATE_UNKNOWN');
  }
  assert.strictEqual(
    db.testHooks.getRawOperationTouchCount(),
    0,
    'poisoned exports must reject before touching SQLite'
  );

  const closing = db.close();
  assert(closing instanceof Promise, 'close must return a Promise');
  await closing;
}

async function testCloseLifecycleRejectsLateWorkAndWaitsForAcceptedOwners() {
  const childDbPath = path.join(os.tmpdir(), `bindarr-db-close-lifecycle-${process.pid}.db`);
  const script = `
    const assert = require('assert');
    process.env.BINDARR_DB_TEST_HOOKS = '1';
    const db = require('./src/db');
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const deferred = () => {
      let resolve;
      const promise = new Promise(r => { resolve = r; });
      return { promise, resolve };
    };
    async function main() {
      await db.run('CREATE TABLE close_test (value TEXT NOT NULL)');
      await db.withTransaction(async tx => {
        await assert.rejects(db.close(), error => error.code === 'DB_CLOSE_IN_TRANSACTION');
        await tx.run('INSERT INTO close_test (value) VALUES (?)', ['after-inner-close']);
      });

      const started = deferred();
      const release = deferred();
      const transaction = db.withTransaction(async tx => {
        await tx.run('INSERT INTO close_test (value) VALUES (?)', ['owner-start']);
        started.resolve();
        await release.promise;
        await tx.withTransaction(async nested => {
          await nested.run('INSERT INTO close_test (value) VALUES (?)', ['owner-nested-finish']);
        });
        await tx.run('INSERT INTO close_test (value) VALUES (?)', ['owner-finish']);
      });
      await started.promise;
      const acceptedBeforeClose = db.run(
        'INSERT INTO close_test (value) VALUES (?)',
        ['queued-before-close']
      );
      db.testHooks.resetRawOperationTouchCount();
      const rawBeforeLateWork = db.testHooks.getRawOperationTouchCount();
      const firstClose = db.close();
      const concurrentClose = db.close();
      assert.strictEqual(concurrentClose, firstClose, 'concurrent closes share one result');

      for (const operation of [
        () => db.run('SELECT 1'),
        () => db.get('SELECT 1'),
        () => db.all('SELECT 1'),
        () => db.withTransaction(() => Promise.resolve())
      ]) {
        await assert.rejects(operation(), error => error.code === 'DB_CLOSING');
      }
      assert.strictEqual(
        db.testHooks.getRawOperationTouchCount(),
        rawBeforeLateWork,
        'late work rejects before touching raw SQLite'
      );

      let closeSettled = false;
      firstClose.then(() => { closeSettled = true; });
      await delay(20);
      assert.strictEqual(closeSettled, false, 'close waits for accepted transaction work');
      release.resolve();
      await transaction;
      await acceptedBeforeClose;
      await firstClose;
      assert.strictEqual(closeSettled, true);
      assert.strictEqual(db.close(), firstClose, 'close after closed reuses the result');
      await db.close();

      const rawAfterClose = db.testHooks.getRawOperationTouchCount();
      for (const operation of [
        () => db.run('SELECT 1'),
        () => db.get('SELECT 1'),
        () => db.all('SELECT 1'),
        () => db.withTransaction(() => Promise.resolve())
      ]) {
        await assert.rejects(operation(), error => error.code === 'DB_CLOSED');
      }
      assert.strictEqual(db.testHooks.getRawOperationTouchCount(), rawAfterClose);
    }
    main().then(() => process.exit(0)).catch(error => {
      console.error(error);
      process.exit(1);
    });
  `;
  execFileSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DB_PATH: childDbPath, BINDARR_DB_TEST_HOOKS: '1' },
    encoding: 'utf8',
    timeout: 5000,
    stdio: 'pipe'
  });
}

async function testFailedRawCloseKeepsDeterministicClosingState() {
  const childDbPath = path.join(os.tmpdir(), `bindarr-db-close-failure-${process.pid}.db`);
  const script = `
    const assert = require('assert');
    process.env.BINDARR_DB_TEST_HOOKS = '1';
    const db = require('./src/db');
    async function main() {
      await db.run('CREATE TABLE close_failure_test (value TEXT)');
      db.testHooks.failNextClose('injected raw close failure');
      db.testHooks.resetRawOperationTouchCount();
      const firstClose = db.close();
      const concurrentClose = db.close();
      assert.strictEqual(concurrentClose, firstClose);
      const firstError = await firstClose.then(() => null, error => error);
      const concurrentError = await concurrentClose.then(() => null, error => error);
      assert.match(firstError.message, /injected raw close failure/);
      assert.strictEqual(concurrentError, firstError);
      assert.strictEqual(db.close(), firstClose, 'failed close result remains idempotent');
      const rawAfterFailure = db.testHooks.getRawOperationTouchCount();
      for (const operation of [
        () => db.run('SELECT 1'),
        () => db.get('SELECT 1'),
        () => db.all('SELECT 1'),
        () => db.withTransaction(() => Promise.resolve())
      ]) {
        await assert.rejects(operation(), error => error.code === 'DB_CLOSING');
      }
      assert.strictEqual(db.testHooks.getRawOperationTouchCount(), rawAfterFailure);
    }
    main().then(() => process.exit(0)).catch(error => {
      console.error(error);
      process.exit(1);
    });
  `;
  execFileSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DB_PATH: childDbPath, BINDARR_DB_TEST_HOOKS: '1' },
    encoding: 'utf8',
    timeout: 5000,
    stdio: 'pipe'
  });
}

async function main() {
  await testRawConnectionIsEncapsulatedBehindNarrowTestHooks();
  await testProductionExportsHaveNoRawBypassOrTestMutators();
  await testTopLevelWorkCannotInterleave();
  await testRollbackIsAtomic();
  await testRollbackExpiresEveryContinuationCreatedInTransactionContext();
  await testNestedTransactionsReuseOwner();
  await testDetachedNestedTransactionIsOwnedUntilItSettles();
  await testCommitExpiresEveryContinuationCreatedInTransactionContext();
  await testCommitFailureExpiresTransactionContextAndQueueRecovers();
  await testRejectedQueueOperationDoesNotPoisonLaterWork();
  await testTransactionTimeoutExpiresOwnerContinuationAndQueueRecovers();
  await testLegacyThreeArgumentTransactionFormHonorsTimeout();
  await testTransactionTimeoutContractAndValidation();
  await testTransactionTimeoutHonorsNodeTimerMaximum();
  await testCloseLifecycleRejectsLateWorkAndWaitsForAcceptedOwners();
  await testFailedRawCloseKeepsDeterministicClosingState();
  await testRollbackFailureExpiresContextAndPoisonsDatabase();
  console.log('db-transaction-queue.test.js: all assertions passed');
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error);
  process.exit(1);
});
