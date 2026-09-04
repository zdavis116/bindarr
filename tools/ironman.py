#!/usr/bin/env python3
"""END TO END ON HIS I AM IRON MAN DECK.

He says it shows UPDATED. So this is the real case, not a forced one:
  1. does /decks/:id now report moxfield_changed for it?
  2. does a sync from the deck view actually clear the flag?

Not forcing anything -- if the deck really has drifted, syncing it is what he
was going to do anyway, and the plan is shown here before it is applied.
"""
import json, sqlite3, urllib.request

DB = "file:/var/lib/bindarr-dev/bindarr.db?mode=ro"
c = sqlite3.connect(DB, uri=True)
tok = c.execute("SELECT token FROM sessions ORDER BY rowid DESC LIMIT 1").fetchone()[0]
row = c.execute("""SELECT id, name, moxfield_public_id, moxfield_updated_at,
                          moxfield_synced_at
                     FROM decks WHERE name LIKE '%Iron Man%'""").fetchone()
c.close()
print(f"deck {row[0]}: {row[1]}")
print(f"   updated={row[3]}")
print(f"   synced ={row[4]}")


def call(path, method='GET', body=None):
    req = urllib.request.Request(
        "http://localhost:3002/api" + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json'},
        method=method)
    return json.loads(urllib.request.urlopen(req, timeout=180).read())


print("\n=== does the deck view now know it drifted? ===")
d = call(f'/decks/{row[0]}')
print(f"   moxfield_changed = {d.get('moxfield_changed')}  "
      f"(banner shows: {bool(d.get('moxfield_changed'))})")

print("\n=== what would a sync actually change? ===")
plan = call(f"/moxfield/decks/{row[2]}/plan")
print(f"   add {len(plan.get('add', []))}, remove {len(plan.get('remove', []))}, "
      f"move {len(plan.get('moveBoard', []))}, requantify {len(plan.get('requantify', []))}, "
      f"unchanged {len(plan.get('unchanged', []))}")
for x in plan.get('add', [])[:5]:
    print(f"      + {x.get('name')}")
for x in plan.get('remove', [])[:5]:
    print(f"      - {x.get('name')}")

print("\n=== syncing from the deck view ===")
res = call(f"/moxfield/decks/{row[2]}/sync", 'POST', {})
print("   " + json.dumps({k: v for k, v in res.items() if k != 'skipped'})[:180])

print("\n=== flag cleared? ===")
d2 = call(f'/decks/{row[0]}')
print(f"   moxfield_changed = {d2.get('moxfield_changed')}  (must be 0)")
c = sqlite3.connect(DB, uri=True)
r2 = c.execute("""SELECT moxfield_updated_at, moxfield_synced_at FROM decks
                   WHERE id = ?""", (row[0],)).fetchone()
c.close()
print(f"   updated={r2[0]}")
print(f"   synced ={r2[1]}")
