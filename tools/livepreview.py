#!/usr/bin/env python3
"""Exercise the importer against the REAL catalogue, end to end.

Ten tests passing proves the shape. It does not prove a ManaBox row resolves to
the right card. Building a CSV from cards actually in the catalogue plus rows
that must be rejected, then calling preview and checking the numbers.

PREVIEW ONLY -- nothing is written. Zach's collection is not a test fixture.
"""
import json, sqlite3, urllib.request, urllib.error

DB = "file:/var/lib/bindarr-dev/bindarr.db?mode=ro"
c = sqlite3.connect(DB, uri=True)
tok = c.execute("SELECT token FROM sessions ORDER BY rowid DESC LIMIT 1").fetchone()[0]

real = c.execute("""SELECT id, name, set_id, number FROM card_cache
                     WHERE supertype='MTG' AND number GLOB '[0-9]*'
                     LIMIT 3""").fetchall()

# A collector number shared by two printings in the same set, if one exists --
# that is the ambiguity the resolver must refuse rather than guess at.
dupe = c.execute("""SELECT set_id, number, COUNT(*) n FROM card_cache
                     GROUP BY set_id, number HAVING n > 1 LIMIT 1""").fetchone()
before = c.execute("SELECT COUNT(*) FROM collection").fetchone()[0]
c.close()

rows = []
# 1-3: exact Scryfall id matches
for cid, name, sid, num in real:
    rows.append({'Scryfall ID': cid, 'Name': name, 'Set code': sid,
                 'Card number': num, 'Quantity': '1', 'Foil': 'normal',
                 'Condition': 'near_mint'})
# 4: set+number only, no Scryfall id
rows.append({'Name': real[0][1], 'Set code': real[0][2].upper(),
             'Card number': real[0][3], 'Quantity': '2', 'Foil': 'foil',
             'Condition': 'lightly_played'})
# 5: a card that does not exist
rows.append({'Name': 'Definitely Not A Real Card', 'Set code': 'zzz',
             'Card number': '999', 'Quantity': '1'})
# 6: a bad quantity
rows.append({'Scryfall ID': real[1][0], 'Name': real[1][1], 'Quantity': '0'})
# 7: name only -- ambiguous, must be refused
rows.append({'Name': real[2][1], 'Quantity': '1'})
# 8: ambiguous set+number, if the catalogue has one
if dupe:
    rows.append({'Name': '?', 'Set code': dupe[0], 'Card number': dupe[1],
                 'Quantity': '1'})

req = urllib.request.Request(
    'http://localhost:3002/api/import/preview',
    data=json.dumps({'rows': rows, 'format': 'manabox'}).encode(),
    headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json'},
    method='POST')
try:
    res = json.loads(urllib.request.urlopen(req, timeout=60).read())
except urllib.error.HTTPError as e:
    print(f"HTTP {e.code}: {e.read().decode()[:300]}")
    raise SystemExit(1)

print(f"sent {len(rows)} rows\n")
print(f"  matched   {res['matched']}")
print(f"  rejected  {res['rejected']}")
print(f"  copies    {res['copies']}")
print(f"  matchedBy {res.get('matchedBy')}")
print("\nREJECTIONS:")
for r in res['rejections']:
    print(f"   row {r['row']}  {r['reason']:20} {r['card'][:38]}  {r['detail'] or ''}")

after = sqlite3.connect(DB, uri=True).execute("SELECT COUNT(*) FROM collection").fetchone()[0]
print(f"\ncollection rows: {before} -> {after}   preview wrote nothing: {before == after}")
