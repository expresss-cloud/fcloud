#!/usr/bin/env python3
"""
FMCSA nightly data job for the Carrier Map.

What it does, each run:
  1. Pulls the FMCSA Company Census File (data.transportation.gov, dataset az4n-8mr2) one state at a time.
  2. Optionally joins authority / insurance status from a Licensing & Insurance dataset (--li ...).
  3. Geocodes new or changed addresses with the free US Census batch geocoder (results are cached).
  4. Writes data/<ST>.csv.gz (active carriers) and data/<ST>-other.csv.gz (inactive/other) and data/index.json, replacing files atomically.
The CSVs use the column names the Carrier Map already imports (LATITUDE / LONGITUDE included).

Pending insurance cancellation comes from FMCSA's ActPendInsur dataset (cancel effective date).
Setup:   pip install requests
First look at a dataset's column names:   python fmcsa_nightly.py columns az4n-8mr2
Try one state:                            python fmcsa_nightly.py run --states UT --out data
Everything:                               python fmcsa_nightly.py run --out data
Nightly (cron, 3:15 am):                  15 3 * * *  cd /path/to/job && python3 fmcsa_nightly.py run --out /var/www/data >> job.log 2>&1

Optional environment variables:
  SOCRATA_APP_TOKEN  free token from data.transportation.gov; avoids throttling on big pulls
Your FMCSA QCMobile webKey is NOT needed for bulk data. Keep it for live single-carrier lookups on a server.
"""
import argparse, csv, gzip, io, json, os, re, sys, time, datetime as dt
import requests

BASE = "https://data.transportation.gov"
CENSUS = "az4n-8mr2"
GEO = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch"
HEADERS = {"X-App-Token": os.getenv("SOCRATA_APP_TOKEN", "")} if os.getenv("SOCRATA_APP_TOKEN") else {}
STATES = ("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY "
          "NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY").split()
# output column -> possible census field names (Socrata field names are lowercase)
ALIASES = {
    "DOT_NUMBER": ["dot_number", "usdot_number"], "LEGAL_NAME": ["legal_name"], "DBA_NAME": ["dba_name"],
    "PHY_STREET": ["phy_street", "phy_street1"], "PHY_CITY": ["phy_city"], "PHY_STATE": ["phy_state"],
    "PHY_ZIP": ["phy_zip"], "TELEPHONE": ["telephone", "phone"], "EMAIL_ADDRESS": ["email_address"],
    "STATUS_CODE": ["status_code"], "NBR_POWER_UNIT": ["nbr_power_unit", "power_units"],
    "DRIVER_TOTAL": ["driver_total", "total_drivers"], "HM_FLAG": ["hm_flag", "hm_ind"], "DOCKET1": ["docket1"], "CLASSDEF": ["classdef"],
    "OFFICER1": ["company_officer_1"], "OFFICER2": ["company_officer_2"],
    "CARRIER_OPERATION": ["carrier_operation"], "MCS150_DATE": ["mcs150_date"],
}


def get(url, **kw):
    for i in range(6):
        try:
            r = requests.get(url, headers=HEADERS, timeout=180, **kw)
            if r.status_code == 200:
                return r
            if r.status_code not in (429, 500, 502, 503, 504):
                r.raise_for_status()
        except requests.RequestException as e:
            print("  retry after error:", e, file=sys.stderr)
        time.sleep(2 ** i)
    sys.exit("Giving up on " + url)


def fields(ds):
    return [c["fieldName"] for c in get(f"{BASE}/api/views/{ds}/columns.json").json()]


def pull(ds, where=None, select=None, page=50000):
    off = 0
    while True:
        p = {"$limit": page, "$offset": off, "$order": ":id"}
        if where:
            p["$where"] = where
        if select:
            p["$select"] = select
        rows = get(f"{BASE}/resource/{ds}.json", params=p).json()
        yield from rows
        if len(rows) < page:
            return
        off += page


def pick(have, names):
    return next((n for n in names if n in have), None)


def geocode(items, cache, limit=10**9):
    """items: {key: (street, city, state, zip)}; fills cache[key] = [lat, lng] or None."""
    todo = [k for k in items if k not in cache][:limit]
    for i in range(0, len(todo), 5000):
        chunk = todo[i:i + 5000]
        buf = io.StringIO()
        w = csv.writer(buf)
        for n, k in enumerate(chunk):
            w.writerow([n, *items[k]])
        try:
            r = requests.post(GEO, files={"addressFile": ("a.csv", buf.getvalue())},
                              data={"benchmark": "Public_AR_Current"}, timeout=900)
        except requests.RequestException as e:
            print("  geocoder unreachable:", e, file=sys.stderr)
            return
        if r.status_code != 200:
            print("  geocoder error", r.status_code, file=sys.stderr)
            continue
        for row in csv.reader(io.StringIO(r.text)):
            try:
                k = chunk[int(row[0])]
            except (ValueError, IndexError):
                continue
            if len(row) > 5 and row[2] == "Match" and "," in row[5]:
                lon, lat = row[5].split(",")
                cache[k] = [float(lat), float(lon)]
            else:
                cache[k] = None
        print(f"  geocoded {min(i + 5000, len(todo))}/{len(todo)}")


def load_li(a):
    if not a.li:
        return {}
    cols = {"authority_status": a.li_auth, "insurance_status": a.li_ins, "cancel_effective_date": a.li_date}
    use = [c for c in cols.values() if c]
    if not a.li_dot or not use:
        sys.exit("--li needs --li-dot and at least one of --li-auth / --li-ins / --li-date (see: columns <dataset>)")
    have = fields(a.li)
    for c in [a.li_dot] + use:
        if c not in have:
            sys.exit(f"Column {c} not in {a.li}. Available: {', '.join(have)}")
    out = {}
    for r in pull(a.li, select=",".join([a.li_dot] + use)):
        d = str(r.get(a.li_dot, "")).lstrip("0")
        if d:
            out[d] = {k: r.get(v, "") for k, v in cols.items() if v}  # last row per DOT wins
    print(f"Loaded {len(out)} insurance/authority records")
    return out


def parse_date(s):
    s = str(s or "").strip()[:10]
    for fmt in ("%Y-%m-%d", "%m/%d/%Y"):
        try:
            return dt.datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    return None


DETAIL_RE = re.compile(r"insur|polic|effective|posted|limit|max|underl|company|form|type", re.I)
DIAG = {}
MATCH = [0, 0]


def _key(r, dot, dock):
    k = str(r.get(dot, "")).strip().lstrip("0") if dot else ""
    if not k and dock:
        dd = re.sub(r"\D", "", str(r.get(dock, ""))).lstrip("0")
        k = "mc" + dd if dd else ""
    return k


def _cols(have):
    dot = next((c for c in ("dot_number", "usdot_number", "usdot", "dot", "dot_no") if c in have), None) \
        or next((c for c in have if "dot" in c), None)
    return dot, next((c for c in have if "docket" in c), None)


def _first(cands, fn):
    diag = {"tried": []}
    for ds in cands:
        ds = ds.strip()
        if not ds:
            continue
        try:
            out, d = fn(ds)
        except (Exception, SystemExit) as e:
            diag["tried"].append({"dataset": ds, "error": (str(e) or repr(e))[:300]})
            print("Dataset", ds, "failed:", e, file=sys.stderr)
            continue
        diag["tried"].append({k: v for k, v in d.items() if k != "sample"})
        diag.setdefault("details", {})[ds] = d
        if out:
            diag["used"] = ds
            return out, diag
    return {}, diag


def _load_authority(ds):
    """Authority status history (Motus AuthHist). Latest status per authority type; last 'reinstated' date."""
    have = fields(ds)
    dot, dock = _cols(have)
    typ = next((c for c in have if "auth_type" in c or c.endswith("_type")), None)
    st = next((c for c in have if "auth_status" in c), None) or next((c for c in have if "status" in c and "date" not in c), None)
    rs = next((c for c in have if c == "reason" or "reason" in c), None)
    dc = next((c for c in have if "status_change_date" in c), None) or next((c for c in have if "date" in c), None)
    d = {"dataset": ds, "columns": have, "dot": dot, "docket": dock, "type": typ, "status": st, "reason": rs, "date": dc}
    print(f"Authority dataset {ds}: columns {', '.join(have)}")
    if not st or not dc or not (dot or dock):
        d["error"] = "could not find status, date and DOT/docket columns"
        return {}, d
    d["sample"] = get(f"{BASE}/resource/{ds}.json", params={"$limit": 3}).json()
    print("Authority sample rows:", json.dumps(d["sample"])[:700])
    sel = ",".join(dict.fromkeys(x for x in (dot, dock, typ, st, rs, dc) if x))
    latest, reinst, seen = {}, {}, 0
    for r in pull(ds, select=sel):
        seen += 1
        k = _key(r, dot, dock)
        day = parse_date(r.get(dc))
        if not k or not day:
            continue
        sv = str(r.get(st, "")).lower()
        tv = str(r.get(typ, "")) if typ else ""
        cur = latest.setdefault(k, {})
        if tv not in cur or day >= cur[tv][0]:
            cur[tv] = (day, sv)
        if rs and "reinstat" in str(r.get(rs, "")).lower() and day >= reinst.get(k, dt.date.min):
            reinst[k] = day
    out = {}
    for k, types in latest.items():
        act = any("active" in s and "inactive" not in s for _, s in types.values())
        out[k] = {"authority_status": "Active" if act else "Inactive", "reinstated_date": reinst[k].isoformat() if k in reinst else ""}
    d.update(rows=seen, carriers=len(out), active=sum(v["authority_status"] == "Active" for v in out.values()),
             reinstated=len(reinst))
    print(f"Authority rows: {seen}; carriers: {len(out)}; active: {d['active']}; with reinstated date: {len(reinst)}")
    return out, d


def _load_pending_auth(ds):
    """Suspension/revocation orders already served but not yet effective = authority pending cancellation."""
    have = fields(ds)
    dot, dock = _cols(have)
    ec = next((c for c in have if "effective" in c and "date" in c), None) or next((c for c in have if "effective" in c), None)
    d = {"dataset": ds, "columns": have, "dot": dot, "docket": dock, "effective": ec}
    print(f"Revoke/suspend dataset {ds}: columns {', '.join(have)}")
    if not ec or not (dot or dock):
        d["error"] = "could not find effective-date and DOT/docket columns"
        return {}, d
    d["sample"] = get(f"{BASE}/resource/{ds}.json", params={"$limit": 3}).json()
    today, out, seen = dt.date.today(), {}, 0
    for r in pull(ds, select=",".join(dict.fromkeys(x for x in (dot, dock, ec) if x))):
        seen += 1
        k, day = _key(r, dot, dock), parse_date(r.get(ec))
        if k and day and today <= day < dt.date(2100, 1, 1):
            o = out.setdefault(k, {"authority_status": "Pending cancellation", "ins_authority_pending_date": day.isoformat()})
            o["ins_authority_pending_date"] = min(o["ins_authority_pending_date"], day.isoformat())
    d.update(rows=seen, carriers=len(out))
    print(f"Revoke/suspend rows: {seen}; pending (future effective date): {len(out)}")
    return out, d


def load_authority(cands, pend_cands):
    out, diag = _first(cands, _load_authority)
    pend, pdiag = _first(pend_cands, _load_pending_auth)
    for k, v in pend.items():
        out.setdefault(k, {}).update(v)
    diag["pending_source"] = pdiag
    return out, diag


def _load_ins(ds):
    have = fields(ds)
    d = {"dataset": ds, "columns": have}
    dot = next((c for c in ("dot_number", "usdot_number", "usdot", "dot", "dot_no") if c in have), None) \
        or next((c for c in have if "dot" in c), None)
    dock = next((c for c in have if "docket" in c), None)
    canc = next((c for c in ("cancl_effective_date", "cancel_effective_date", "cancellation_date") if c in have), None) \
        or next((c for c in have if ("cancl" in c or "cancel" in c) and "date" in c), None)
    detail = [c for c in have if c not in (dot, dock, canc) and DETAIL_RE.search(c)][:8]
    d.update(dot=dot, docket=dock, cancel=canc, detail=detail)
    print(f"Insurance dataset {ds}: columns {', '.join(have)}")
    if not canc or not (dot or dock):
        d["error"] = "could not find a DOT/docket column and a cancel-date column"
        print("WARNING:", d["error"], file=sys.stderr)
        return {}, d
    d["sample"] = get(f"{BASE}/resource/{ds}.json", params={"$limit": 3}).json()
    print("Insurance sample rows:", json.dumps(d["sample"])[:900])
    today, out, seen, parsed = dt.date.today(), {}, 0, 0
    sel = ",".join(dict.fromkeys(x for x in [dot, dock, canc] + detail if x))
    for r in pull(ds, select=sel):
        seen += 1
        k = str(r.get(dot, "")).strip().lstrip("0") if dot else ""
        if not k and dock:
            dd = re.sub(r"\D", "", str(r.get(dock, ""))).lstrip("0")
            k = "mc" + dd if dd else ""
        if not k:
            continue
        o = out.setdefault(k, {"insurance_status": "Active", "cancel_effective_date": ""})
        for c in detail:
            v = str(r.get(c, "") or "").strip()
            if v:
                o["ins_" + c] = v
        c = parse_date(r.get(canc))
        if c:
            parsed += 1
        if c and today <= c < dt.date(2100, 1, 1):
            o["insurance_status"] = "Pending cancellation"
            if not o["cancel_effective_date"] or c.isoformat() < o["cancel_effective_date"]:
                o["cancel_effective_date"] = c.isoformat()
    d.update(rows=seen, with_cancel_date=parsed, carriers=len(out),
             pending=sum(v["insurance_status"] != "Active" for v in out.values()))
    print(f"Insurance rows read: {seen}; with a cancel date: {parsed}; carriers: {len(out)}; pending cancellation: {d['pending']}")
    return out, d


def load_insurance(candidates):
    return _first(candidates, _load_ins)


def run(a):
    os.makedirs(a.out, exist_ok=True)
    have = fields(CENSUS)
    m = {k: pick(have, v) for k, v in ALIASES.items()}
    for need in ("DOT_NUMBER", "LEGAL_NAME", "PHY_STATE"):
        if not m[need]:
            sys.exit(f"Census column for {need} not found. Run: columns {CENSUS}")
    print("Census columns used:", {k: v for k, v in m.items() if v})
    li = load_li(a)
    if not a.no_insurance:
        ins, dg = load_insurance(a.ins_dataset.split(","))
        DIAG.update(dg)
        for d, v in ins.items():
            li.setdefault(d, {}).update(v)
    if not a.no_authority:
        auth, DIAG["authority"] = load_authority(a.auth_dataset.split(","), a.pend_dataset.split(","))
        for d, v in auth.items():
            li.setdefault(d, {}).update(v)
    cpath = a.cache
    cache = json.load(open(cpath)) if os.path.exists(cpath) else {}
    if a.retry_misses:
        cache = {k: v for k, v in cache.items() if v}
    summary = {}
    for st in (a.states.split(",") if a.states else STATES):
        where = f"{m['PHY_STATE']}='{st}'"
        if a.status and m["STATUS_CODE"]:
            where += f" AND {m['STATUS_CODE']}='{a.status}'"
        print(f"{st}: pulling census ...")
        rows = [{k: (r.get(f) or "").strip() for k, f in m.items() if f} for r in pull(CENSUS, where=where)]
        if not a.no_geocode and m["PHY_STREET"]:
            items = {}
            for r in rows:
                key = "|".join(x.lower() for x in (r.get("PHY_STREET", ""), r.get("PHY_CITY", ""), st, r.get("PHY_ZIP", "")[:5]))
                r["_k"] = key
                if r.get("PHY_STREET") and (not a.geocode_status or r.get("STATUS_CODE") in a.geocode_status.split(",")):
                    items[key] = (r["PHY_STREET"], r.get("PHY_CITY", ""), st, r.get("PHY_ZIP", "")[:5])
            geocode(items, cache, a.max_geocode)
            json.dump(cache, open(cpath, "w"))
        extra = sorted({k for v in li.values() for k in v})
        cols = [k for k in ALIASES if m[k]] + ["LATITUDE", "LONGITUDE"] + extra
        for r in rows:
            g = cache.get(r.get("_k", "")) or ["", ""]
            r["LATITUDE"], r["LONGITUDE"] = g
            mc = re.sub(r"\D", "", r.get("DOCKET1", "")).lstrip("0")
            v = {}
            v.update(li.get("mc" + mc, {}) if mc else {})
            v.update(li.get(r["DOT_NUMBER"].lstrip("0"), {}))
            r.update(v)
            MATCH[0] += 1 if "insurance_status" in r else 0
            MATCH[1] += 1 if "authority_status" in r else 0
        act = [r for r in rows if r.get("STATUS_CODE", "A") == "A"]
        oth = [r for r in rows if r.get("STATUS_CODE", "A") != "A"]
        for name, part in ((st, act), (st + "-other", oth)):
            path = os.path.join(a.out, name + ".csv.gz")
            if not part:
                if os.path.exists(path):
                    os.remove(path)
                continue
            tmp = path + ".tmp"
            with gzip.open(tmp, "wt", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
                w.writeheader()
                w.writerows(part)
            os.replace(tmp, path)
        summary[st] = len(rows)
        print(f"{st}: wrote {len(act)} active + {len(oth)} other carriers")
    idx = os.path.join(a.out, "index.json")
    old = json.load(open(idx)).get("states", {}) if os.path.exists(idx) else {}
    old.update(summary)
    used = DIAG.get("used")
    d = DIAG.get("details", {}).get(used, {}) if used else {}
    summ = {"used": used, "carriers": d.get("carriers"), "pending": d.get("pending"), "matched": MATCH[0], "authority": {"used": DIAG.get("authority", {}).get("used"), "matched": MATCH[1], "pending_source": DIAG.get("authority", {}).get("pending_source", {}).get("used")},
            "error": None if used else "; ".join(f"{x.get('dataset')}: {x.get('error', 'no rows')}" for x in DIAG.get("tried", []))}
    json.dump({"updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "states": old, "insurance": summ}, open(idx, "w"))
    json.dump(DIAG, open(os.path.join(a.out, "diagnostics.json"), "w"), indent=1)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    s = p.add_subparsers(dest="cmd", required=True)
    c = s.add_parser("columns", help="list a dataset's column names")
    c.add_argument("dataset")
    r = s.add_parser("run", help="pull, geocode and write state files")
    r.add_argument("--out", default="data")
    r.add_argument("--states", help="comma list, e.g. UT,FL (default: all)")
    r.add_argument("--status", default="", help="only keep this census status code (default: all statuses)")
    r.add_argument("--geocode-status", default="A", help="comma list of status codes to geocode (default A = active; '' = all)")
    r.add_argument("--max-geocode", type=int, default=150000, help="max new addresses to geocode per run")
    r.add_argument("--cache", default="geocache.json")
    r.add_argument("--ins-dataset", default="c5y8-a4uz,qh9u-swkp,chgs-tx6x", help="comma list of insurance dataset ids (Motus first, then legacy); first that works is used")
    r.add_argument("--auth-dataset", default="yu5v-wbh6", help="authority history dataset (Motus AuthHist)")
    r.add_argument("--pend-dataset", default="wb4f-neki", help="revoke/suspend orders dataset (Motus RevokeSuspend)")
    r.add_argument("--no-authority", action="store_true")
    r.add_argument("--no-insurance", action="store_true")
    r.add_argument("--no-geocode", action="store_true")
    r.add_argument("--retry-misses", action="store_true", help="retry addresses the geocoder could not match")
    r.add_argument("--li", help="Licensing & Insurance dataset id to join by DOT number")
    r.add_argument("--li-dot"), r.add_argument("--li-auth"), r.add_argument("--li-ins"), r.add_argument("--li-date")
    a = p.parse_args()
    if a.cmd == "columns":
        print("\n".join(fields(a.dataset)))
    else:
        run(a)


if __name__ == "__main__":
    main()
