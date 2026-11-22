#!/usr/bin/env python3
"""Copies the CURRENT data files from the live site into ./data so a code-only deploy does not wipe them.
Signs a session cookie with SESSION_SECRET (same scheme as netlify/edge-functions/gate.js) to get past the website key.
Stops with an error (so nothing gets deployed) if any state listed in index.json cannot be fetched."""
import gzip, hashlib, hmac, json, os, sys, time
import requests

site = os.environ["SITE_URL"].rstrip("/")
secret = os.environ["SESSION_SECRET"].strip()
out = os.environ.get("OUT_DIR", "data")
exp = int(time.time()) + 600
cookie = f"cm_session={exp}.{hmac.new(secret.encode(), ('sess' + str(exp)).encode(), hashlib.sha256).hexdigest()}"
S = requests.Session()
S.headers["cookie"] = cookie


def fetch(name, optional=False):
    for i in range(4):
        try:
            r = S.get(f"{site}/data/{name}", timeout=180)
        except requests.RequestException as e:
            print("  retry", name, e)
            time.sleep(2 ** i)
            continue
        if r.status_code == 200:
            return r.content
        if r.status_code == 404 and optional:
            return None
        if r.status_code == 401:
            sys.exit("401 from the site: SESSION_SECRET in GitHub does not match the one in Netlify.")
        print("  retry", name, r.status_code)
        time.sleep(2 ** i)
    sys.exit(f"Could not download {name}. Nothing was deployed.")


os.makedirs(out, exist_ok=True)
idx_raw = fetch("index.json")
idx = json.loads(idx_raw)
states = sorted(idx.get("states", {}))
if not states:
    sys.exit("index.json on the live site lists no states. Refusing to continue.")
saved = 0
for st in states:
    got = 0
    for name in (f"{st}.csv.gz", f"{st}-other.csv.gz"):
        body = fetch(name, optional=True)
        if body is None:
            continue
        if body[:2] != b"\x1f\x8b":          # server decompressed it on the way: compress again
            body = gzip.compress(body)
        open(os.path.join(out, name), "wb").write(body)
        got += 1
        saved += 1
    if idx["states"][st] and not got:
        sys.exit(f"No data file found for {st}. Nothing was deployed.")
for extra in ("diagnostics.json",):
    b = fetch(extra, optional=True)
    if b:
        open(os.path.join(out, extra), "wb").write(b)
open(os.path.join(out, "index.json"), "wb").write(idx_raw)
print(f"Copied {saved} data files for {len(states)} states from {site}")
