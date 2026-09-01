#!/usr/bin/env python3
"""Does the import now find the three Marvel cards?

Before: Skybreaker / Vibranium Dynamo / Fizik never arrived. Two of the three
are in the catalogue under flavor_name; the third is not in Scryfall's bulk
file at all.

Preview only -- nothing is written to Zach's decks.
"""
import json, sqlite3, urllib.request, urllib.error

c = sqlite3.connect("file:/var/lib/bindarr-dev/bindarr.db?mode=ro", uri=True)
tok = c.execute("SELECT token FROM sessions ORDER BY rowid DESC LIMIT 1").fetchone()[0]
deck = c.execute("SELECT id FROM decks WHERE name LIKE 'Tony Stark%' "
                 "ORDER BY id DESC LIMIT 1").fetchone()[0]
c.close()

lines = [
    {"name": "Skybreaker, Sword of Bashenga", "quantity": 1},
    {"name": "Vibranium Dynamo", "quantity": 1},
    {"name": "Fizik, Etherium Mechanic", "quantity": 1},
    {"name": "Master Transmuter", "quantity": 1},
    {"name": "Sol Ring", "quantity": 1},
]

req = urllib.request.Request(
    f"http://localhost:3002/api/decks/{deck}/import",
    data=json.dumps({"lines": lines, "board": "mainboard", "apply": False}).encode(),
    headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"},
    method='POST')
try:
    res = json.loads(urllib.request.urlopen(req, timeout=60).read())
except urllib.error.HTTPError as e:
    res = json.loads(e.read() or 'null')
    print("HTTP error:", e.code)

for l in (res or {}).get('lines', []):
    name = l.get('name')
    st = l.get('status')
    nc = l.get('needs_choice')
    ch = len(l.get('choices') or [])
    verdict = "RESOLVED" if st != 'unresolved' else "NOT FOUND"
    print(f"   {verdict:10} {name:34} status={st:11} choices={ch}")
