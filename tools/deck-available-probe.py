#!/usr/bin/env python3
"""Read the Available to use row from the DECK VIEW, at phone size.

Zach's screenshot is the deck view on his phone, so that is where this must be
checked -- reading the collection pane and calling it done is how "did you not
update the app???" happened.
"""
import sys, time, base64
sys.path.insert(0, '/home/hermes/repos/bindarr/tools')
from cdpshot import Conn, new_target

CARD = sys.argv[1] if len(sys.argv) > 1 else 'Archfiend of Ifnir'
W, H = (int(sys.argv[2]), int(sys.argv[3])) if len(sys.argv) > 3 else (390, 844)
URL = 'https://bindarr-dev.tail387aa3.ts.net'

cdp = Conn(new_target(9222, "about:blank")["webSocketDebuggerUrl"])
for d in ('Page', 'Runtime', 'Network'):
    cdp.send(d + '.enable')
cdp.send('Network.setCacheDisabled', cacheDisabled=True)
cdp.send('Emulation.setDeviceMetricsOverride',
         width=W, height=H, deviceScaleFactor=2, mobile=True)
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
      "[...document.querySelectorAll('button')].some(b=>/Decks/.test(b.textContent))", 'load')
if ev("!!document.querySelector('input[type=password]')"):
    ev(f"""(()=>{{{SET}const i=[...document.querySelectorAll('input')];
      set(i[0],'admin');set(i[1],'bindarr');
      [...document.querySelectorAll('button')].find(b=>/login/i.test(b.textContent)).click();}})()""")
until("[...document.querySelectorAll('button')].some(b=>/Decks/.test(b.textContent))", 'nav')
ev("[...document.querySelectorAll('button')].find(b=>/^Decks$/.test(b.textContent.trim())).click()")
time.sleep(3)

# Doctor Doom is the deck that uses Archfiend of Ifnir.
print('deck:', ev("""(()=>{const all=[...document.querySelectorAll('*')]
  .filter(e=>e.children.length===0 && /Doctor Doom/.test(e.textContent));
  if(!all.length) return 'NOT FOUND';
  let n=all[0]; for(let i=0;i<6 && n;i++){ if(n.onclick||/deck/i.test(n.className||'')) break; n=n.parentElement; }
  (n||all[0]).click(); return 'clicked';})()"""))
time.sleep(3.5)

# Find the card row inside the deck and open it.
print('card :', ev(f"""(()=>{{const all=[...document.querySelectorAll('*')]
  .filter(e=>e.children.length===0 && e.textContent.trim().startsWith({CARD!r}));
  if(!all.length) return 'CARD ROW NOT FOUND';
  let n=all[0]; for(let i=0;i<6 && n;i++){{ if(/row|card/i.test(n.className||'')) break; n=n.parentElement; }}
  (n||all[0]).click(); return 'clicked';}})()"""))
time.sleep(3)

ev("""(()=>{const b=[...document.querySelectorAll('button')]
  .find(x=>x.textContent.trim()==='Yours');if(b)b.click();})()""")
time.sleep(2)

print('header:', ev("""(()=>{const m=document.body.textContent.match(/x\\d+ owned/);
  return m?m[0]:'?';})()"""))
print('AVAILABLE ROW:', ev("""(()=>{
 const rows=[...document.querySelectorAll('div')]
   .filter(d=>/Available to use/.test(d.textContent) && d.children.length===2);
 if(!rows.length) return 'ROW NOT FOUND';
 const r=rows[rows.length-1];
 return r.children[0].textContent.trim()+' -> '+r.children[1].textContent.trim();})()"""))

shot = cdp.send('Page.captureScreenshot', format='png')
open('/tmp/deckavail.png', 'wb').write(base64.b64decode(shot['data']))
print('saved /tmp/deckavail.png')
