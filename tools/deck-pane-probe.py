#!/usr/bin/env python3
"""Does the DECK VIEW's detail pane change size while scrolling?

Zach: "Seems you solved the collection but not the deck view... also the pane
is expanding when I scroll here as well."

Same test as tools/scroll-pane-probe.py, pointed at a deck. The collection
pane's fix (position:fixed, constant height, offset below the header) was never
applied to .deck-panes-side, so this should reproduce the growth.
"""
import sys, time, base64, json
sys.path.insert(0, '/home/hermes/repos/bindarr/tools')
from cdpshot import Conn, new_target

W, H = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) > 2 else (1473, 736)
URL = 'https://bindarr-dev.tail387aa3.ts.net'

cdp = Conn(new_target(9222, "about:blank")["webSocketDebuggerUrl"])
for d in ('Page', 'Runtime', 'Network'):
    cdp.send(d + '.enable')
cdp.send('Network.setCacheDisabled', cacheDisabled=True)
cdp.send('Emulation.setDeviceMetricsOverride',
         width=W, height=H, deviceScaleFactor=1, mobile=False)
ev = cdp.eval

SET = ("const set=(el,v)=>{const s=Object.getOwnPropertyDescriptor("
       "window.HTMLInputElement.prototype,'value').set;"
       "s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};")


def until(expr, label, ms=90000):
    end = time.time() + ms / 1000
    while time.time() < end:
        v = ev(expr)
        if v:
            return v
        time.sleep(0.4)
    raise SystemExit(f'TIMEOUT: {label}')


cdp.send('Page.navigate', url=URL)
time.sleep(4)
ev("""(async()=>{if(navigator.serviceWorker){
  const r=await navigator.serviceWorker.getRegistrations();for(const x of r)await x.unregister();}
  if(window.caches){const k=await caches.keys();for(const c of k)await caches.delete(c);}})()""")
time.sleep(1)
cdp.send('Page.navigate', url=URL)
time.sleep(4)

until("!!document.querySelector('input[type=password]')||"
      "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Decks')", 'load')
if ev("!!document.querySelector('input[type=password]')"):
    ev(f"""(()=>{{{SET}const i=[...document.querySelectorAll('input')];
      set(i[0],'admin');set(i[1],'bindarr');
      [...document.querySelectorAll('button')].find(b=>/login/i.test(b.textContent)).click();}})()""")
until("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Decks')", 'nav')
ev("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Decks').click()")
time.sleep(3)

# Open the first deck, then a card in it.
print('deck:', ev("""(()=>{const rows=[...document.querySelectorAll('.deck-row, [class*=deck-card], a, button')]
  .filter(e=>/commander|deck/i.test(e.className||''));
  const r=rows[0]||document.querySelector('.deck-row');
  if(!r) return 'NO DECK ROW'; r.click(); return 'opened '+r.textContent.trim().slice(0,40);})()"""))
time.sleep(3)
until("!!document.querySelector('.deck-panes-side')||document.querySelectorAll('[class*=dv-row],[class*=deck-list] *').length",
      'deck view')
time.sleep(1.5)

MEASURE = """JSON.stringify((()=>{
 const p=document.querySelector('.deck-panes-side');
 if(!p) return {pane:'MISSING'};
 const r=p.getBoundingClientRect();
 const insp=p.querySelector('.card-inspector-inline');
 const ir=insp?insp.getBoundingClientRect():null;
 return {paneH:Math.round(r.height), paneTop:Math.round(r.top),
   paneBottom:Math.round(r.bottom), viewport:window.innerHeight,
   cutOff: r.bottom > window.innerHeight+1,
   inspectorH: ir?Math.round(ir.height):null};})())"""

rows = []
for y in (0, 400, 1200, 3000, 8000):
    ev(f"window.scrollTo(0,{y})")
    time.sleep(1.0)
    m = json.loads(ev(MEASURE))
    if m.get('pane') == 'MISSING':
        print('  pane MISSING — no card selected?')
        break
    rows.append(m)
    flag = '   <-- CUT OFF' if m['cutOff'] else ''
    print(f"  scrollTop {y:>5}: paneH {m['paneH']:>4}  top {m['paneTop']:>4}  "
          f"bottom {m['paneBottom']:>4}{flag}")

if rows:
    heights = {m['paneH'] for m in rows}
    print(f"\nDISTINCT PANE HEIGHTS: {sorted(heights)}")
    print('STABLE' if len(heights) == 1 else '<-- BUG: the pane resizes as you scroll')

shot = cdp.send('Page.captureScreenshot', format='png')
open('/tmp/deckpane.png', 'wb').write(base64.b64decode(shot['data']))
print('saved /tmp/deckpane.png')
