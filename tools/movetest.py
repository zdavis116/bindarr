#!/usr/bin/env python3
"""DOES A BOARD MOVE PRESERVE THE PRINTING?

Zach's rule: on an existing deck, Moxfield only ensures the card is present and
must ignore printing and foil diffs entirely.

The hole I just fixed: moving a card between boards read as remove + add, and
the add re-picked a printing. Simulating exactly that -- put a card in the wrong
board locally, with a distinctive printing and finish, then sync and check the
row KEPT its identity.
"""
import json, sqlite3, urllib.request, urllib.error

DB = "file:/var/lib/bindarr-dev/bindarr.db?mode=ro"
LIVE = "/var/lib/bindarr-dev/bindarr.db"
API = "http://localhost:3002/api"
PID = "8Smp3oz_MEiOrwbsvIE88Q"

c = sqlite3.connect(DB, uri=True)
tok = c.execute("SELECT token FROM sessions ORDER BY rowid DESC LIMIT 1").fetchone()[0]
did = c.execute("SELECT id FROM decks WHERE moxfield_public_id = ?", (PID,)).fetchone()[0]
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


def row(name):
    ch = sqlite3.connect(DB, uri=True)
    r = ch.execute("""SELECT dc.id, cc.set_id, cc.number, dc.desired_finish,
                             dc.board, dc.quantity
                        FROM deck_cards dc JOIN card_cache cc ON cc.id = dc.desired_card_id
                       WHERE dc.deck_id = ? AND cc.name = ?""", (did, name)).fetchone()
    ch.close()
    return r


TARGET = 'Arcane Signet'
before = row(TARGET)
print(f"start        : row {before[0]}  {before[1].upper()} #{before[2]} "
      f"{before[3]}  board={before[4]}  x{before[5]}")

# Move it to the WRONG board locally, and give it a distinctive finish, so any
# re-pick by the sync is obvious.
ch = sqlite3.connect(LIVE)
ch.execute("UPDATE deck_cards SET board='considering', desired_finish='foil' WHERE id=?",
           (before[0],))
ch.commit(); ch.close()
moved = row(TARGET)
print(f"forced local : row {moved[0]}  {moved[1].upper()} #{moved[2]} "
      f"{moved[3]}  board={moved[4]}")

print("\n=== what the plan says ===")
p = call(f'/moxfield/decks/{PID}/plan')
print(f"   add {len(p['add'])}  remove {len(p['remove'])}  "
      f"moveBoard {len(p.get('moveBoard', []))}  requantify {len(p['requantify'])}")
for m in p.get('moveBoard', []):
    k = m['keeps_printing']
    print(f"   MOVE {m['name']}: {m['from_board']} -> {m['to_board']}, "
          f"keeps {str(k['set_id']).upper()} #{k['number']} {k['finish']}")

print("\n=== apply ===")
r = call(f'/moxfield/decks/{PID}/sync', {}, 'POST')
print("   " + json.dumps({k: v for k, v in r.items() if k != 'skipped'})[:170])

after = row(TARGET)
print(f"\nafter        : row {after[0]}  {after[1].upper()} #{after[2]} "
      f"{after[3]}  board={after[4]}  x{after[5]}")
print(f"   same row id        : {after[0] == before[0]}")
print(f"   printing untouched : {after[1] == moved[1] and after[2] == moved[2]}")
print(f"   FINISH untouched   : {after[3] == moved[3]}   (forced to foil; must stay foil)")
print(f"   board corrected    : {after[4]} (Moxfield says mainboard)")

# Put the finish back so the deck is not left odd.
ch = sqlite3.connect(LIVE)
ch.execute("UPDATE deck_cards SET desired_finish='nonfoil' WHERE id=?", (before[0],))
ch.commit(); ch.close()

print("\n=== still idempotent ===")
p2 = call(f'/moxfield/decks/{PID}/plan')
print(f"   changes: {p2['changes']}  unchanged: {len(p2['unchanged'])}")
