#!/usr/bin/env python3
"""Open the Mana Pool order screen and read what the card rows actually say."""
import json, sys, time, base64, urllib.request, websocket

PORT, URL = 9222, "https://bindarr-dev.tail387aa3.ts.net"
with urllib.request.urlopen(f"http://localhost:{PORT}/json") as r:
    page = next(t for t in json.load(r) if t["type"] == "page")
ws = websocket.create_connection(page["webSocketDebuggerUrl"], origin="http://localhost",
                                 suppress_origin=True, timeout=45)
i = 0
def send(m, **p):
    global i; i += 1
    ws.send(json.dumps({"id": i, "method": m, "params": p}))
    while True:
        r = json.loads(ws.recv())
        if r.get("id") == i: return r.get("result", {})
def js(e):
    return send("Runtime.evaluate", expression=e, returnByValue=True,
                awaitPromise=True).get("result", {}).get("value")

w, h, out = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
send("Page.enable"); send("Runtime.enable")
send("Network.enable"); send("Network.setCacheDisabled", cacheDisabled=True)
try:
    send("ServiceWorker.enable"); send("ServiceWorker.stopAllWorkers")
except Exception: pass
js("""(async () => {
  if (navigator.serviceWorker) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
})()""")
send("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=1, mobile=False)
send("Page.navigate", url=URL); time.sleep(6)
js("""(async () => {
  const r = await fetch('/api/auth/login', {method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({username:'admin',password:'bindarr'})});
  const b = await r.json();
  localStorage.setItem('bindarr_token', b.token);
  localStorage.setItem('bindarr_user', JSON.stringify(b.user||{username:'admin',role:'admin'}));
})()""")
send("Page.navigate", url=URL); time.sleep(9)
assert js("""document.querySelector('input[type="password"]') ? 0 : 1""") == 1, "NOT LOGGED IN"

js("""[...document.querySelectorAll('button,a')].find(e=>/^\\s*collection\\s*$/i.test(e.textContent||'')).click()""")
time.sleep(5)
js("""(() => {const c=[...document.querySelectorAll('button')].filter(b=>{const r=b.getBoundingClientRect();
  return !(b.textContent||'').trim()&&b.querySelector('svg')&&r.top<60&&r.right>innerWidth-120&&r.width>20;});
  c[c.length-1].click();})()""")
time.sleep(2)
js("""[...document.querySelectorAll('[role="menuitem"]')].find(e=>/product|precon|sealed/i.test(e.textContent||'')).click()""")
time.sleep(5)

# Switch to the ORDERS source, and WAIT for the precon rows to be replaced.
# Orders come from a different endpoint, so the old .pp-prodrow elements linger
# for a moment -- clicking too early opens a PRECON and the whole check then
# describes the wrong screen.
print("orders chip:", js("""(() => {
  const b = [...document.querySelectorAll('.pp-panel button')]
    .find(e => /order/i.test(e.textContent||''));
  if (!b) return 'NO ORDERS CHIP';
  b.click(); return 'clicked ' + b.textContent.trim();
})()"""))
time.sleep(8)

state = js("""(() => {
  const ord = [...document.querySelectorAll('.pp-panel button')]
    .filter(b => /647851|order \\d/i.test(b.textContent||''));
  return JSON.stringify({
    orderButtons: ord.map(b => b.textContent.trim().slice(0, 60)),
    stillPrecons: document.querySelectorAll('.pp-prodrow').length,
  });
})()""")
print("after chip:", state)

ORDER_NO = sys.argv[4] if len(sys.argv) > 4 else "647851"
print("order row:", js("""(() => {
  // THE SPECIFIC ORDER, by number. A loose /order \\d/ matched the FIRST order
  // in the list (568998), and the check then described an order with no
  // imports at all -- where taken:null is CORRECT. A false negative that looks
  // exactly like a broken feature.
  const want = %s;
  const b = [...document.querySelectorAll('.pp-panel button')]
    .find(e => (e.textContent||'').includes(want));
  if (!b) return 'NO ROW FOR ORDER ' + want;
  b.click(); return 'opened: ' + b.textContent.trim().slice(0, 50);
})()""" % json.dumps(ORDER_NO)))
time.sleep(8)

print(js("""(() => {
  const rows = [...document.querySelectorAll('.pp-row')].filter(r => !r.classList.contains('pp-row-bad'));
  return JSON.stringify({
    cardRows: rows.length,
    rows: rows.map(r => ({
      name: (r.querySelector('.pp-cname')||{}).textContent,
      taken: (r.querySelector('.pp-taken')||{}).textContent || null,
      ticked: !!(r.querySelector('input')||{}).checked,
      dimmed: r.classList.contains('pp-row-taken'),
    })),
    toAdd: (document.querySelector('.pp-bignum')||{}).textContent,
  }, null, 1);
})()"""))
open(out, "wb").write(base64.b64decode(send("Page.captureScreenshot", format="png")["data"]))
print("saved", out)
