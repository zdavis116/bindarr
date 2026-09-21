#!/usr/bin/env python3
# REPRODUCE: the whole card detail pane disappears.
#
# Zach, corrected: "the whole modal doesnt popup and it happens sporadically
# like if I click a card and scroll to the bottom and then click a land card
# the whole side panel or card modal disappears"
#
# So the symptom is NOT a blank description -- it is the entire pane vanishing.
# That is a different failure with a different cause, and my first probe was
# measuring the wrong thing entirely.
#
# The suspect, from DeckView.jsx:121:
#
#     const pick = selectedCardId ? cards.find(...) : null;
#     const fallback = cards.find(c => c.board === 'commander') || cards[0];
#     const chosen = pick || fallback;
#
# `chosen` DOES fall back... but only helps when the find succeeds. If
# selectedCardId names a row that is not in `cards` -- after a refresh, a
# repoint that renumbers deck_cards rows, or a sync -- pick is null and the
# fallback catches it. So the null pane must come from somewhere else:
# `detailCard` null, or the tab==='curve' gate, or cards being briefly empty.
#
# This walks his exact steps and records the pane's presence at each one.
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

GO_DECKS = """(function(){
  var t=[].slice.call(document.querySelectorAll('.nav-tab,.nav-rail-item'))
    .filter(function(x){return /Decks/i.test(x.innerText||'');})[0];
  if(t){t.click(); return 'ok';} return 'no tab';
})()"""

OPEN_DECK = """(function(){
  var d=document.querySelectorAll('.deck-row,[class*=deck-card]');
  if(!d.length) return 'NO DECKS';
  d[0].click(); return 'opened';
})()"""

ROWS = """(function(){
  return [].slice.call(document.querySelectorAll('button')).filter(function(e){
    return e.querySelector('img') && (e.innerText||'').trim().length>3
           && !e.closest('.card-inspector');
  }).length;
})()"""

# Click the Nth row and report what it was.
CLICK = """(function(){
  var rows=[].slice.call(document.querySelectorAll('button')).filter(function(e){
    return e.querySelector('img') && (e.innerText||'').trim().length>3
           && !e.closest('.card-inspector');
  });
  var r=rows[%d];
  if(!r) return 'NO ROW';
  r.scrollIntoView({block:'center'});
  var n=(r.innerText||'').split('\\n')[0].trim();
  r.click();
  return n;
})()"""

# THE PANE ITSELF -- present or gone. This is the actual symptom.
PANE = """(function(){
  var side=document.querySelector('.deck-panes-side');
  var insp=document.querySelector('.card-inspector');
  var r = side ? side.getBoundingClientRect() : null;
  var ir = insp ? insp.getBoundingClientRect() : null;
  return JSON.stringify({
    side: !!side,
    inspector: !!insp,
    inspectorText: insp ? (insp.innerText||'').trim().length : 0,
    w: r ? Math.round(r.width) : 0,
    h: r ? Math.round(r.height) : 0,
    top: r ? Math.round(r.top) : 0,
    // A pane that renders offscreen is gone as far as he is concerned.
    onscreen: !!(ir && ir.width > 0 && ir.height > 0
                 && ir.bottom > 0 && ir.top < innerHeight
                 && ir.right > 0 && ir.left < innerWidth)
  });
})()"""

SCROLL_BOTTOM = """(function(){
  var list=document.querySelector('.deck-panes-main');
  if(list){ list.scrollTop = list.scrollHeight; }
  window.scrollTo(0, document.body.scrollHeight);
  return 'scrolled';
})()"""

# Find a LAND row specifically -- his repro names one.
LAND_INDEX = """(function(){
  var rows=[].slice.call(document.querySelectorAll('button')).filter(function(e){
    return e.querySelector('img') && (e.innerText||'').trim().length>3
           && !e.closest('.card-inspector');
  });
  for(var i=rows.length-1;i>=0;i--){
    var t=(rows[i].innerText||'');
    if(/Island|Swamp|Mountain|Forest|Plains|Tower|Passage|Refuge|Gate/i.test(t)) return i;
  }
  return -1;
})()"""


def pane(c, label):
    try:
        d = json.loads(c.eval(PANE))
    except Exception:
        d = {}
    # GONE means he cannot see it: absent OR rendered offscreen.
    gone = (not d.get('inspector')) or (not d.get('onscreen'))
    why = ''
    if not d.get('inspector'):
        why = '   <<< PANE ABSENT'
    elif not d.get('onscreen'):
        why = '   <<< PANE OFFSCREEN'
    print('  %-34s insp=%s text=%-4s box=%sx%s top=%s%s'
          % (label, d.get('inspector'), d.get('inspectorText'),
             d.get('w'), d.get('h'), d.get('top'), why))
    return gone


def main():
    target = new_target(PORT, URL + '?nc=' + str(int(time.time())))
    c = Conn(target['webSocketDebuggerUrl'])
    W = int(os.environ.get('W', '1473'))
    H = int(os.environ.get('H', '736'))
    c.send('Emulation.setDeviceMetricsOverride', width=W, height=H,
           deviceScaleFactor=1, mobile=False)
    print('viewport %dx%d' % (W, H))
    if os.environ.get('SLOW') == '1':
        c.send('Network.enable')
        c.send('Network.emulateNetworkConditions', offline=False, latency=400,
               downloadThroughput=400 * 1024 / 8, uploadThroughput=400 * 1024 / 8)
        c.send('Emulation.setCPUThrottlingRate', rate=4)
        print('throttled')
    time.sleep(9)
    c.eval(LOGIN)
    time.sleep(13)
    c.eval(GO_DECKS)
    time.sleep(8)
    print('deck:', c.eval(OPEN_DECK))
    time.sleep(10)

    total = int(c.eval(ROWS) or 0)
    land = int(c.eval(LAND_INDEX) or -1)
    print('rows: %d | a land sits at index %d' % (total, land))
    print()

    failures = 0
    # HIS EXACT SEQUENCE, repeated: click a card near the top, scroll to the
    # bottom, click a land. Repeated because he said "sporadically" -- one pass
    # proves nothing either way.
    for attempt in range(8):
        print('attempt %d' % (attempt + 1))
        name = c.eval(CLICK % (attempt % 5))
        time.sleep(1.2)
        pane(c, 'after clicking %s' % str(name)[:22])

        c.eval(SCROLL_BOTTOM)
        time.sleep(0.8)
        pane(c, 'after scrolling to bottom')

        if land >= 0:
            lname = c.eval(CLICK % land)
            time.sleep(1.2)
            if pane(c, 'after clicking land %s' % str(lname)[:18]):
                failures += 1
        print()

    print('PANE VANISHED in %d of 8 attempts' % failures)


if __name__ == '__main__':
    main()
