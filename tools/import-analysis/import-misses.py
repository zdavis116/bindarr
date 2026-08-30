#!/usr/bin/env python3
"""What ARE the 19 unmatched rows, and how stale is the catalogue?

The importer's design hinges on this: if the misses are real cards Scryfall
knows about, a sync fixes them. If they are something else, the importer needs
a different answer for them.
"""
import csv, sqlite3, collections

CSV = '/tmp/manabox.csv'
DB  = 'file:/var/lib/bindarr-dev/bindarr.db?mode=ro'

with open(CSV, newline='', encoding='utf-8-sig') as f:
    rows = list(csv.DictReader(f))

c = sqlite3.connect(DB, uri=True)

miss = []
for r in rows:
    sid = (r['Scryfall ID'] or '').strip()
    if not c.execute('select 1 from card_cache where id = ? limit 1', (sid,)).fetchone():
        miss.append(r)

print(f'unmatched rows: {len(miss)}\n')
for r in miss:
    print(f"  {r['Name'][:38]:<40} {r['Set code']:<6}#{r['Collector number']:<5} "
          f"{r['Rarity']:<10} qty={r['Quantity']}")

# Are the SETS present at all, or entirely absent?
print('\nare these sets in the catalogue at all?')
for s in sorted({r['Set code'] for r in miss}):
    n = c.execute('select count(*) from card_cache where lower(set_id)=?', (s.lower(),)).fetchone()[0]
    print(f'   {s:<8} {n} rows in catalogue')

# How fresh is the catalogue overall?
print('\ncatalogue freshness:')
row = c.execute('select min(last_updated), max(last_updated) from card_cache').fetchone()
print('   last_updated range:', row)
newest = c.execute(
    'select set_id, set_name, count(*) n, max(last_updated) u from card_cache '
    'group by set_id order by u desc limit 8').fetchall()
print('\n   most recently updated sets:')
for s, name, n, u in newest:
    print(f'      {s:<8} {str(name)[:34]:<36} {n:>5} cards   {u}')
