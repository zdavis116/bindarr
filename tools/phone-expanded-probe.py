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

cdp.send('Page.navigate', url='https://bindarr-dev.tail387aa3.ts.net')
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
