#!/usr/bin/env python3
# CLICK EVERY CARD IN A DECK AND CHECK THE DESCRIPTION ACTUALLY RENDERS.
#
# Zach: "sometimes when I click on cards when in deck view the description just
# doesnt show up."
#
# "Sometimes" is the whole problem. A screenshot of one working card proves
# nothing, and neither does my reading of the code. This clicks through the
# whole list and records, per card, whether rules text appeared -- so an
# intermittent failure shows up as a COUNT, with the fetch status beside it.
#
# The suspicion being tested: CardInspectorModal fetches /api/card/:id/decks
# and swallows every failure (`r.ok ? r.json() : null`, `.catch(() => {})`), so
# a failed or slow response leaves the sheet with no oracle_text and no error.
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdpdrive import Conn, new_target  # noqa: E402

URL = os.environ.get('URL', 'https://bindarr-dev.tail387aa3.ts.net')
PORT = int(os.environ.get('PORT', '9222'))

LOGIN = """(function(){
  var ins=[].slice.call(document.querySelectorAll('input'));
  if(ins.length<2) return 'already';
  var s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  s.call(ins[0],'admin'); ins[0].dispatchEvent(new Event('input',{bubbles:true}));
  s.call(ins[1],'bindarr'); ins[1].dispatchEvent(new Event('input',{bubbles:true}));
  var b=[].slice.call(document.querySelectorAll('button')).filter(
    function(x){return /login/i.test(x.innerText);})[0];
  if(b) b.click();
  return 'logging in';
})()"""

HOOK = """(function(){
  window.__calls=[];
  var of=window.fetch;
  window.fetch=function(u){
    var p=of.apply(this,arguments);
    if(String(u).indexOf('/api/card/')>=0){
      p.then(function(r){window.__calls.push(r.status);})
       .catch(function(){window.__calls.push('THREW');});
    }
    return p;
  };
  return 'hooked';
})()"""

GO_DECKS = """(function(){
  var t=[].slice.call(document.querySelectorAll('.nav-tab,.nav-rail-item'))
    .filter(function(x){return /Decks/i.test(x.innerText||'');})[0];
  if(t){t.click(); return 'decks';} return 'no tab';
})()"""

OPEN_DECK = """(function(){
  var d=document.querySelectorAll('.deck-row,[class*=deck-card]');
  if(!d.length) return 'NO DECKS';
  d[0].click(); return 'opened';
})()"""

# Card rows in the LIST, excluding anything inside the inspector pane.
ROWS = """(function(){
  return [].slice.call(document.querySelectorAll('button')).filter(function(e){
    return e.querySelector('img') && (e.innerText||'').trim().length>3
           && !e.closest('.card-inspector');
  }).length;
})()"""

CLICK = """(function(){
  var rows=[].slice.call(document.querySelectorAll('button')).filter(function(e){
    return e.querySelector('img') && (e.innerText||'').trim().length>3
           && !e.closest('.card-inspector');
  });
  var r=rows[%d];
  if(!r) return 'NO ROW';
  r.scrollIntoView({block:'center'});
  var n=(r.innerText||'').split('\\n')[0].trim();
  window.__calls=[];
  r.click();
  return n;
})()"""

# A leaf element holding a real paragraph. Rules text is the only prose of that
# length in the pane; badges and labels are far shorter.
CHECK = """(function(){
  var insp=document.querySelector('.card-inspector');
  if(!insp) return JSON.stringify({err:'no inspector'});
  var blocks=[].slice.call(insp.querySelectorAll('div,p')).map(function(e){
    return e.childElementCount===0 ? (e.innerText||'').trim() : '';
  }).filter(function(s){ return s.length>35; });
  return JSON.stringify({
    len:(blocks[0]||'').length,
    sample:(blocks[0]||'').slice(0,50),
    calls:(window.__calls||[])
  });
})()"""


def main():
    target = new_target(PORT, URL + '?nc=' + str(int(time.time())))
    c = Conn(target['webSocketDebuggerUrl'])
    c.send('Emulation.setDeviceMetricsOverride', width=1473, height=736,
           deviceScaleFactor=1, mobile=False)

    # THROTTLE, because the bug is "sometimes" and a tailnet-local request
    # completes in ~20ms. Zach uses this on a phone; a request that lands
    # before the first paint on my wire lands well after it on his. SLOW=1
    # applies a 3G-ish profile and 4x CPU slowdown, which is the condition the
    # skill already says to measure at.
    if os.environ.get('SLOW') == '1':
        c.send('Network.enable')
        c.send('Network.emulateNetworkConditions', offline=False,
               latency=400, downloadThroughput=400 * 1024 / 8,
               uploadThroughput=400 * 1024 / 8)
        c.send('Emulation.setCPUThrottlingRate', rate=4)
        print('throttled: 400ms latency, 400kbps, 4x CPU')
    time.sleep(9)
    c.eval(LOGIN)
    time.sleep(13)
    print('hook:', c.eval(HOOK))
    print('nav:', c.eval(GO_DECKS))
    time.sleep(8)
    print('deck:', c.eval(OPEN_DECK))
    time.sleep(10)

    total = c.eval(ROWS) or 0
    print('card rows in list:', total)

    checked, missing, blank_early = [], [], []
    # RAPID SWITCHING is the pattern he actually uses: tap down a deck list,
    # card after card, without waiting. The component has an explicit
    # `switching` branch that renders a bare object while a fetch is in flight,
    # so consecutive fast taps are the most likely way to land on a blank pane.
    rapid_blank = []
    for i in range(min(int(total), 30)):
        name = c.eval(CLICK % i)
        if name in ('NO ROW', None):
            continue
        # TWO SAMPLES. The early one is what Zach's eyes see right after a
        # tap; the settled one is what the code eventually renders. A card that
        # is blank early and filled late is not "working" -- it is a race he
        # experiences as "the description just doesnt show up", because he has
        # already moved on by the time it lands.
        time.sleep(0.4)
        try:
            early = json.loads(c.eval(CHECK))
        except Exception:
            early = {'len': 0}
        time.sleep(3.2 if os.environ.get('SLOW') == '1' else 1.6)
        try:
            d = json.loads(c.eval(CHECK))
        except Exception as exc:
            d = {'len': 0, 'err': str(exc)}
        checked.append((name, d.get('len', 0)))
        if not early.get('len'):
            blank_early.append((i, name, d.get('len', 0)))
        if not d.get('len'):
            missing.append((i, name, d.get('calls')))

    print()
    print('checked: %d' % len(checked))
    print('MISSING description: %d' % len(missing))
    for i, n, calls in missing:
        print('  [%d] %-38s /api/card calls: %s' % (i, n[:38], calls))
    if not missing:
        print('  (every card showed rules text on this pass)')
    # SECOND PASS: tap through consecutive cards with no settle at all.
    print()
    print('--- rapid pass: consecutive taps, sampled immediately')
    for i in range(min(int(total), 25)):
        name = c.eval(CLICK % i)
        if name in ('NO ROW', None):
            continue
        try:
            d = json.loads(c.eval(CHECK))
        except Exception:
            d = {'len': 0}
        if not d.get('len'):
            rapid_blank.append((i, name))
    print('BLANK on immediate sample: %d of 25' % len(rapid_blank))
    for i, n in rapid_blank[:15]:
        print('  [%d] %s' % (i, n[:44]))

    print()
    print('BLANK 400ms after the tap: %d of %d' % (len(blank_early), len(checked)))
    for i, n, final in blank_early[:12]:
        print('  [%d] %-38s blank early, %d chars once settled' % (i, n[:38], final))
    print()
    print('shortest 5:', sorted(checked, key=lambda x: x[1])[:5])


if __name__ == '__main__':
    main()
