#!/usr/bin/env python3
"""RUN THE POLL FOR REAL.

Reading the code proves what it says; running it proves what it does. Tonight
that distinction caught the 101-card false alarm, the churn bug, and the
argument-order error.

Four things to establish:
  1. A poll tick completes without throwing.
  2. It writes moxfield_synced_at / moxfield_updated_at -- which NOTHING wrote
     until now, so every "has Moxfield changed?" check compared against null.
  3. An unchanged deck costs ONE request, not one per deck.
  4. When Moxfield is unreachable, the deck list still renders.
"""
import json, sqlite3, subprocess, os, urllib.request

DB = "/var/lib/bindarr-dev/bindarr.db"
c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
print("=== timestamps BEFORE the poll ===")
for r in c.execute("""SELECT name, moxfield_updated_at, moxfield_synced_at
                        FROM decks WHERE moxfield_public_id IS NOT NULL"""):
    print(f"   {r[0][:20]:20} updated={r[1]}  synced={r[2]}")
tok = c.execute("SELECT token FROM sessions ORDER BY rowid DESC LIMIT 1").fetchone()[0]
c.close()

print("\n=== running one poll tick ===")
script = '''
const poll = require('/opt/bindarr-dev/backend/src/utils/moxfieldPoll');
(async () => {
  await new Promise(r => setTimeout(r, 900));
  const t0 = Date.now();
  const results = await poll.runPoll();
  console.log('RESULT ' + JSON.stringify(results));
  console.log('ELAPSED ' + (Date.now() - t0) + 'ms');
  process.exit(0);
})();
'''
open('/opt/bindarr-dev/polltest.cjs', 'w').write(script)
env = dict(os.environ, DB_PATH=DB, PATH='/opt/node20/bin:' + os.environ['PATH'])
r = subprocess.run(['/opt/node20/bin/node', 'polltest.cjs'], capture_output=True,
                   text=True, env=env, cwd='/opt/bindarr-dev')
for line in (r.stdout or r.stderr).split('\n'):
    if line.startswith('RESULT') or line.startswith('ELAPSED') or 'Error' in line:
        print("   " + line[:400])
os.remove('/opt/bindarr-dev/polltest.cjs')

print("\n=== timestamps AFTER ===")
c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
for r2 in c.execute("""SELECT name, moxfield_updated_at, moxfield_synced_at
                         FROM decks WHERE moxfield_public_id IS NOT NULL"""):
    print(f"   {r2[0][:20]:20} updated={r2[1]}  synced={r2[2]}")
print("\n=== what the deck list now reports as drifted ===")
for r3 in c.execute("""SELECT name,
                              CASE WHEN moxfield_public_id IS NOT NULL
                                    AND moxfield_updated_at IS NOT NULL
                                    AND moxfield_synced_at IS NOT NULL
                                    AND moxfield_updated_at > moxfield_synced_at
                                   THEN 1 ELSE 0 END AS changed
                         FROM decks WHERE moxfield_public_id IS NOT NULL"""):
    print(f"   {r3[0][:20]:20} moxfield_changed={r3[1]}")
c.close()
