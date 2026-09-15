#!/usr/bin/env python3
"""Drive real mouse events in headless Chrome via CDP, then screenshot.

Why this exists: `element.dispatchEvent(new MouseEvent(...))` is NOT proof a
hover works -- it bypasses hit-testing, so it fires happily on an element that
is behind another one, off-screen, or zero-sized. Zach's bugs are repeatedly
"it renders but you cannot reach it", which synthetic events cannot catch.

Input.dispatchMouseEvent goes through Chrome's real hit-testing at viewport
coordinates, so if something is covering the target, this misses it too --
which is the point.

    python3 tools/cdpdrive.py <url> <w> <h> <out.png> <step> [step ...]

A step is one of:
    move:<css selector>     move the real pointer to that element's centre
    click:<css selector>    move and click
    eval:<js expression>    evaluate and print
    wait:<seconds>
"""
import base64
import json
import sys
import time
import urllib.request

import websocket  # websocket-client


def new_target(port, url):
    req = urllib.request.Request(f"http://localhost:{port}/json/new?{url}",
                                 method="PUT")
    with urllib.request.urlopen(req) as r:
        return json.load(r)


class Conn:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=30)
        self.n = 0

    def send(self, method, **params):
        self.n += 1
        self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.n:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})

    def eval(self, expr):
        r = self.send("Runtime.evaluate", expression=expr,
                      returnByValue=True, awaitPromise=True)
        if r.get("exceptionDetails"):
            return f"JS ERROR: {r['exceptionDetails'].get('text')}"
        return r.get("result", {}).get("value")

    def centre(self, selector):
        """Viewport centre of an element, or None if it is not hit-testable."""
        box = self.eval(f"""(() => {{
            const el = document.querySelector({json.dumps(selector)});
            if (!el) return null;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return null;
            return {{x: r.left + r.width/2, y: r.top + r.height/2}};
        }})()""")
        return box

    def move(self, selector):
        c = self.centre(selector)
        if not c:
            print(f"  MISS: {selector} has no hit-testable box")
            return False
        self.send("Input.dispatchMouseEvent", type="mouseMoved",
                  x=c["x"], y=c["y"], buttons=0)
        return True

    def click(self, selector):
        if not self.move(selector):
            return False
        c = self.centre(selector)
        for t in ("mousePressed", "mouseReleased"):
            self.send("Input.dispatchMouseEvent", type=t, x=c["x"], y=c["y"],
                      button="left", buttons=1, clickCount=1)
        return True


def main():
    url, w, h, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
    steps = sys.argv[5:]

    t = new_target(9222, url)
    c = Conn(t["webSocketDebuggerUrl"])
    c.send("Page.enable")
    c.send("Emulation.setDeviceMetricsOverride", width=w, height=h,
           deviceScaleFactor=1, mobile=False)
    c.send("Page.navigate", url=url)
    time.sleep(3.5)

    for step in steps:
        kind, _, arg = step.partition(":")
        if kind == "move":
            print(f"move {arg}: {'ok' if c.move(arg) else 'MISS'}")
            time.sleep(0.35)
        elif kind == "click":
            print(f"click {arg}: {'ok' if c.click(arg) else 'MISS'}")
            time.sleep(0.45)
        elif kind == "eval":
            print(c.eval(arg))
        elif kind == "wait":
            time.sleep(float(arg))

    shot = c.send("Page.captureScreenshot", format="png")
    with open(out, "wb") as f:
        f.write(base64.b64decode(shot["data"]))
    print(f"saved {out}")


if __name__ == "__main__":
    main()
