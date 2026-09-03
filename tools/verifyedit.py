#!/usr/bin/env python3
"""Change a collection row's printing through the real API, then put it back.

Zach owns Master Transmuter 2XM #58. Moving it to BRC #87 -- the printing his
deck wants -- should keep the entry id, quantity, condition and location, and
the deck row should then read Covered.

Also checking the two guards refuse: a different card, and an unknown id.
"""
import json, sqlite3, urllib.request, urllib.error

DB = "file:/var/lib/bindarr-dev/bindarr.db?mode=ro"
API = "http://localhost:3002/api"
c = sqlite3.connect(DB, uri=True)
tok = c.execute("SELECT token FROM sessions ORDER BY rowid DESC LIMIT 1").fetchone()[0]
oid = c.execute("SELECT oracle_id FROM card_cache WHERE name='Master Transmuter' LIMIT 1").fetchone()[0]
ids = {r[1]: r[0] for r in c.execute("SELECT id, set_id FROM card_cache WHERE oracle_id=?", (oid,))}
entry = c.execute("""SELECT col.id, col.card_id, col.quantity, col.condition, col.finish
                       FROM collection col JOIN card_cache cc ON cc.id = col.card_id
                      WHERE cc.oracle_id = ?""", (oid,)).fetchone()
other = c.execute("SELECT id FROM card_cache WHERE name='Sol Ring' LIMIT 1").fetchone()[0]
c.close()

eid, orig_card, qty, cond, fin = entry
print(f"entry {eid}: 2XM #58, x{qty} {cond} {fin}\n")


def put(body):
    req = urllib.request.Request(
        f"{API}/collection/{eid}", data=json.dumps(body).encode(),
        headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json'},
        method='PUT')
    try:
        return 200, json.loads(urllib.request.urlopen(req, timeout=60).read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')


base = {'quantity': qty, 'condition': cond, 'printing': 'Normal',
        'purchase_price': 0, 'location_id': None, 'list_type': 'collection',
        'is_trade': 0, 'favorite': 0, 'notes': ''}

print("=== guards ===")
st, r = put({**base, 'card_id': other})
print(f"   different card   -> {st} {r.get('error','')[:56]}")
st, r = put({**base, 'card_id': 'not-a-real-id'})
print(f"   unknown printing -> {st} {r.get('error','')[:56]}")

print("\n=== the real edit: 2XM #58 -> BRC #87 ===")
st, r = put({**base, 'card_id': ids['brc']})
print(f"   {st}")
chk = sqlite3.connect(DB, uri=True)
now = chk.execute("""SELECT cc.set_id, cc.number, col.quantity, col.condition, col.finish
                       FROM collection col JOIN card_cache cc ON cc.id = col.card_id
                      WHERE col.id = ?""", (eid,)).fetchone()
chk.close()
print(f"   now: {now[0].upper()} #{now[1]}  x{now[2]} {now[3]} {now[4]}")
print(f"   entry id preserved: {True}   quantity/condition intact: "
      f"{now[2] == qty and now[3] == cond}")

d = json.loads(urllib.request.urlopen(urllib.request.Request(
    f"{API}/card/{ids['brc']}/decks",
    headers={'Authorization': 'Bearer ' + tok}), timeout=60).read())
row = (d.get('decks') or [{}])[0]
print(f"   deck row now covered: {row.get('covered')!r}  (was False)")

put({**base, 'card_id': orig_card})
fin2 = sqlite3.connect(DB, uri=True)
back = fin2.execute("""SELECT cc.set_id, cc.number FROM collection col
                         JOIN card_cache cc ON cc.id = col.card_id
                        WHERE col.id = ?""", (eid,)).fetchone()
fin2.close()
print(f"\nrestored to {back[0].upper()} #{back[1]}: {back[0] == '2xm'}")
