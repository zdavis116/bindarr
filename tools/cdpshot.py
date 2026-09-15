#!/usr/bin/env python3
"""Point a headless Chrome at a URL, resize it, run JS, save a PNG.

Why this exists: the browser-use harness only attaches to a Chrome it launched
itself, and the build VM has no desktop session. Zach finds layout bugs on
DESKTOP that 390x844 checks never exercise, so verifying real rendered geometry
at a real desktop width is not optional -- this is the smallest thing that does
it. Usage:

    python3 tools/cdpshot.py <url> <width> <height> <out.png> [js ...]

Each JS expression is evaluated after load and its result printed, one per line.
"""
import json
import sys
import time
import base64
import urllib.request

import websocket  # websocket-client


def cdp_targets(port):
    with urllib.request.urlopen(f"http://localhost:{port}/json") as r:
        return json.load(r)


def new_target(port, url):
    # PUT, not GET: newer Chrome refuses the GET form of /json/new.
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
        self.ws.send(json.dumps({"id": self.n, "method": method,
                                 "params": params}))
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


def main():
    url, w, h, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
    exprs = sys.argv[5:]
    port = 9222

    t = new_target(port, url)
    c = Conn(t["webSocketDebuggerUrl"])
    c.send("Page.enable")
    # Device metrics override, not --window-size: the window flag does not
    # resize an already-running browser, and the CSS media query keys off the
    # viewport. This is the thing the breakpoint actually reads.
    c.send("Emulation.setDeviceMetricsOverride", width=w, height=h,
           deviceScaleFactor=1, mobile=False)
    c.send("Page.navigate", url=url)
    time.sleep(4)

    for e in exprs:
        print(c.eval(e))

    shot = c.send("Page.captureScreenshot", format="png", captureBeyondViewport=True)
    with open(out, "wb") as f:
        f.write(base64.b64decode(shot["data"]))
    print(f"saved {out}")


if __name__ == "__main__":
    main()
