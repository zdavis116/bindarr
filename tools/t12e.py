p = 'backend/test/e2e/scan_staging.test.js'
s = open(p).read()

old_start = s.index("    // The handler runs inside db.withTransaction and the collection INSERT goes")
old_end = s.index("    assert.strictEqual(commit.status, 200, `commit failed: ${JSON.stringify(commit.body)}`);")

new = """    // THE RACING ROW MUST LAND BETWEEN THE READ AND THE DELETE, and both live
    // inside the same transaction callback. Two earlier attempts missed the
    // window and PASSED AGAINST THE BUG, which is worse than no test:
    //
    //   1. insert-then-commit -- the handler simply read the extra row too,
    //      reported it as committed, and the assertion was skipped by its guard.
    //   2. patching db.run -- the collection INSERT goes through the
    //      transaction's own `tx.run`, so the hook never fired at all.
    //   3. wrapping withTransaction around the callback -- that runs AFTER the
    //      delete, not between.
    //
    // db.all is what the handler uses to READ the rows to commit. Hooking it
    // puts the insert immediately after the read and before anything else in
    // the handler, which is exactly the window S2 describes.
    let lateId = null;
    let fired = false;
    const realAll = db.all.bind(db);
    db.all = async function patched(sql, params) {
      const rows = await realAll(sql, params);
      if (!fired && /FROM scan_staging/i.test(String(sql))) {
        fired = true;
        const late = await realAll.constructor === Function
          ? await db.run(
              `INSERT INTO scan_staging (user_id, card_id, quantity, finish, condition)
               VALUES (?,?,?,?,?)`,
              [userId, 'card-bolt', 1, 'nonfoil', 'Near Mint'])
          : null;
        lateId = late && late.lastID;
      }
      return rows;
    };

    let commit;
    try {
      commit = await api('/api/scan-stage/commit', { method: 'POST' });
    } finally {
      db.all = realAll;
    }

    assert.ok(fired, 'the read hook must have fired');
    assert.ok(lateId, 'the racing insert must have produced a row');

"""

s = s[:old_start] + new + s[old_end:]

# the later assertion referenced `fired` differently; make sure the stale one is gone
s = s.replace("    assert.ok(lateId, 'the racing insert must have fired');\n", "")

open(p, 'w').write(s)
print('ok')
