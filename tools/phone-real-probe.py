#!/usr/bin/env python3
"""Measure the PHONE modal against REAL dev data.

Zach reported this on his phone, on a card he owns: "Edit card doesn't anchor
to the bottom when I expand printings". The demo build cannot reproduce it --
demo cards have no collection row, so there is no Edit Card and no Other
printings to expand. Only real data exercises the path.

Reports NUMBERS: footer bottom vs viewport height, before and after expanding.
Either the footer is on screen or it is not.
"""
import sys, time, base64, json
sys.path.insert(0, '/home/hermes/repos/bindarr/tools')
from cdpshot import Conn, new_target

URL = 'https://bindarr-dev.tail387aa3.ts.net'
W, H = 390, 844
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/phone_real.png'

cdp = Conn(new_target(9222, "about:blank")["webSocketDebuggerUrl"])
cdp.send('Page.enable'); cdp.send('Runtime.enable')
cdp.send('Emulation.setDeviceMetricsOverride',
         width=W, height=H, deviceScaleFactor=1, mobile=True)
ev = cdp.eval
cdp.send('Page.navigate', url=URL)


def until(expr, label, ms=60000):
    end = time.time() + ms / 1000
    while time.time() < end:
        v = ev(expr)
        if v:
            return v
        time.sleep(0.5)
    raise SystemExit(f'TIMED OUT: {label}')


until("[...document.querySelectorAll('button')]"
      ".some(b=>b.textContent.trim()==='Collection')", 'nav')
ev("[...document.querySelectorAll('button')]"
   ".find(b=>b.textContent.trim()==='Collection').click()")

# Real collection is ~3,000 cards and takes a while on a throttled viewport.
n = until("document.querySelectorAll('.tcg-card').length", 'card grid')
print('grid tiles:', n)

# Open a card he OWNS with many printings -- Commander's Sphere from his
# screenshot has 45. Fall back to the first tile if it is not on this page.
opened = ev("""(()=>{
  const tiles=[...document.querySelectorAll('.tcg-card')];
  const want=tiles.find(t=>/Commander's Sphere/i.test(t.textContent));
  const t=want||tiles[0]; if(!t) return 'no tiles';
  t.click(); return 'opened: '+t.textContent.trim().slice(0,40);})()""")
print(opened)

until("!!document.querySelector('.card-inspector')", 'modal')
time.sleep(1.5)
ev("""(()=>{const p=document.querySelector('.card-inspector');
  const b=[...p.querySelectorAll('button')].find(x=>/^Yours$/i.test(x.textContent.trim()));
  if(b)b.click()})()""")
until("(()=>{const p=document.querySelector('.card-inspector');"
      "return p&&/Available to use/i.test(p.textContent)})()", 'Yours tab')
time.sleep(1.2)

MEASURE = """(()=>{
  const f=document.querySelector('.ci-footer-acts');
  if(!f) return JSON.stringify({footer:'MISSING'});
  const r=f.getBoundingClientRect();
  return JSON.stringify({
    position:getComputedStyle(f).position,
    footerBottom:Math.round(r.bottom),
    viewport:window.innerHeight,
    footerOnScreen:r.bottom<=window.innerHeight+1&&r.top>=0,
    hasEditCard:/Edit Card/i.test(f.textContent),
    hasBuyLink:!!f.querySelector('a[href]'),
  });})()"""

print('BEFORE expand:', ev(MEASURE))

print('action:', ev("""(()=>{const d=document.querySelector('details.ci-printings');
  if(!d) return 'no printings disclosure';
  d.open=true; return 'expanded';})()"""))
time.sleep(1.2)

print('AFTER expand: ', ev(MEASURE))
print('captions:', ev("""(()=>{
  const p=document.querySelector('.card-inspector');
  const rows=[...p.querySelectorAll('div')].filter(d=>/Value/.test(d.textContent)&&d.children.length===2);
  const f=document.querySelector('.ci-footer-acts');
  return JSON.stringify({
    valueRowText:(rows[0]?rows[0].textContent:'').slice(0,90),
    stockInFooter:f?/in stock/i.test(f.textContent):null,
  });})()"""))

shot = cdp.send('Page.captureScreenshot', format='png')
open(OUT, 'wb').write(base64.b64decode(shot['data']))
print('saved', OUT)
