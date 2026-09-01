#!/usr/bin/env python3
"""Do the two callers now produce the SAME Yours tab?

Zach's rule: "The card detail view should be no different between collection
and deck view though deck view should be read only."

So the test is a literal comparison: render the Yours rows from each caller's
payload the way the component does, and assert they match.
"""
import json, sqlite3, urllib.request, urllib.error

c = sqlite3.connect("file:/var/lib/bindarr-dev/bindarr.db?mode=ro", uri=True)
tok = c.execute("SELECT token FROM sessions ORDER BY rowid DESC LIMIT 1").fetchone()[0]
did = c.execute("SELECT id FROM decks WHERE name LIKE 'Tony Stark%' "
                "ORDER BY id DESC LIMIT 1").fetchone()[0]
c.close()


def get(path):
    req = urllib.request.Request("http://localhost:3002" + path,
                                 headers={"Authorization": "Bearer " + tok})
    try:
        return 200, json.loads(urllib.request.urlopen(req, timeout=40).read())
    except urllib.error.HTTPError as e:
        return e.code, None


col = get("/api/collection?game=mtg")[1]
items = col if isinstance(col, list) else col.get('cards', col.get('items', []))
from_collection = next(x for x in items if x.get('name') == 'Tony Stark')

det = get(f"/api/decks/{did}")[1]
from_deck = next((x for x in det['cards'] if x.get('name') == 'Tony Stark'),
                 det['cards'][0])


def render(card):
    """Mirror the component exactly."""
    cid = card.get('card_id') or card.get('desired_card_id') or card.get('id')
    st, res = get(f"/api/card/{cid}/decks")
    if st != 200:
        return {'ERROR': f'HTTP {st}'}
    entries = res.get('owned_entries') or []
    entry = entries[0] if entries else None
    copies = sum(e.get('quantity') or 0 for e in entries) or (card.get('quantity') or 0)

    rows = {}
    rows['Copies'] = f"x{copies}"
    rows['Finish'] = (entry or {}).get('finish') or card.get('finish') \
        or card.get('desired_finish') or 'nonfoil'
    if (entry or {}).get('condition'):
        rows['Condition'] = entry['condition']
    if entry:
        rows['Location'] = entry.get('location_name') or 'Not filed yet'
    if card.get('price_trend') and copies:
        rows['Value'] = f"${card['price_trend'] * copies:.2f}"
    rows['_other_printings'] = len([p for p in res['printings'] if p['id'] != cid])
    rows['_decks'] = len(res['decks'])
    return rows


a = render(from_collection)
b = render(from_deck)

print("FROM COLLECTION:")
for k, v in a.items():
    print(f"   {k:18} {v}")
print("\nFROM DECK VIEW:")
for k, v in b.items():
    print(f"   {k:18} {v}")

print("\nIDENTICAL:", a == b)
if a != b:
    for k in set(a) | set(b):
        if a.get(k) != b.get(k):
            print(f"   {k}: collection={a.get(k)!r}  deck={b.get(k)!r}")
