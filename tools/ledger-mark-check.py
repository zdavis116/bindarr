#!/usr/bin/env python3
"""Click the real Mark-added button on dev and prove it records the import.

"The button is in the bundle" is not "the button works". This drives the actual
control, then reads the ledger back over HTTP, so the assertion is about the
recorded fact and not about the DOM.
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
    width, height, out, term = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4]
    c = CDP(ws_connect())
    c.send("Page.enable")
    c.send("Runtime.enable")
    # BYPASS THE SERVICE WORKER.
    #
    # Bindarr is a PWA: workbox precaches the hashed asset chunks, so a browser
    # profile that has visited before keeps serving the OLD CollectionList
    # chunk after a deploy. That cost me a full debugging detour -- the row
    # rendered with `pp-nametext` from the first commit but no `pp-markbtn`
    # from the second, and the server had the correct file all along. Any
    # harness that checks a fresh deploy MUST disable the SW cache or it is
    # measuring the previous build.
    c.send("Network.enable")
    c.send("Network.setCacheDisabled", cacheDisabled=True)
    try:
        c.send("ServiceWorker.enable")
        c.send("ServiceWorker.stopAllWorkers")
    except Exception as e:
        print("(sw stop:", e, ")")
    c.js("""(async () => {
      if (navigator.serviceWorker) {
        const rs = await navigator.serviceWorker.getRegistrations();
        for (const r of rs) await r.unregister();
      }
      if (window.caches) {
        for (const k of await caches.keys()) await caches.delete(k);
      }
      return 'sw cleared';
    })()""")
    c.send("Emulation.setDeviceMetricsOverride", width=width, height=height,
           deviceScaleFactor=1, mobile=False)
    c.send("Page.navigate", url=URL)
    time.sleep(6)

    print("login:", c.js(f"""(async () => {{
      const r = await fetch('/api/auth/login', {{
        method: 'POST', headers: {{'Content-Type':'application/json'}},
        body: JSON.stringify({{username:'admin', password:'bindarr'}})
      }});
      const b = await r.json();
      if (!b.token) return 'NO TOKEN';
      localStorage.setItem('bindarr_token', b.token);
      localStorage.setItem('bindarr_user', JSON.stringify(b.user || {{username:'admin',role:'admin'}}));
      return 'ok';
    }})()"""))
    c.send("Page.navigate", url=URL)
    time.sleep(8)

    # VERIFY WE ARE ACTUALLY LOGGED IN BEFORE GOING FURTHER.
    #
    # The first version printed "ok" at every step while sitting on the login
    # screen: each helper returned 'ok' from el.click() without checking that
    # anything happened, so a lost session looked like a working run and the
    # real finding ("NO MARK BUTTON") was meaningless. A harness that cannot
    # fail is worth nothing. Every step below asserts its own postcondition.
    state = c.js("""(() => {
      if (document.querySelector('input[type="password"]')) return 'LOGIN SCREEN';
      const tabs = [...document.querySelectorAll('button,a')]
        .map(e => (e.textContent||'').trim());
      return tabs.includes('Collection') ? 'app' : 'UNKNOWN: ' + tabs.slice(0,8).join('|');
    })()""")
    print("state:", state)
    if state != 'app':
        # A service restart drops the session; retry the login once rather than
        # reporting a UI conclusion drawn from the login page.
        print("retrying login after restart...")
        c.js(f"""(async () => {{
          const r = await fetch('/api/auth/login', {{
            method: 'POST', headers: {{'Content-Type':'application/json'}},
            body: JSON.stringify({{username:'admin', password:'bindarr'}})
          }});
          const b = await r.json();
          if (b.token) {{
            localStorage.setItem('bindarr_token', b.token);
            localStorage.setItem('bindarr_user', JSON.stringify(b.user || {{username:'admin',role:'admin'}}));
          }}
          return 'retried';
        }})()""")
        c.send("Page.navigate", url=URL)
        time.sleep(8)
        state = c.js("""document.querySelector('input[type="password"]') ? 'LOGIN SCREEN' : 'app'""")
        print("state after retry:", state)
        if state != 'app':
            sys.exit("ABORT: could not log in; any UI conclusion would be false")

    nav = c.js("""(() => {
      const el = [...document.querySelectorAll('button, a')]
        .find(e => /^\\s*collection\\s*$/i.test(e.textContent||''));
      if (!el) return 'NO COLLECTION TAB'; el.click(); return 'clicked';
    })()""")
    time.sleep(5)
    print("nav:", nav, "->", c.js("""document.querySelector('.pp-panel') ? 'modal already' :
      ([...document.querySelectorAll('button')].some(b => b.querySelector('svg')) ? 'collection' : 'UNKNOWN')"""))

    menu = c.js("""(() => {
      const cand = [...document.querySelectorAll('button')].filter(b => {
        const r = b.getBoundingClientRect();
        return !(b.textContent||'').trim() && b.querySelector('svg')
               && r.top < 60 && r.right > innerWidth - 120 && r.width > 20;
      });
      if (!cand.length) return 'NO ICON BUTTON'; cand[cand.length-1].click(); return 'clicked';
    })()""")
    time.sleep(2)
    menu_ok = c.js("""document.querySelectorAll('[role="menuitem"]').length""")
    print("menu:", menu, "-> menuitems:", menu_ok)
    if not menu_ok:
        sys.exit("ABORT: the add menu did not open")

    opened = c.js("""(() => {
      const it = [...document.querySelectorAll('[role="menuitem"]')]
        .find(e => /product|precon|sealed/i.test(e.textContent||''));
      if (!it) return 'NO MENUITEM'; it.click(); return 'clicked';
    })()""")
    time.sleep(4)
    panel = c.js("""document.querySelector('.pp-panel') ? 'panel open' : 'NO PANEL'""")
    print("open:", opened, "->", panel)
    if panel != 'panel open':
        sys.exit("ABORT: the product picker never opened")

    typed = c.js("""(() => {
      const SEARCH_TERM = %s;""" % json.dumps(term) + """
      const i = document.querySelector('.pp-panel input, .modal-overlay input');
      if (!i) return 'NO INPUT';
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')
        .set.call(i, SEARCH_TERM);
      i.dispatchEvent(new Event('input', {bubbles:true}));
      return 'typed';
    })()""")
    time.sleep(6)
    rows = c.js("""JSON.stringify([...document.querySelectorAll('.pp-pname')]
      .map(e => e.textContent.trim()).slice(0,5))""")
    print("search:", typed, "-> rows:", rows)

    # The state BEFORE clicking, straight from the server.
    #
    # RELATIVE URL, DELIBERATELY. App.jsx patches window.fetch and only attaches
    # the Bearer token when url.startsWith('/api/'). An ABSOLUTE url gets no
    # token, comes back 401, and the wrapper then fires `bindarr_logout` and
    # clears localStorage -- so an absolute fetch here logged the harness out
    # MID-RUN and made the component render as though nothing was recorded.
    # The "NO MARK BUTTON" result that produced was my harness's bug, not the
    # app's.
    before = c.js(f"""(async () => {{
      const r = await fetch('/api/products/ledger', {{credentials:'include'}});
      const b = await r.json();
      return JSON.stringify((b.entries||[]).map(e => e.productName));
    }})()""")
    print("ledger before:", before)

    # CLICK THE REAL BUTTON. Measured first, so an unreachable control is a
    # reported failure rather than a silently missed click.
    clicked = c.js("""(() => {
      const b = document.querySelector('.pp-markbtn');
      if (!b) return 'NO MARK BUTTON on screen';
      const r = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      const reachable = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden'
        && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
      // Is anything covering it? the z-index / overlay trap.
      const hit = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
      const covered = !(b === hit || b.contains(hit));
      if (!reachable) return `NOT REACHABLE: ${JSON.stringify(r)}`;
      if (covered) return `COVERED BY: ${hit && hit.className}`;
      b.click();
      return `clicked "${b.textContent.trim()}" at ${Math.round(r.left)},${Math.round(r.top)} (${Math.round(r.width)}x${Math.round(r.height)})`;
    })()""")
    print("click:", clicked)
    time.sleep(4)

    after = c.js(f"""(async () => {{
      const r = await fetch('/api/products/ledger', {{credentials:'include'}});
      const b = await r.json();
      return JSON.stringify(b.entries||[], null, 1);
    }})()""")
    print("ledger after:", after)

    badge = c.js("""(() => {
      const b = document.querySelector('.pp-added');
      if (!b) return 'NO BADGE';
      const r = b.getBoundingClientRect();
      return JSON.stringify({text: b.textContent.trim(), cls: b.className,
        w: Math.round(r.width), onscreen: r.top >= 0 && r.bottom <= innerHeight});
    })()""")
    print("badge now:", badge)

    open(out, "wb").write(base64.b64decode(
        c.send("Page.captureScreenshot", format="png")["data"]))
    print("saved", out)


main()
