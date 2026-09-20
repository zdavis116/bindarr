# Compare-modal preview harness

Renders the **real** `DeckCompareModal` with **real** Mana Pool data, so the
screen can be reviewed without a desktop session and without a hand-written
HTML mock.

A mock drifts from the component; reviewing one means approving a drawing of a
screen rather than the screen. This imports the shipping JSX and the shipping
stylesheet, so what you look at is what Zach opens.

## Use

Capture a payload (live Mana Pool call, ~10s), then serve:

```bash
export PATH="$HOME/.cache/hermes-node20/node-v20.20.2-linux-x64/bin:$PATH"
cd frontend
node ../tools/compare-live-probe.mjs "Atraxa, Praetors' Voice"   # sanity check
# write preview/payload.json in the shape of GET /api/decks/:id/compare/:publicId
npx vite --config vite.preview.config.js                          # 127.0.0.1:5199
```

Then screenshot it with the repo's CDP driver, at BOTH widths:

```bash
python3 tools/cdpdrive.py "http://127.0.0.1:5199/" 1473 736 /tmp/d.png \
  "wait:5" "eval:window.__showDiff()" "wait:3"
python3 tools/cdpdrive.py "http://127.0.0.1:5199/" 390 844 /tmp/p.png \
  "wait:5" "eval:window.__showDiff()" "wait:3"
```

`payload.json` is gitignored: it is large, regenerable, and captured live.

## Pitfall found the first time

The harness originally added invented "cards he also runs" with fake oracle
ids. One of them (`Birds of Paradise`) collided with a card already in the
deck, and the screen showed the same name twice — which looked exactly like a
dedupe bug in the route. It was not; the route keys by oracle id and had no
duplicates.

**When the harness shows something surprising, check the fixture before the
code.** Invented test data that overlaps real data manufactures bugs that do
not exist.
