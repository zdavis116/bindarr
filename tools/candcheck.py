#!/usr/bin/env python3
"""Does the candidate list respect availability, not just ownership?

Zach: "we could own 1 but it could be in another deck so we need to own it and
it needs to be available."

Reading the code proves what it says. Running it proves what it does -- and
that distinction has caught four real bugs today. Calling the endpoint on his
actual decks.
"""
import json, sqlite3, urllib.request, urllib.error

DB = "file:/var/lib/bindarr-dev/bindarr.db?mode=ro"
API = "http://localhost:3002/api"
c = sqlite3.connect(DB, uri=True)
tok = c.execute("SELECT token FROM sessions ORDER BY rowid DESC LIMIT 1").fetchone()[0]
decks = c.execute("SELECT id, name FROM decks ORDER BY id").fetchall()
c.close()


def get(path):
    req = urllib.request.Request(API + path,
                                 headers={'Authorization': 'Bearer ' + tok})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=120).read())
    except urllib.error.HTTPError as e:
        return {'_status': e.code, 'body': e.read().decode()[:300]}


for did, name in decks:
    d = get(f'/decks/{did}/repoint-candidates')
    if '_status' in d:
        print(f"{name}: HTTP {d['_status']} {d['body'][:120]}")
        continue
    print(f"\n=== {name} ===")
    print(f"   rows {d['total']}  candidates {len(d['candidates'])}  "
          f"auto-applicable {d['auto_applicable']}")
    for cand in d['candidates'][:6]:
        w = cand['wants']
        alts = ', '.join(
            f"{(a['set_id'] or '').upper()} #{a['number']} {a['finish']} "
            f"(own {a['quantity_owned']}, free {a['quantity_available']})"
            for a in cand['alternatives'])
        tag = '' if cand['unambiguous'] else '   [AMBIGUOUS - not auto-applied]'
        print(f"   {cand['name'][:26]:26} wants {(w['set_id'] or '').upper():5} "
              f"#{w['number']:6} free_now={cand['available_now']}")
        print(f"      -> {alts}{tag}")
    if len(d['candidates']) > 6:
        print(f"   ... and {len(d['candidates']) - 6} more")

print("""
WHAT TO CHECK
  * every alternative shows free >= the row's quantity, or the availability
    rule is not being applied
  * a card claimed by another deck must NOT appear as an alternative
  * ambiguous rows are listed but flagged, never auto-applied
""")
