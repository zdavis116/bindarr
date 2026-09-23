#!/usr/bin/env python3
"""Measure the PHONE modal: is Edit Card anchored, with printings expanded?

Zach reported on a phone (390x844), and the bug was that the anchoring CSS was
scoped to the desktop pane only. So this probe runs at phone size, EXPANDS
Other printings -- the exact action that broke it -- and reports whether the
footer is still on screen.

Reports numbers, not vibes: footerBottom vs viewport height is either inside or
outside. A screenshot glance is how I previously confirmed my own expectation
instead of checking.
"""
import sys, time, base64
sys.path.insert(0, '/home/hermes/repos/bindarr/tools')
from cdpshot import Conn, new_target

W = int(sys.argv[1]) if len(sys.argv) > 1 else 390
H = int(sys.argv[2]) if len(sys.argv) > 2 else 844
OUT = sys.argv[3] if len(sys.argv) > 3 else '/tmp/phone_modal.png'

cdp = Conn(new_target(9222, "about:blank")["webSocketDebuggerUrl"])
cdp.send('Page.enable'); cdp.send('Runtime.enable')
cdp.send('Emulation.setDeviceMetricsOverride',
         width=W, height=H, deviceScaleFactor=1, mobile=True)
ev = cdp.eval
cdp.send('Page.navigate', url='http://127.0.0.1:8899/bindarr/')


def until(expr, label, ms=25000):
    end = time.time() + ms / 1000
    while time.time() < end:
        v = ev(expr)
        if v:
            return v
        time.sleep(0.3)
    raise SystemExit(f'TIMED OUT: {label}')


until("[...document.querySelectorAll('button')]"
      ".some(b=>b.textContent.trim()==='Collection')", 'nav')
ev("[...document.querySelectorAll('button')]"
   ".find(b=>b.textContent.trim()==='Collection').click()")
until("document.querySelectorAll('.tcg-card').length", 'grid')
ev("document.querySelectorAll('.tcg-card')[0].click()")

# The PHONE renders .card-inspector (the modal), not .card-inspector-inline.
until("!!document.querySelector('.card-inspector')", 'modal')
time.sleep(1.2)
ev("""(()=>{const p=document.querySelector('.card-inspector');
  const b=[...p.querySelectorAll('button')].find(x=>/^Yours$/i.test(x.textContent.trim()));
  if(b)b.click()})()""")
until("(()=>{const p=document.querySelector('.card-inspector');"
      "return p&&/Available to use/i.test(p.textContent)})()", 'Yours tab')
time.sleep(0.8)

before = ev("""(()=>{
  const f=document.querySelector('.ci-footer-acts');
  if(!f) return JSON.stringify({footer:'MISSING'});
  const r=f.getBoundingClientRect();
  return JSON.stringify({
    position: getComputedStyle(f).position,
    bottom: Math.round(r.bottom), viewport: window.innerHeight,
    onScreen: r.bottom<=window.innerHeight+1 && r.top>=0,
  });})()""")
print('BEFORE expanding printings:', before)

# THE ACTION THAT BROKE IT.
opened = ev("""(()=>{const d=document.querySelector('details.ci-printings');
  if(!d) return 'no disclosure'; d.open=true;
  d.dispatchEvent(new Event('toggle')); return 'expanded ('+
  d.querySelectorAll('button').length+' printings)';})()""")
print('action:', opened)
time.sleep(1.0)

print('AFTER expanding: ', ev("""(()=>{
  const f=document.querySelector('.ci-footer-acts');
  if(!f) return JSON.stringify({footer:'MISSING'});
  const r=f.getBoundingClientRect();
  const scroll=document.querySelector('.card-inspector .ci-scroll');
  const sr=scroll&&scroll.getBoundingClientRect();
  // Which elements actually scroll -- "everything between the tabs and Edit
  // Card should be scrollable" is a claim about the whole body, not one rule.
  const scrollers=[...document.querySelectorAll('.card-inspector *')].filter(e=>{
    const s=getComputedStyle(e);
    return /auto|scroll/.test(s.overflowY)&&e.scrollHeight>e.clientHeight+2;
  }).map(e=>(e.className||e.tagName).toString().slice(0,40));
  return JSON.stringify({
    position: getComputedStyle(f).position,
    footerBottom: Math.round(r.bottom), viewport: window.innerHeight,
    footerOnScreen: r.bottom<=window.innerHeight+1 && r.top>=0,
    editCardVisible: /Edit Card/i.test(f.textContent),
    scrollBoxCanScroll: scroll?scroll.scrollHeight>scroll.clientHeight:null,
    scrollingElements: scrollers,
    strayStockLabel: /in stock/i.test(document.querySelector('.card-inspector').textContent)
      && !/in stock/i.test([...document.querySelectorAll('.card-inspector')]
          .map(p=>p.textContent).join('').split('Available to use')[0]||''),
  },null,1);})()"""))

shot = cdp.send('Page.captureScreenshot', format='png')
open(OUT, 'wb').write(base64.b64decode(shot['data']))
print('saved', OUT)
