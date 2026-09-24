#!/usr/bin/env python3
"""Does the panel CHANGE HEIGHT when printings expand, and does it fit?

Zach: "The height it starts out as initially should be the height it stays. It
does appear to change heights. Because of that I have to scroll to the bottom
to see the edit button."

That is the sharpest statement of the bug so far, so this measures exactly it:
panel height with the disclosure CLOSED vs OPEN, plus whether the panel bottom
is inside the viewport.

RUNS AT SEVERAL HEIGHTS. At 390x844 the panel is a stable 743px and nothing
overflows -- I could not reproduce his report there. His screenshot is 661px
tall. A layout bug that only appears on a SHORT viewport is this codebase's
recurring shape (his desktop is 731px, not tall), so a single-size check is how
it keeps getting missed.
"""
import sys, time, base64, json
sys.path.insert(0, '/home/hermes/repos/bindarr/tools')
from cdpshot import Conn, new_target

CARD = sys.argv[1] if len(sys.argv) > 1 else 'Seedborn Muse'
SIZES = [(390, 844), (390, 661), (390, 600), (1855, 731)]
URL = 'https://bindarr-dev.tail387aa3.ts.net'

cdp = Conn(new_target(9222, "about:blank")["webSocketDebuggerUrl"])
for d in ('Page', 'Runtime', 'Network'):
    cdp.send(d + '.enable')
cdp.send('Network.setCacheDisabled', cacheDisabled=True)
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


MEASURE = """(()=>{
 const m=document.querySelector('.card-inspector, .card-inspector-inline');
 const sc=m.querySelector('.ci-scroll');
 const f=m.querySelector('.ci-footer-acts');
 const r=m.getBoundingClientRect();
 const fr=f?f.getBoundingClientRect():null;
 return {
  panelH:Math.round(r.height), panelBottom:Math.round(r.bottom),
  viewport:window.innerHeight,
  panelPastScreen: r.bottom > window.innerHeight+1,
  scrollBoxH: Math.round(sc.getBoundingClientRect().height),
  bodyScrolls: sc.scrollHeight>sc.clientHeight+1,
  footerVisible: fr ? (fr.bottom<=window.innerHeight+1 && fr.top>=0) : null,
  scrollers: [...m.querySelectorAll('*')].filter(e=>{const s=getComputedStyle(e);
    return /auto|scroll/.test(s.overflowY)&&e.scrollHeight>e.clientHeight+1;
  }).map(e=>e.className.toString().slice(0,24)),
  // CRUSHED SIBLINGS. The metric that mattered and that I did not have:
  // a flex column SHRINKS its items to fit, so a long printings list squashed
  // the Finish/Condition/Value/Available block to 2px tall. Panel height stays
  // perfectly stable while the content inside it is destroyed -- every other
  // number here read "clean" and the screenshot showed the bug.
  // Zach: "I cant scroll up to the value information."
  valueRowVisible: /Value/.test(m.textContent) && (()=>{
    const rows=[...m.querySelectorAll('div')].filter(d=>/^Value/.test(d.textContent||''));
    return rows.some(d=>d.getBoundingClientRect().height>8);
  })(),
  shortestRow: Math.min(...[...sc.children].map(c=>Math.round(c.getBoundingClientRect().height))),
 };})()"""

cdp.send('Page.navigate', url=URL)
time.sleep(4)
ev("""(async()=>{if(navigator.serviceWorker){
  const r=await navigator.serviceWorker.getRegistrations();for(const x of r)await x.unregister();}
  if(window.caches){const k=await caches.keys();for(const c of k)await caches.delete(c);}})()""")
time.sleep(1)

for (W, H) in SIZES:
    cdp.send('Emulation.setDeviceMetricsOverride',
             width=W, height=H, deviceScaleFactor=1, mobile=(W < 1000))
    cdp.send('Page.navigate', url=URL)
    time.sleep(4)
    until("!!document.querySelector('input[type=password]')||"
          "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Collection')",
          f'{W}x{H} load')
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
    until("!!document.querySelector('.card-inspector, .card-inspector-inline')", 'panel')
    time.sleep(1.8)
    ev("""(()=>{const p=document.querySelector('.card-inspector, .card-inspector-inline');
      const b=[...p.querySelectorAll('button')].find(x=>/^Yours$/i.test(x.textContent.trim()));
      if(b)b.click();})()""")
    until("(()=>{const p=document.querySelector('.card-inspector, .card-inspector-inline');"
          "return p&&/Available to use/i.test(p.textContent)})()", 'yours')
    time.sleep(1.2)

    # cdp.eval returns the value as a STRING; parse it before indexing.
    closed = json.loads(ev('JSON.stringify(' + MEASURE + ')'))
    ev("(()=>{const s=document.querySelector('details.ci-printings > summary');if(s)s.click();})()")
    time.sleep(1.8)
    opened = json.loads(ev('JSON.stringify(' + MEASURE + ')'))

    grew = opened['panelH'] - closed['panelH']
    print(f"\n=== {W}x{H}")
    print(f"  panel closed {closed['panelH']}  open {opened['panelH']}  "
          f"GREW BY {grew}px" + ("   <-- BUG" if grew else "   (stable)"))
    print(f"  past screen: closed {closed['panelPastScreen']}  open {opened['panelPastScreen']}"
          + ("   <-- BUG" if opened['panelPastScreen'] else ""))
    print(f"  footer visible: closed {closed['footerVisible']}  open {opened['footerVisible']}"
          + ("" if opened['footerVisible'] else "   <-- BUG"))
    print(f"  scrollers open: {opened['scrollers']}"
          + ("   <-- BUG (double scroll)" if len(opened['scrollers']) > 1 else ""))
    print(f"  Value row visible when open: {opened['valueRowVisible']}"
          + ("" if opened['valueRowVisible'] else "   <-- BUG (crushed)"))
    print(f"  shortest child row: {opened['shortestRow']}px"
          + ("   <-- BUG (squashed to nothing)" if opened['shortestRow'] < 8 else ""))

    shot = cdp.send('Page.captureScreenshot', format='png')
    p = f'/tmp/panel_{W}x{H}.png'
    open(p, 'wb').write(base64.b64decode(shot['data']))
    print('  saved', p)
