p = 'frontend/src/components/DeckBuilder.jsx'
lines = open(p).read().split('\n')

# accentColor drove the removed gradient background and the 3px accent stripe.
# Deck state is carried by the border now, so the per-deck colour has nothing
# left to colour. Removing it rather than silencing the lint: an unused
# variable is a leftover, and leaving it implies the colour still matters.
hits = [i for i, l in enumerate(lines) if 'const accentColor = deck.accent_color' in l]
assert len(hits) == 1, f'expected 1 accentColor declaration, found {len(hits)}'
del lines[hits[0]]

open(p, 'w').write('\n'.join(lines))
print('accentColor declaration removed')
print('  remaining accentColor references:', sum('accentColor' in l for l in lines))
