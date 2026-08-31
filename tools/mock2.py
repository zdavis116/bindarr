import re
p = 'sketches/009-deck-view/index.html'
s = open(p).read()

# --- 3. GROUP BY TYPE, MOXFIELD STYLE ------------------------------------
# Zach: "can we have the cards separated by type like commander at top then
# creatures and so on. Just like moxfield."
#
# Commander first because it is the deck's premise, then the types in the order
# Moxfield uses. A flat 100-card list is unreadable; the sections are how you
# find "do I have enough ramp" without counting.

# Add the type field to the card data and a section style.
old_css = """  .list{display:flex;flex-direction:column;gap:5px}"""
new_css = """  .list{display:flex;flex-direction:column;gap:5px}
  /* Section headers: sticky so you always know which type you are looking at
     while scrolling a 100-card list. */
  .sec{display:flex;align-items:baseline;justify-content:space-between;
       padding:14px 2px 6px;position:sticky;top:0;background:var(--bg)}
  .sec b{font-size:12.5px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:var(--t2)}
  .sec span{font-size:11.5px;color:var(--t3)}"""
assert s.count(old_css) == 1
s = s.replace(old_css, new_css)

# Card data gains a type.
old_cards = re.search(r'  const CARDS = \[.*?\n  \];', s, re.S)
assert old_cards, 'CARDS not found'
new_cards = """  // name, set, qty, state, art tint, price, type
  const CARDS = [
    ['Krenko, Mob Boss','Jumpstart',1,'have','#9a4b30',0,'Commander'],
    ['Sol Ring','Commander Masters',1,'have','#7a6a52',0,'Artifact'],
    ['Goblin Chieftain','Modern Masters',1,'need','#8c3b2e',3.40,'Creature'],
    ['Purphoros, God of the Forge','Theros',1,'need','#a8452c',8.90,'Creature'],
    ['Skullclamp','Darksteel',1,'have','#6b6b6b',0,'Artifact'],
    ['Dockside Extortionist','Commander 2019',1,'need','#8a4433',24.00,'Creature'],
    ['Goblin Matron','Urza\\u2019s Saga',1,'need','#7e3a2c',1.20,'Creature'],
    ['Impact Tremors','Dragons of Tarkir',1,'have','#9b4a33',0,'Enchantment'],
    ['Coat of Arms','Tenth Edition',1,'need','#6d6455',4.10,'Artifact'],
    ['Chaos Warp','Commander 2011',1,'have','#a04a2f',0,'Instant'],
    ['Goblin War Strike','Onslaught',1,'have','#8e3f2d',0,'Sorcery'],
    ['Mountain','Kaldheim',34,'have','#7d4a3a',0,'Land'],
  ];

  // Moxfield's order: the commander first because it is the deck's premise,
  // then the types in the order a deck list is normally read.
  const TYPE_ORDER = ['Commander','Creature','Instant','Sorcery','Artifact',
                      'Enchantment','Planeswalker','Battle','Land'];"""
s = s[:old_cards.start()] + new_cards + s[old_cards.end():]

# Considering gains a type too, so it can render through the same code path.
old_con = re.search(r'  const CONSIDERING = \[.*?\n  \];', s, re.S)
assert old_con, 'CONSIDERING not found'
new_con = """  const CONSIDERING = [
    ['Goblin Recruiter','Battlebond',1,'consider','#8a4030',12.50,'Creature'],
    ['Thousand-Year Elixir','Commander 2014',1,'consider','#6f6250',9.20,'Artifact'],
    ['Bitterblossom','Modern Horizons 2',1,'consider','#5c4a63',18.00,'Enchantment'],
  ];"""
s = s[:old_con.start()] + new_con + s[old_con.end():]

open(p, 'w').write(s)
print('type data + order added')
