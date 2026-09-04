#!/usr/bin/env python3
"""IS THE DECK-VIEW BANNER REACHABLE, AND DOES IT HAVE THE DATA?

Two ways this fails silently, both seen tonight:
  a) the JSX lands outside the component's return, so it never renders
  b) deck.moxfield_changed is never sent by /decks/:id, so the gate is always
     false and the banner is dead code

The LIST endpoint computes moxfield_changed in SQL. The DETAIL endpoint does
`SELECT *` and spreads the row -- which returns the raw COLUMNS but not that
computed flag. If so, the banner can never show.
"""
import json, sqlite3, urllib.request, os, re

DB = "file:/var/lib/bindarr-dev/bindarr.db?mode=ro"
c = sqlite3.connect(DB, uri=True)
tok = c.execute("SELECT token FROM sessions ORDER BY rowid DESC LIMIT 1").fetchone()[0]
did = c.execute("""SELECT id FROM decks WHERE moxfield_public_id IS NOT NULL
                    ORDER BY id LIMIT 1""").fetchone()[0]
c.close()


def call(path):
    req = urllib.request.Request("http://localhost:3002/api" + path,
                                 headers={'Authorization': 'Bearer ' + tok})
    return json.loads(urllib.request.urlopen(req, timeout=120).read())


print("=== what /decks/:id returns for the moxfield fields ===")
d = call(f'/decks/{did}')
for f in ('moxfield_public_id', 'moxfield_changed', 'moxfield_synced_at',
          'moxfield_updated_at'):
    present = f in d
    print(f"   {f:22} {'present' if present else 'MISSING'} = {d.get(f)}")

print("\n=== the LIST endpoint, for comparison ===")
rows = call('/decks')
rows = rows if isinstance(rows, list) else rows.get('decks', [])
one = next((r for r in rows if r.get('id') == did), {})
print(f"   moxfield_changed = {one.get('moxfield_changed')}")

print("\n=== is the banner inside the component return? ===")
os.chdir('/opt/bindarr-dev')
dv = open('frontend/src/components/DeckView.jsx').read()
fn = dv.index('function DeckView(')
ret = dv.index('return (', fn)
ban = dv.find('deck?.moxfield_changed')
tabs = dv.find('{/* TABS')
print(f"   return( at {ret}   banner at {ban}   tabs at {tabs}")
print(f"   banner inside return : {ban > ret}")
print(f"   banner before tabs   : {ban < tabs}")
