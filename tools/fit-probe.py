#!/usr/bin/env python3
"""Does the printings list FIT INSIDE its scroll box, with one scrollbar?

The three symptoms Zach reported -- double scrollbar, grey panel past the
screen, hidden Edit Card -- are all the same geometric question, so this asserts
it directly rather than eyeballing a screenshot:

  listInsideParent   list bottom <= scroll box bottom
  bodyScrolls        the tab body must NOT scroll (only the list may)
  listScrolls        true only when the content genuinely exceeds the space
  footerVisible      Edit Card on screen

Clears the service worker BEFORE measuring and aborts if the fresh CSS is not
what loaded -- two earlier runs measured a stale bundle and reported numbers
for code that was no longer deployed.
"""
import sys, time, base64
sys.path.insert(0, '/home/hermes/repos/bindarr/tools')
from cdpshot import Conn, new_target

CARD = sys.argv[1] if len(sys.argv) > 1 else 'Ancient Bronze Dragon'
OUT = sys.argv[2] if len(sys.argv) > 2 else '/tmp/fit.png'
W, H = 390, 844
URL = 'https://bindarr-dev.tail387aa3.ts.net'

cdp = Conn(new_target(9222, "about:blank")["webSocketDebuggerUrl"])
for d in ('Page', 'Runtime', 'Network'):
    cdp.send(d + '.enable')
cdp.send('Network.setCacheDisabled', cacheDisabled=True)
cdp.send('Emulation.setDeviceMetricsOverride',
         width=W, height=H, deviceScaleFactor=1, mobile=True)
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
        time.sleep(0.5)
    raise SystemExit(f'TIMEOUT: {label}')


cdp.send('Page.navigate', url=URL)
time.sleep(4)
ev("""(async()=>{if(navigator.serviceWorker){
  const r=await navigator.serviceWorker.getRegistrations();for(const x of r)await x.unregister();}
  if(window.caches){const k=await caches.keys();for(const c of k)await caches.delete(c);}})()""")
time.sleep(1)
cdp.send('Page.navigate', url=URL)
time.sleep(4)

rule = ev("""(()=>{for(const s of document.styleSheets){try{
  for(const r of s.cssRules){if(r.selectorText===' .ci-printings-list'.trim())
    return r.cssText;}}catch(e){}}return 'NOT FOUND';})()""")
print('loaded rule:', rule)
if 'NOT FOUND' in str(rule):
    raise SystemExit('ABORT: stale bundle; measurements would describe old code.')

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
ev("(()=>{const t=document.querySelector('.tcg-card');if(t)t.click();})()")
until("!!document.querySelector('.card-inspector')", 'modal')
time.sleep(2)
ev("""(()=>{const p=document.querySelector('.card-inspector');
  const b=[...p.querySelectorAll('button')].find(x=>/^Yours$/i.test(x.textContent.trim()));
  if(b)b.click();})()""")
until("(()=>{const p=document.querySelector('.card-inspector');"
      "return p&&/Available to use/i.test(p.textContent)})()", 'yours')
time.sleep(1)
print('expand:', ev("""(()=>{const s=document.querySelector('details.ci-printings > summary');
  if(!s) return 'NO DISCLOSURE'; s.click(); return 'clicked';})()"""))
time.sleep(3)

print(ev("""(()=>{
 const sc=document.querySelector('.ci-scroll');
 const li=document.querySelector('.ci-printings-list');
 const f=document.querySelector('.ci-footer-acts');
 if(!li) return JSON.stringify({list:'MISSING'});
 const R=e=>{const r=e.getBoundingClientRect();
   return {top:Math.round(r.top),bottom:Math.round(r.bottom),h:Math.round(r.height)}};
 return JSON.stringify({
  scrollBox:R(sc), list:R(li), footer:f?R(f):null,
  listInsideParent: li.getBoundingClientRect().bottom<=sc.getBoundingClientRect().bottom+1,
  bodyScrolls: sc.scrollHeight>sc.clientHeight+1,
  bodyScrollH:sc.scrollHeight, bodyClientH:sc.clientHeight,
  listScrolls: li.scrollHeight>li.clientHeight+1,
  listScrollH:li.scrollHeight, listClientH:li.clientHeight,
  footerVisible: f?f.getBoundingClientRect().bottom<=window.innerHeight+1:null,
 },null,1);})()"""))

shot = cdp.send('Page.captureScreenshot', format='png')
open(OUT, 'wb').write(base64.b64decode(shot['data']))
print('saved', OUT)
