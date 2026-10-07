#!/usr/bin/env python3
"""Does the picker really list added products first? Read the rendered order."""
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

width, height, out = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
send("Page.enable"); send("Runtime.enable")
# The PWA service worker will otherwise serve the previous build.
send("Network.enable"); send("Network.setCacheDisabled", cacheDisabled=True)
try:
    send("ServiceWorker.enable"); send("ServiceWorker.stopAllWorkers")
except Exception: pass
js("""(async () => {
  if (navigator.serviceWorker) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
})()""")
send("Emulation.setDeviceMetricsOverride", width=width, height=height,
     deviceScaleFactor=1, mobile=False)
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
time.sleep(7)

print("ledger:", js("""(async () => {
  const r = await fetch('/api/products/ledger', {credentials:'include'});
  const b = await r.json();
  return JSON.stringify((b.entries||[]).map(e=>e.productName));
})()"""))

# THE DEFAULT VIEW -- no search term, the whole catalogue newest-first. This is
# the case the request is about: "when on precon view".
report = js("""(() => {
  const rows = [...document.querySelectorAll('.pp-prodrow')];
  const data = rows.map(r => ({
    name: (r.querySelector('.pp-nametext')||{}).textContent,
    badge: (r.querySelector('.pp-added')||{}).textContent || null,
    y: Math.round(r.getBoundingClientRect().top),
  }));
  const addedIdx = data.map((d,i)=>d.badge?i:-1).filter(i=>i>=0);
  const plainIdx = data.map((d,i)=>d.badge?-1:i).filter(i=>i>=0);
  return JSON.stringify({
    rows: data.length,
    order: data.map(d => (d.badge ? '* ' : '  ') + d.name),
    lastAdded: addedIdx.length ? Math.max(...addedIdx) : null,
    firstPlain: plainIdx.length ? Math.min(...plainIdx) : null,
    CORRECT: !addedIdx.length || !plainIdx.length
      || Math.max(...addedIdx) < Math.min(...plainIdx),
  }, null, 1);
})()""")
print(report)
open(out, "wb").write(base64.b64decode(send("Page.captureScreenshot", format="png")["data"]))
print("saved", out)
