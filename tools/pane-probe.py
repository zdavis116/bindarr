#!/usr/bin/env python3
"""Open the detail pane in the demo build and MEASURE it.

Why this exists: the pane's requirements are about geometry -- "Edit Card
always visible at the bottom", "only the printings list scrollable", "the flip
toggle shouldn't cover the art". Source-grep tests cannot see any of that, and
a screenshot glance is how I have previously confirmed my own expectations
instead of checking (see the skill: SCREENSHOTTING IS NOT COMPARING).

So this reports BOOLEANS and NUMBERS -- footerInView, printingsOpenByDefault,
scrollableCount -- which are either right or wrong, and a screenshot alongside.

POLLS, never sleeps a fixed time. Fixed waits raced the view transition and
gave three different answers to the same question in three runs.
"""
import json, sys, time
sys.path.insert(0, '/home/hermes/repos/bindarr/tools')
from cdpshot import Conn, new_target  # reuse the working CDP plumbing

W, H = int(sys.argv[1]) if len(sys.argv) > 1 else 1473, \
       int(sys.argv[2]) if len(sys.argv) > 2 else 736
OUT = sys.argv[3] if len(sys.argv) > 3 else '/tmp/pane_final.png'

cdp = Conn(new_target(9222, "about:blank")["webSocketDebuggerUrl"])
cdp.send('Page.enable'); cdp.send('Runtime.enable')
cdp.send('Emulation.setDeviceMetricsOverride',
         width=W, height=H, deviceScaleFactor=1, mobile=False)

ev = cdp.eval


def until(expr, label, ms=20000):
    end = time.time() + ms / 1000
    while time.time() < end:
        v = ev(expr)
        if v:
            return v
        time.sleep(0.3)
    raise SystemExit(f'TIMED OUT waiting for: {label}')


cdp.send('Page.navigate', url='http://127.0.0.1:8899/bindarr/')
until("[...document.querySelectorAll('button')]"
      ".some(b=>b.textContent.trim()==='Collection')", 'nav')
ev("[...document.querySelectorAll('button')]"
   ".find(b=>b.textContent.trim()==='Collection').click()")

tiles = until("(()=>{const t=document.querySelectorAll('.tcg-card-meta');"
              "return t.length||0})()", 'card grid')
print('grid tiles:', tiles)

print(ev("""(()=>{
  // The tile is a DIV with a click handler (.tcg-card), not a <button>.
  // Verified by dumping the ancestry rather than assuming -- the previous two
  // selectors were guesses and both silently found nothing.
  const t=[...document.querySelectorAll('.tcg-card')][0];
  if(!t) return 'no tile';
  t.click(); return 'opened: '+t.textContent.trim().slice(0,40);
})()"""))

until("!!document.querySelector('.card-inspector-inline')", 'inline pane')
time.sleep(1.0)

# THE PANE OPENS ON THE *CARD* TAB. The printings disclosure and the anchored
# footer live on YOURS, so measuring straight after opening reported both as
# absent -- a false negative that looked exactly like a broken feature.
# Switch tabs first, and prove the switch landed before measuring.
ev("""(()=>{const p=document.querySelector('.card-inspector-inline');
  const b=[...p.querySelectorAll('button')].find(x=>/^Yours$/i.test(x.textContent.trim()));
  if(b){b.click();return 'switched'}return 'no Yours tab'})()""")
until("(()=>{const p=document.querySelector('.card-inspector-inline');"
      "return p && /Finish|Condition|Available to use/i.test(p.textContent)})()",
      'Yours tab content')
time.sleep(1.0)

print(ev("""(()=>{
  const pane=document.querySelector('.card-inspector-inline');
  const det=pane.querySelector('details.ci-printings');
  const foot=pane.querySelector('.ci-footer-acts');
  const fr=foot&&foot.getBoundingClientRect();
  const img=pane.querySelector('.ci-image-wrap');
  const ir=img&&img.getBoundingClientRect();

  // WHICH ELEMENTS ACTUALLY SCROLL. "Only the printings list should be
  // scrollable" is a claim about every descendant, not about the one rule I
  // happened to write -- so enumerate rather than assert my own CSS back.
  const scrollers=[...pane.querySelectorAll('*')].filter(e=>{
    const s=getComputedStyle(e);
    return /auto|scroll/.test(s.overflowY) && e.scrollHeight>e.clientHeight+2;
  }).map(e=>e.className||e.tagName);

  // Does the flip control overlap the artwork? The complaint was geometric.
  const flip=[...pane.querySelectorAll('button')].find(b=>b.querySelector('svg')&&
    !b.getAttribute('aria-label'));
  let flipOverArt=null;
  if(flip&&ir){const f=flip.getBoundingClientRect();
    flipOverArt=!(f.right<ir.left||f.left>ir.right||f.bottom<ir.top||f.top>ir.bottom);}

  return JSON.stringify({
    printingsDisclosure: !!det,
    printingsOpenByDefault: det?det.open:'n/a',
    footerExists: !!foot,
    editCardInFooter: foot?/Edit Card/i.test(foot.textContent):null,
    buyLinkInFooter: foot?!!foot.querySelector('a[href]'):null,
    footerFullyInView: fr?(fr.bottom<=window.innerHeight+1&&fr.top>=0):null,
    footerBottom: fr?Math.round(fr.bottom):null,
    viewportHeight: window.innerHeight,
    closeButtonPresent: !!pane.querySelector('button[aria-label]'),
    availabilityRowPresent: /Available to use/i.test(pane.textContent),
    scrollableElements: scrollers,
    flipOverlapsArt: flipOverArt,
  },null,1);
})()"""))

shot = cdp.send('Page.captureScreenshot', format='png')
import base64
open(OUT, 'wb').write(base64.b64decode(shot['data']))
print('saved', OUT)
