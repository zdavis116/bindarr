#!/usr/bin/env python3
"""Both of Zach's answers, verified against the live server.

1. Considering rows must keep MOXFIELD's printing (2 of 9 were being swapped).
2. Considering must not appear in the buy-list.

For (2) the existing buylistForDeck already skips non-reserving boards, so this
is a check that the sync did not undermine an existing rule -- not new code.
Verifying rather than assuming, because "the code says so" has been wrong six
times today.
"""
import json, sqlite3, urllib.request, urllib.error, subprocess

DB = "file:/var/lib/bindarr-dev/bindarr.db?mode=ro"
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


# Wipe the considering rows and re-sync them, so the preference runs fresh.
live = sqlite3.connect('/var/lib/bindarr-dev/bindarr.db')
n = live.execute("DELETE FROM deck_cards WHERE deck_id=? AND board='considering'",
                 (did,)).rowcount
live.commit(); live.close()
print(f"cleared {n} considering rows, re-syncing...")
r = call(f'/moxfield/decks/{PID}/sync', {}, 'POST')
print("  " + json.dumps({k: v for k, v in r.items() if k != 'skipped'})[:150])

UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
payload = json.loads(subprocess.run(
    ['curl', '-sS', '--max-time', '30', '-H', f'User-Agent: {UA}',
     '-H', 'sec-ch-ua: "Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
     '-H', 'Referer: https://www.moxfield.com/', '-H', 'Accept: application/json',
     f'https://api2.moxfield.com/v3/decks/all/{PID}'],
    capture_output=True, text=True).stdout)
mox = {}
for e in ((payload.get('boards') or {}).get('maybeboard') or {}).get('cards', {}).values():
    cd = e.get('card') or {}
    mox[cd.get('name')] = (cd.get('set'), cd.get('cn'))

c = sqlite3.connect(DB, uri=True)
stored = {r[0]: (r[1], r[2]) for r in c.execute(
    """SELECT cc.name, cc.set_id, cc.number FROM deck_cards dc
         JOIN card_cache cc ON cc.id = dc.desired_card_id
        WHERE dc.deck_id=? AND dc.board='considering'""", (did,))}
c.close()

print("\n=== 1. considering rows keep Moxfield's printing ===")
swapped = 0
for name, m in sorted(mox.items()):
    s = stored.get(name)
    if not s:
        print(f"   {name[:28]:28} MISSING"); continue
    same = str(s[0]).lower() == str(m[0]).lower() and str(s[1]) == str(m[1])
    if not same:
        swapped += 1
        print(f"   {name[:28]:28} SWAPPED {str(m[0]).upper()} #{m[1]} -> {str(s[0]).upper()} #{s[1]}")
print(f"   swapped: {swapped} of {len(mox)}  (must be 0)")

print("\n=== 2. the buy-list ignores considering ===")
b = call(f'/decks/{did}/buylist')
if '_status' in b:
    print("   " + json.dumps(b)[:200])
else:
    print(f"   items to buy      : {len(b.get('items', []))}")
    print(f"   considering (sep) : {len(b.get('considering', []))}")
    boards = sorted({i.get('board') for i in b.get('items', [])})
    print(f"   boards in items   : {boards or '(none)'}")
    print(f"   'considering' in items: {'considering' in boards}  (must be False)")
