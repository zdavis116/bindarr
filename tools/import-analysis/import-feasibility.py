#!/usr/bin/env python3
"""How much of Zach's real ManaBox export can the catalogue actually match?

Runs on the dev box against the live card_cache. Read-only.
Answers the only question that matters before building the importer:
does the CURRENT catalogue already know these cards, or does the Scryfall
sync have to come first?
"""
import csv, sqlite3, collections, sys

CSV = '/tmp/manabox.csv'
DB  = 'file:/var/lib/bindarr-dev/bindarr.db?mode=ro'

with open(CSV, newline='', encoding='utf-8-sig') as f:
    rows = list(csv.DictReader(f))

c = sqlite3.connect(DB, uri=True)
cols = [r[1] for r in c.execute('PRAGMA table_info(card_cache)')]
print('card_cache columns:', ', '.join(cols))
print('catalogue rows:', c.execute('select count(*) from card_cache').fetchone()[0])
print()

by_id = by_setnum = neither = 0
missing_sets = collections.Counter()
examples = []

for r in rows:
    sid = (r['Scryfall ID'] or '').strip()
    setc = (r['Set code'] or '').strip().lower()
    num  = (r['Collector number'] or '').strip().lstrip('0').lower()

    hit_id = c.execute('select 1 from card_cache where id = ? limit 1', (sid,)).fetchone()
    if hit_id:
        by_id += 1
        continue

    hit_sn = c.execute(
        "select 1 from card_cache where lower(set_id) = ? "
        "and lower(ltrim(number,'0')) = ? limit 1", (setc, num)).fetchone()
    if hit_sn:
        by_setnum += 1
    else:
        neither += 1
        missing_sets[r['Set code']] += 1
        if len(examples) < 8:
            examples.append(f"{r['Name'][:40]:<42} {r['Set code']}#{r['Collector number']}")

n = len(rows)
print(f'rows: {n}')
print(f'  matched by Scryfall ID   : {by_id:>5}  ({by_id/n*100:.1f}%)')
print(f'  matched by set+number    : {by_setnum:>5}  ({by_setnum/n*100:.1f}%)')
print(f'  NOT IN CATALOGUE         : {neither:>5}  ({neither/n*100:.1f}%)')

if missing_sets:
    print('\nsets the catalogue is missing (top 15):')
    for s, k in missing_sets.most_common(15):
        print(f'   {s:<8} {k:>4} rows')
    print('\nexamples:')
    for e in examples:
        print('  ', e)
