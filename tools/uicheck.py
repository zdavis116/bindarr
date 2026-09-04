#!/usr/bin/env python3
"""Exercise every endpoint the panel calls, in the order it calls them.

The UI cannot be clicked from here, so the next best evidence is that each call
the component makes returns what the component expects. A field the panel reads
but the API never sends renders as blank or undefined -- and both build and lint
pass either way.
"""
import json, re, sqlite3, urllib.request, urllib.error, os

DB = "file:/var/lib/bindarr-dev/bindarr.db?mode=ro"
API = "http://localhost:3002/api"
c = sqlite3.connect(DB, uri=True)
tok = c.execute("SELECT token FROM sessions ORDER BY rowid DESC LIMIT 1").fetchone()[0]
c.close()


def call(path, body=None, method='GET'):
    req = urllib.request.Request(
        API + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json'},
        method=method)
    try:
        return json.loads(urllib.request.urlopen(req, timeout=180).read())
    except urllib.error.HTTPError as e:
        return {'_status': e.code, **json.loads(e.read() or b'{}')}


print("=== 1. GET /moxfield/account  (panel mount) ===")
a = call('/moxfield/account')
print("   " + json.dumps(a)[:140])

print("\n=== 2. GET /moxfield/decks  (the list it renders) ===")
d = call('/moxfield/decks')
need = ['public_id', 'name', 'bindarr_deck_id', 'changed', 'last_synced_at']
for deck in d.get('decks', []):
    missing = [k for k in need if k not in deck]
    print(f"   {deck['name'][:24]:24} linked={deck['bindarr_deck_id']} "
          f"changed={deck['changed']}  missing fields: {missing or 'none'}")

print("\n=== 3. GET /plan  (fields the preview reads) ===")
target = next((x for x in d.get('decks', []) if x['bindarr_deck_id']), None)
if target:
    p = call(f"/moxfield/decks/{target['public_id']}/plan")
    for k in ['add', 'remove', 'moveBoard', 'requantify', 'unchanged', 'skipped', 'changes']:
        v = p.get(k)
        print(f"   {k:12} {'MISSING' if v is None else (len(v) if isinstance(v, list) else v)}")

print("\n=== 4. GET /api/decks  (badge fields on the deck list) ===")
decks = call('/decks')
rows = decks if isinstance(decks, list) else decks.get('decks', [])
for r in rows:
    has = 'moxfield_public_id' in r
    print(f"   {str(r.get('name'))[:24]:24} moxfield_public_id "
          f"{'present' if has else 'MISSING'} = {r.get('moxfield_public_id')}")

print("\n=== 5. every field the panel reads, against what the API sends ===")
src = open('/opt/bindarr-dev/frontend/src/components/MoxfieldPanel.jsx').read()
reads = set(re.findall(r'\bdeck\.(\w+)', src)) | set(re.findall(r'\bbody\.(\w+)', src))
sample = (d.get('decks') or [{}])[0]
for f in sorted(reads):
    if f in ('map',):
        continue
    known = f in sample or f in ('account', 'decks', 'error', 'added', 'removed',
                                 'moved', 'printing_preferred')
    print(f"   {'ok ' if known else '??'}  {f}")
