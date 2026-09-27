#!/usr/bin/env python3
"""Measure the PHONE modal with Other printings EXPANDED, on real dev data.

Uses the collection SEARCH box to find a specific multi-printing card rather
than hoping it is in the first page of tiles -- two earlier runs measured a
single-printing card, found no disclosure, and reported nulls that looked like
a broken feature.
"""
import sys, time, base64
sys.path.insert(0, '/home/hermes/repos/bindarr/tools')
from cdpshot import Conn, new_target

CARD = sys.argv[1] if len(sys.argv) > 1 else 'Waste Not'
OUT = sys.argv[2] if len(sys.argv) > 2 else '/tmp/phone_expanded.png'

cdp = Conn(new_target(9222, "about:blank")["webSocketDebuggerUrl"])
cdp.send('Page.enable'); cdp.send('Runtime.enable')
cdp.send('Emulation.setDeviceMetricsOverride',
         width=390, height=844, deviceScaleFactor=1, mobile=True)
ev = cdp.eval


def until(expr, label, ms=90000):
    end = time.time() + ms / 1000
    while time.time() < end:
        v = ev(expr)
        if v:
            return v
        time.sleep(0.5)
    raise SystemExit(f'TIMEOUT: {label}')


SET_VAL = """(el,v)=>{const s=Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,'value').set;
  s.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}));}"""

# DISABLE THE HTTP CACHE, and the service worker with it.
#
# Bindarr is a PWA: workbox precaches index.html, so a returning page loads the
# OLD asset filenames even though the server's index.html references the new
# ones. Two probe runs reported byte-identical numbers after a correct deploy,
# including a computed style for an inline rule I had just deleted -- because
# the browser was running the previous bundle entirely.
#
# ORDER MATTERS: unregistering before the first navigation does nothing, since
# the page then loads and re-registers the worker. Navigate, clear, then
# RELOAD -- the second load is the clean one.
cdp.send('Network.enable')
cdp.send('Network.setCacheDisabled', cacheDisabled=True)

cdp.send('Page.navigate', url='https://bindarr-dev.tail387aa3.ts.net')
time.sleep(4)
ev("""(async()=>{
  if (navigator.serviceWorker) {
    const rs = await navigator.serviceWorker.getRegistrations();
    for (const r of rs) await r.unregister();
  }
  if (window.caches) {
    const ks = await caches.keys();
    for (const k of ks) await caches.delete(k);
  }
  return 'cleared';})()""")
time.sleep(1)
cdp.send('Page.navigate', url='https://bindarr-dev.tail387aa3.ts.net')
time.sleep(3)

# PROVE the fresh bundle is what loaded, rather than assuming the clear worked.
loaded = ev("[...document.querySelectorAll('link[rel=stylesheet]')]"
            ".map(l=>l.href.split('/').pop()).join(',')")
print('stylesheets loaded:', loaded)
rule = ev("""(()=>{for(const s of document.styleSheets){try{
  for(const r of s.cssRules){if(r.selectorText&&r.selectorText.includes('ci-printings-list'))
    return r.cssText;}}catch(e){}}return 'RULE NOT FOUND';})()""")
print('printings rule:', rule)
if 'NOT FOUND' in str(rule):
    raise SystemExit('ABORT: the browser is still running a stale bundle; '
                     'measurements would describe the old code.')

until("!!document.querySelector('input[type=password]')||"
      "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Collection')",
      'load')
if ev("!!document.querySelector('input[type=password]')"):
    ev(f"""(()=>{{const set={SET_VAL};
      const ins=[...document.querySelectorAll('input')];
      set(ins[0],'admin'); set(ins[1],'bindarr');
      [...document.querySelectorAll('button')].find(b=>/login/i.test(b.textContent)).click();}})()""")
until("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Collection')", 'nav')
ev("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Collection').click()")
until("document.querySelectorAll('.tcg-card').length", 'grid')

# SEARCH for the card instead of scanning the first page of tiles.
ev(f"""(()=>{{const set={SET_VAL};
  const i=[...document.querySelectorAll('input')].find(x=>
    /search/i.test(x.placeholder||'')||x.type==='search');
  if(i) set(i,{CARD!r});}})()""")
time.sleep(2.5)
print('tiles after search:', ev("document.querySelectorAll('.tcg-card').length"))
print(ev(f"""(()=>{{const t=[...document.querySelectorAll('.tcg-card')];
  const w=t.find(x=>new RegExp({CARD!r},'i').test(x.textContent))||t[0];
  if(!w) return 'NO TILE'; w.click();
  return 'opened: '+w.textContent.trim().slice(0,40);}})()"""))

until("!!document.querySelector('.card-inspector')", 'modal')
time.sleep(2)
ev("""(()=>{const p=document.querySelector('.card-inspector');
  const b=[...p.querySelectorAll('button')].find(x=>/^Yours$/i.test(x.textContent.trim()));
  if(b)b.click()})()""")
until("(()=>{const p=document.querySelector('.card-inspector');"
      "return p&&/Available to use/i.test(p.textContent)})()", 'yours tab')
time.sleep(1.5)

print('summary:', ev("""(()=>{const s=document.querySelector('details.ci-printings > summary');
  if(!s) return 'NO DISCLOSURE (single-printing card)'; s.click(); return 'clicked'})()"""))
time.sleep(2)

MEASURE = """(()=>{
 const m=document.querySelector('.card-inspector');
 const sc=m.querySelector('.ci-scroll');
 const list=m.querySelector('.ci-printings-list');
 const f=m.querySelector('.ci-footer-acts');
 const R=e=>{if(!e)return null;const r=e.getBoundingClientRect();
   return {top:Math.round(r.top),bottom:Math.round(r.bottom),h:Math.round(r.height)}};
 return JSON.stringify({
  viewport:window.innerHeight,
  modal:R(m),
  modalBottomOffscreenBy: Math.max(0, Math.round(m.getBoundingClientRect().bottom-window.innerHeight)),
  scrollBox:R(sc), scrollBoxScrolls: sc?sc.scrollHeight>sc.clientHeight:null,
  list:R(list),
  listMaxHeight: list?getComputedStyle(list).maxHeight:null,
  listOverflowY: list?getComputedStyle(list).overflowY:null,
  listNeedsScroll: list?list.scrollHeight>list.clientHeight+1:null,
  listScrollH: list?list.scrollHeight:null,
  listClientH: list?list.clientHeight:null,
  footer:R(f),
  footerFullyVisible: f?(f.getBoundingClientRect().bottom<=window.innerHeight+1
                         && f.getBoundingClientRect().top>=0):null,
 },null,1);})()"""
print(ev(MEASURE))

shot = cdp.send('Page.captureScreenshot', format='png')
open(OUT, 'wb').write(base64.b64decode(shot['data']))
print('saved', OUT)
