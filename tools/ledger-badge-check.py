#!/usr/bin/env python3
"""Render the product picker on dev and MEASURE the ledger badge.

Why not just look at a screenshot: "the badge is in the bundle" is not "the
badge is visible". This project's recurring failure is a control that renders
and is unreachable -- clipped by an ellipsis, behind a z-index, off the fold.
So this asserts geometry and computed style, and the screenshot is corroboration.

Measures at Zach's real desktop review width AND at his phone width, because
desktop bugs have shipped from phone-only checks here before.
"""
import json
import sys
import time
import base64
import urllib.request
import websocket

PORT = 9222
URL = "https://bindarr-dev.tail387aa3.ts.net"


def ws_connect():
    with urllib.request.urlopen(f"http://localhost:{PORT}/json") as r:
        targets = json.load(r)
    page = next(t for t in targets if t["type"] == "page")
    return websocket.create_connection(page["webSocketDebuggerUrl"],
                                       origin="http://localhost",
                                       suppress_origin=True, timeout=45)


class CDP:
    def __init__(self, ws):
        self.ws, self.i = ws, 0

    def send(self, method, **params):
        self.i += 1
        self.ws.send(json.dumps({"id": self.i, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.i:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})

    def js(self, expr):
        r = self.send("Runtime.evaluate", expression=expr,
                      returnByValue=True, awaitPromise=True)
        return r.get("result", {}).get("value")


def main():
    width, height, out = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
    c = CDP(ws_connect())
    c.send("Page.enable")
    c.send("Runtime.enable")
    # Resize via the emulation override, NOT --window-size: the media queries
    # read the viewport and --window-size does not move it.
    c.send("Emulation.setDeviceMetricsOverride", width=width, height=height,
           deviceScaleFactor=1, mobile=False)

    c.send("Page.navigate", url=URL)
    time.sleep(6)

    # Log in. The token lives in localStorage; the app reads it on boot.
    # The REAL storage keys, read out of App.jsx -- not guessed. The first
    # version wrote 'token' and the app sat on the login screen, because it
    # reads 'bindarr_token' AND 'bindarr_user'.
    tok = c.js(f"""(async () => {{
      const r = await fetch('{URL}/api/auth/login', {{
        method: 'POST', headers: {{'Content-Type':'application/json'}},
        body: JSON.stringify({{username:'admin', password:'bindarr'}})
      }});
      const b = await r.json();
      if (!b.token) return 'NO TOKEN: ' + JSON.stringify(b).slice(0,120);
      localStorage.setItem('bindarr_token', b.token);
      localStorage.setItem('bindarr_user', JSON.stringify(b.user || {{username:'admin', role:'admin'}}));
      return 'ok';
    }})()""")
    print("login:", tok)
    c.send("Page.navigate", url=URL)
    time.sleep(7)

    # NAVIGATE TO COLLECTION FIRST. The picker is opened from there; the app
    # boots on the Dashboard, where no add control exists at all.
    nav = c.js("""(() => {
      const el = [...document.querySelectorAll('button, a')]
        .find(e => /^\\s*collection\\s*$/i.test(e.textContent||''));
      if (!el) return 'NO COLLECTION TAB';
      el.click();
      return 'clicked Collection';
    })()""")
    print("nav:", nav)
    time.sleep(5)

    # THE ADD CONTROL IS AN ICON-ONLY BUTTON. It renders a lucide <Plus> and no
    # text at all, so every textContent match returns nothing -- confirmed by
    # looking at the rendered screenshot rather than guessing a fourth label.
    # Find it by its SVG icon in the header, next to "Select".
    menu = c.js("""(() => {
      const btns = [...document.querySelectorAll('button')];
      const cand = btns.filter(b => {
        const r = b.getBoundingClientRect();
        // The + sits in the TITLE row (y~38), above the search row (y~94)
        // which holds a sort button at the same right edge. Bound the top
        // tightly or the sort control is clicked instead -- measured, not
        // assumed.
        return !(b.textContent||'').trim() && b.querySelector('svg')
               && r.top < 60 && r.right > innerWidth - 120 && r.width > 20;
      });
      if (!cand.length) return 'NO ICON BUTTON in header';
      cand[cand.length - 1].click();
      const r = cand[cand.length - 1].getBoundingClientRect();
      return `clicked icon button at ${Math.round(r.left)},${Math.round(r.top)}`;
    })()""")
    print("menu:", menu)
    time.sleep(2)

    opened = c.js("""(() => {
      const items = [...document.querySelectorAll('[role="menuitem"]')];
      const it = items.find(e => /product|precon|sealed/i.test(e.textContent||''));
      if (!it) return 'NO MENUITEM: ' + items.map(e=>(e.textContent||'').trim()).join(' | ').slice(0,300);
      it.click();
      return 'clicked: ' + (it.textContent||'').trim().slice(0,60);
    })()""")
    print("open:", opened)
    time.sleep(4)

    # Search for the product we really imported. Overridable so the LONG-NAME
    # case can be measured too -- that is the one the .pp-pname flex change
    # exists for, and a short name would never exercise it.
    term = sys.argv[4] if len(sys.argv) > 4 else 'jump scare'
    typed = c.js("""(() => {
      const SEARCH_TERM = %s;""" % json.dumps(term) + """
      const i = document.querySelector('.pp-panel input, .modal-overlay input');
      if (!i) return 'NO INPUT';
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      set.call(i, SEARCH_TERM);
      i.dispatchEvent(new Event('input', {bubbles:true}));
      return 'typed';
    })()""")
    print("search:", typed)
    time.sleep(6)

    report = c.js("""(() => {
      const badges = [...document.querySelectorAll('.pp-added')];
      const out = badges.map(b => {
        const r = b.getBoundingClientRect();
        const cs = getComputedStyle(b);
        const row = b.closest('.pp-prod') || b.closest('.pp-edopt');
        const rr = row ? row.getBoundingClientRect() : null;
        return {
          text: b.textContent.trim(),
          cls: b.className,
          w: Math.round(r.width), h: Math.round(r.height),
          x: Math.round(r.left), y: Math.round(r.top),
          colour: cs.color,
          visible: r.width > 0 && r.height > 0 &&
                   cs.visibility !== 'hidden' && cs.display !== 'none' &&
                   parseFloat(cs.opacity) > 0.05,
          onscreen: r.left >= 0 && r.top >= 0 &&
                    r.right <= innerWidth && r.bottom <= innerHeight,
          // CLIPPED BY THE ROW? the exact failure the CSS change prevents.
          clipped: rr ? (r.right > rr.right + 1) : null,
        };
      });
      return JSON.stringify({
        viewport: innerWidth + 'x' + innerHeight,
        badgeCount: badges.length,
        badges: out,
        rows: [...document.querySelectorAll('.pp-pname')].slice(0,6)
                .map(e => e.textContent.trim()),
      }, null, 1);
    })()""")
    print(report)

    png = c.send("Page.captureScreenshot", format="png")["data"]
    open(out, "wb").write(base64.b64decode(png))
    print("saved", out)


main()
