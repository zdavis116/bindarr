#!/usr/bin/env python3
"""Does the Rulings section render on the Card tab, and is it reachable?

Reachability, not existence: this codebase's recurring bug is a control that
renders but cannot be used (z-index, below the fold, a dead className, a
`false &&` gate). So this opens a card that HAS rulings, expands the section,
and reports whether the ruling text is actually on screen.

Clears the service worker first -- Bindarr is a PWA and a returning page loads
the previous bundle, which has already made me report a working fix as broken.
"""
import sys, time, base64, json
sys.path.insert(0, '/home/hermes/repos/bindarr/tools')
from cdpshot import Conn, new_target

CARD = sys.argv[1] if len(sys.argv) > 1 else 'Library of Leng'
W, H = 1473, 736
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
ev(f"""(()=>{{{SET}const i=[...document.querySelectorAll('input')]
  .find(x=>/search/i.test(x.placeholder||''));if(i)set(i,{CARD!r});}})()""")
time.sleep(2.5)
print('tiles:', ev("document.querySelectorAll('.tcg-card').length"))
ev("(()=>{const t=document.querySelector('.tcg-card');if(t)t.click();})()")
until("!!document.querySelector('.card-inspector-inline')", 'pane')
time.sleep(1.5)

print('closed state:', ev("""JSON.stringify((()=>{
 const d=document.querySelector('details.ci-rulings');
 if(!d) return {section:'MISSING'};
 const s=d.querySelector('summary');
 const r=s.getBoundingClientRect();
 return {summaryText:s.textContent.trim().slice(0,60),
   open:d.open,
   summaryOnScreen: r.top>=0 && r.bottom<=window.innerHeight+1 && r.width>0};})())"""))

ev("(()=>{const s=document.querySelector('details.ci-rulings > summary');if(s)s.click();})()")
time.sleep(1.2)

print('opened     :', ev("""JSON.stringify((()=>{
 const d=document.querySelector('details.ci-rulings');
 if(!d) return {section:'MISSING'};
 const rows=[...d.querySelectorAll('.ci-printings-body > div > div')];
 const first=rows[0]?rows[0].getBoundingClientRect():null;
 const pane=document.querySelector('.card-inspector-inline').getBoundingClientRect();
 return {open:d.open, rulingRows:rows.length,
   firstRulingText: rows[0]?rows[0].textContent.trim().slice(0,70):null,
   // REACHABLE: rendered inside the pane, not clipped away to nothing.
   firstRulingVisible: first ? (first.height>10 && first.width>10
     && first.bottom>pane.top && first.top<pane.bottom) : false};})())"""))

shot = cdp.send('Page.captureScreenshot', format='png')
open('/tmp/rulings.png', 'wb').write(base64.b64decode(shot['data']))
print('saved /tmp/rulings.png')
