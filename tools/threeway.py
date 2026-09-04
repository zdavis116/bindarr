#!/usr/bin/env python3
"""THREE THINGS AT ONCE, on the live server.

  1. A card on TWO Moxfield boards must produce TWO Bindarr rows.
     (Dracogenesis: mainboard TDM #105, maybeboard PTDM #105p. The bug lost the
     mainboard copy and made a 100-card deck 99.)
  2. Considering rows keep MOXFIELD's printing -- no substitution.
  3. A genuine board move still preserves the printing and finish.
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


# Rebuild from scratch: delete every row so the sync runs as a first sync.
live = sqlite3.connect(LIVE)
n = live.execute("DELETE FROM deck_cards WHERE deck_id=?", (did,)).rowcount
live.commit(); live.close()
print(f"cleared {n} rows; syncing from scratch...")
r = call(f'/moxfield/decks/{PID}/sync', {}, 'POST')
print("  " + json.dumps({k: v for k, v in r.items() if k != 'skipped'})[:160])

c = sqlite3.connect(DB, uri=True)
print("\n=== 1. a card on two boards keeps two rows ===")
rows = c.execute("""SELECT dc.board, cc.set_id, cc.number FROM deck_cards dc
                      JOIN card_cache cc ON cc.id = dc.desired_card_id
                     WHERE dc.deck_id=? AND cc.name='Dracogenesis'
                     ORDER BY dc.board""", (did,)).fetchall()
for x in rows:
    print(f"   {x[0]:12} {x[1].upper():6} #{x[2]}")
print(f"   rows: {len(rows)}  (Moxfield has it on 2 boards)")

print("\n=== deck size ===")
for b, n2 in c.execute("""SELECT board, SUM(quantity) FROM deck_cards
                           WHERE deck_id=? GROUP BY board""", (did,)):
    print(f"   {b:12} {n2}")
tot = c.execute("""SELECT SUM(quantity) FROM deck_cards WHERE deck_id=?
                    AND board IN ('commander','mainboard')""", (did,)).fetchone()[0]
print(f"   commander + mainboard = {tot}  (must be 100)")
c.close()

print("\n=== 2. considering rows keep Moxfield's printing ===")
import subprocess
UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
payload = json.loads(subprocess.run(
    ['curl', '-sS', '--max-time', '30', '-H', f'User-Agent: {UA}',
     '-H', 'sec-ch-ua: "Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
     '-H', 'Referer: https://www.moxfield.com/', '-H', 'Accept: application/json',
     f'https://api2.moxfield.com/v3/decks/all/{PID}'], capture_output=True, text=True).stdout)
mox = {}
for e in ((payload.get('boards') or {}).get('maybeboard') or {}).get('cards', {}).values():
    cd = e.get('card') or {}
    mox[cd['name']] = cd['scryfall_id']
c = sqlite3.connect(DB, uri=True)
stored = {r[0]: r[1] for r in c.execute(
    """SELECT cc.name, dc.desired_card_id FROM deck_cards dc
         JOIN card_cache cc ON cc.id = dc.desired_card_id
        WHERE dc.deck_id=? AND dc.board='considering'""", (did,))}
c.close()
bad = [n2 for n2, sid in mox.items() if stored.get(n2) != sid]
print(f"   considering rows: {len(stored)} of {len(mox)}")
print(f"   printing changed from Moxfield: {len(bad)}  (must be 0)")
for b2 in bad:
    print(f"      {b2}")

print("\n=== 3. a real board move preserves the printing ===")
c = sqlite3.connect(DB, uri=True)
row = c.execute("""SELECT dc.id, cc.set_id, cc.number, dc.desired_finish FROM deck_cards dc
                     JOIN card_cache cc ON cc.id = dc.desired_card_id
                    WHERE dc.deck_id=? AND cc.name='Tiamat'""", (did,)).fetchone()
c.close()
if row:
    live = sqlite3.connect(LIVE)
    live.execute("UPDATE deck_cards SET board='mainboard', desired_finish='foil' WHERE id=?",
                 (row[0],))
    live.commit(); live.close()
    print(f"   forced Tiamat -> mainboard, foil")
    call(f'/moxfield/decks/{PID}/sync', {}, 'POST')
    c = sqlite3.connect(DB, uri=True)
    a = c.execute("""SELECT dc.id, cc.set_id, cc.number, dc.desired_finish, dc.board
                       FROM deck_cards dc JOIN card_cache cc ON cc.id = dc.desired_card_id
                      WHERE dc.deck_id=? AND cc.name='Tiamat'""", (did,)).fetchone()
    c.close()
    print(f"   after sync: row {a[0]} {a[1].upper()} #{a[2]} {a[3]} board={a[4]}")
    print(f"   same row: {a[0]==row[0]}   printing kept: {a[1]==row[1] and a[2]==row[2]}   "
          f"finish kept: {a[3]=='foil'}")

print("\n=== idempotent ===")
p = call(f'/moxfield/decks/{PID}/plan')
print(f"   changes: {p['changes']}  unchanged: {len(p['unchanged'])}")
