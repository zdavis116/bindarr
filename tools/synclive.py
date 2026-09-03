#!/usr/bin/env python3
"""Exercise the sync end to end against Zach's real Moxfield decks.

Reading the code proves what it says; running it proves what it does.

Ur-Dragon is the safe test: he has no local deck by that name, so a sync
CREATES one and nothing existing is at risk. Then I check the two rules:

  MOXFIELD owns the card list  -- the deck should come out at 100 cards
  BINDARR  owns the printing   -- adds should prefer printings he owns and has
                                  free, per "use the printing of the card we
                                  have 1 available"
"""
import json, sqlite3, urllib.request, urllib.error

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


print("=== 1. link the account ===")
r = call('/moxfield/account', {'username': 'YoungsterZach'}, 'POST')
print("   " + json.dumps(r)[:150])

print("\n=== 2. his public decks ===")
r = call('/moxfield/decks')
if '_status' in r:
    print("   " + json.dumps(r)[:200]); raise SystemExit
for d in r.get('decks', []):
    print(f"   {d['name'][:22]:22} {d['format']:11} "
          f"linked={d['bindarr_deck_id']}  updated {(d['last_updated_at'] or '')[:19]}")

target = next((d for d in r['decks'] if d['name'] == 'Ur-Dragon'), None)
if not target:
    print("   Ur-Dragon not found"); raise SystemExit

print(f"\n=== 3. PREVIEW the sync for {target['name']} (changes nothing) ===")
p = call(f"/moxfield/decks/{target['public_id']}/plan")
if '_status' in p:
    print("   " + json.dumps(p)[:250]); raise SystemExit
print(f"   add {len(p['add'])}  remove {len(p['remove'])}  "
      f"requantify {len(p['requantify'])}  unchanged {len(p['unchanged'])}")
print(f"   skipped: {len(p['skipped'])}")
for s in p['skipped'][:4]:
    print(f"      {s.get('name')} -> {s.get('reason')}")

before = sqlite3.connect(DB, uri=True)
n_before = before.execute("SELECT COUNT(*) FROM decks").fetchone()[0]
before.close()
print(f"   decks in Bindarr before: {n_before}")

print("\n=== 4. APPLY ===")
a = call(f"/moxfield/decks/{target['public_id']}/sync", {}, 'POST')
print("   " + json.dumps({k: v for k, v in a.items() if k != 'skipped'})[:200])

chk = sqlite3.connect(DB, uri=True)
did = a.get('bindarr_deck_id')
rows = chk.execute("""
    SELECT dc.board, SUM(dc.quantity) FROM deck_cards dc
     WHERE dc.deck_id = ? GROUP BY dc.board""", (did,)).fetchall()
owned = chk.execute("""
    SELECT COUNT(*) FROM deck_cards dc
     WHERE dc.deck_id = ?
       AND EXISTS (SELECT 1 FROM collection col WHERE col.card_id = dc.desired_card_id)""",
    (did,)).fetchone()[0]
total = chk.execute("SELECT COUNT(*) FROM deck_cards WHERE deck_id = ?", (did,)).fetchone()[0]
name = chk.execute("SELECT name, moxfield_public_id FROM decks WHERE id = ?", (did,)).fetchone()
chk.close()

print(f"\n   deck {did}: {name[0]}   moxfield_public_id={name[1]}")
for b, n in rows:
    print(f"      {b:11} {n}")
cmd_main = sum(n for b, n in rows if b in ('commander', 'mainboard'))
print(f"   commander + mainboard = {cmd_main}  (a legal EDH deck is 100)")
print(f"   rows on a printing he OWNS: {owned}/{total}")

print("\n=== 5. a second sync must be a no-op ===")
p2 = call(f"/moxfield/decks/{target['public_id']}/plan")
print(f"   add {len(p2['add'])}  remove {len(p2['remove'])}  "
      f"requantify {len(p2['requantify'])}  unchanged {len(p2['unchanged'])}")
print(f"   changes: {p2['changes']}  (must be 0)")
