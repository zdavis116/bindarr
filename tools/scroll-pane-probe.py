#!/usr/bin/env python3
"""Does the right-hand pane change size WHEN YOU SCROLL THE COLLECTION?

Zach, twice: "when I scroll down the collection with the right pane open it
grows bigger to the point it gets cut off... it should stay the same size from
the START."

Every previous probe I wrote opened the pane and measured it STANDING STILL,
which is why four rounds of fixes all measured clean while the bug was sitting
in his screenshot. Scrolling is the trigger, so scrolling is the test.

Measures pane height and bottom at several scroll positions on the desktop
collection. The pane is sticky, so its height must not change at all.
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
      "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Collection')", 'load')
if ev("!!document.querySelector('input[type=password]')"):
    ev(f"""(()=>{{{SET}const i=[...document.querySelectorAll('input')];
      set(i[0],'admin');set(i[1],'bindarr');
      [...document.querySelectorAll('button')].find(b=>/login/i.test(b.textContent)).click();}})()""")
until("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Collection')", 'nav')
ev("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Collection').click()")
until("document.querySelectorAll('.tcg-card').length", 'grid')
time.sleep(2)

# Open the pane on the first card.
ev("(()=>{const t=document.querySelector('.tcg-card');if(t)t.click();})()")
until("!!document.querySelector('.card-inspector-inline')", 'inline pane')
time.sleep(1.5)

MEASURE = """JSON.stringify((()=>{
 const p=document.querySelector('.card-inspector-inline');
 if(!p) return {pane:'MISSING'};
 const r=p.getBoundingClientRect();
 const cs=getComputedStyle(p);
 return {
  paneH:Math.round(r.height),
  paneTop:Math.round(r.top),
  paneBottom:Math.round(r.bottom),
  viewport:window.innerHeight,
  cutOff: r.bottom > window.innerHeight+1,
  paneTopVar: p.style.getPropertyValue('--pane-top'),
  cssHeight: cs.height,
 };})())"""

# THE SCROLLER is the collection column, not the window -- find whichever moves.
print('scroll target:', ev("""(()=>{
 const cands=[document.scrollingElement,
   ...document.querySelectorAll('.coll-main,.coll-split,main,[class*=list]')];
 for(const c of cands){ if(c && c.scrollHeight>c.clientHeight+50)
   return (c.className||c.tagName)+' scrollH='+c.scrollHeight; }
 return 'none found';})()"""))

rows = []
for y in (0, 400, 1200, 3000, 8000):
    ev(f"""(()=>{{
      const cands=[document.scrollingElement,
        ...document.querySelectorAll('.coll-main,.coll-split,main,[class*=list]')];
      for(const c of cands){{ if(c && c.scrollHeight>c.clientHeight+50){{ c.scrollTop={y}; return; }} }}
      window.scrollTo(0,{y});}})()""")
    time.sleep(1.2)
    m = json.loads(ev(MEASURE))
    rows.append((y, m))
    flag = '   <-- CUT OFF' if m.get('cutOff') else ''
    print(f"  scrollTop {y:>5}: paneH {m['paneH']:>4}  top {m['paneTop']:>4}  "
          f"bottom {m['paneBottom']:>4}  --pane-top {m['paneTopVar'] or '(unset)'}{flag}")

heights = {m['paneH'] for _, m in rows}
print(f"\nDISTINCT PANE HEIGHTS WHILE SCROLLING: {sorted(heights)}")
print('STABLE' if len(heights) == 1 else '<-- BUG: the pane resizes as you scroll')

shot = cdp.send('Page.captureScreenshot', format='png')
out = f'/tmp/scroll_{W}x{H}.png'
open(out, 'wb').write(base64.b64decode(shot['data']))
print('saved', out)
