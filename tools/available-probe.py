#!/usr/bin/env python3
"""What does the Available to use row actually SAY on the deployed app?

Zach expected "2 of 3"; the API says 1 free of 3 owned with 2 in decks (I Am
Iron Man and Doctor Doom each claim one). This reads the rendered row so the
answer comes from the screen, not from my arithmetic.
"""
import sys, time, base64
sys.path.insert(0, '/home/hermes/repos/bindarr/tools')
from cdpshot import Conn, new_target

CARD = sys.argv[1] if len(sys.argv) > 1 else "Rogue's Passage"
URL = 'https://bindarr-dev.tail387aa3.ts.net'

cdp = Conn(new_target(9222, "about:blank")["webSocketDebuggerUrl"])
for d in ('Page', 'Runtime', 'Network'):
    cdp.send(d + '.enable')
cdp.send('Network.setCacheDisabled', cacheDisabled=True)
cdp.send('Emulation.setDeviceMetricsOverride',
         width=1473, height=736, deviceScaleFactor=1, mobile=False)
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

# The row lives on the Yours tab.
ev("""(()=>{const b=[...document.querySelectorAll('.card-inspector-inline button')]
  .find(x=>x.textContent.trim()==='Yours');if(b)b.click();})()""")
time.sleep(1.5)

print('header  :', ev("""(()=>{const h=document.querySelector('.card-inspector-inline');
  const t=h?h.textContent:''; const m=t.match(/x\\d+ owned/); return m?m[0]:'?';})()"""))
print('AVAILABLE ROW:', ev("""(()=>{
 const rows=[...document.querySelectorAll('.card-inspector-inline div')]
   .filter(d=>/Available to use/.test(d.textContent) && d.children.length===2);
 if(!rows.length) return 'ROW NOT FOUND';
 const r=rows[rows.length-1];
 return r.children[0].textContent.trim()+' -> '+r.children[1].textContent.trim();})()"""))

shot = cdp.send('Page.captureScreenshot', format='png')
open('/tmp/available.png', 'wb').write(base64.b64decode(shot['data']))
print('saved /tmp/available.png')
