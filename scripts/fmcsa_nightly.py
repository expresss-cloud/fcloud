#!/usr/bin/env python3
"""
FMCSA nightly data job for the Carrier Map.

Each run, for every state:
  1. Pulls the Company Census File (az4n-8mr2) - ALL statuses (active, inactive, other).
  2. Joins insurance:  Motus Insur (c5y8-a4uz, current filings) + Motus InsHist (3uet-3z4i, cancelled/replaced policies)
  3. Joins authority:  Motus AuthHist (yu5v-wbh6, status history) + Motus RevokeSuspend (wb4f-neki, pending suspensions)
  4. Geocodes addresses with the free US Census geocoder (cached between runs).
  5. Writes data/<ST>.csv.gz (active carriers), data/<ST>-other.csv.gz (inactive/other), data/index.json, data/diagnostics.json

Commands:
  python fmcsa_nightly.py run --states UT --out data      one state
  python fmcsa_nightly.py run --out data                  everything
  python fmcsa_nightly.py probe                           print columns + sample rows of the FMCSA datasets
  python fmcsa_nightly.py columns <dataset-id>

Optional env var: SOCRATA_APP_TOKEN (free, from data.transportation.gov) avoids throttling.
"""
import argparse, csv, gzip, io, json, os, re, sys, time, datetime as dt
import requests

BASE = "https://data.transportation.gov"
CENSUS = "az4n-8mr2"
GEO = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch"
HEADERS = {"X-App-Token": os.getenv("SOCRATA_APP_TOKEN", "")} if os.getenv("SOCRATA_APP_TOKEN") else {}
STATES = ("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY "
          "NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY").split()
# output column -> census field
ALIASES = {
    "DOT_NUMBER": "dot_number", "LEGAL_NAME": "legal_name", "DBA_NAME": "dba_name",
    "PHY_STREET": "phy_street", "PHY_CITY": "phy_city", "PHY_STATE": "phy_state", "PHY_ZIP": "phy_zip",
    "TELEPHONE": "phone", "EMAIL_ADDRESS": "email_address", "STATUS_CODE": "status_code",
    "NBR_POWER_UNIT": "power_units", "DRIVER_TOTAL": "total_drivers", "HM_FLAG": "hm_ind",
    "CARRIER_OPERATION": "carrier_operation", "MCS150_DATE": "mcs150_date",
    "DOCKET1PREFIX": "docket1prefix", "DOCKET1": "docket1", "CLASSDEF": "classdef",
    "OFFICER1": "company_officer_1", "OFFICER2": "company_officer_2",
}
DIAG = {}
MATCH = [0, 0, 0, 0, 0]   # insurance matched, authority matched, insurance pending, authority pending, insurance cancelled


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


def parse_date(s):
    s = str(s or "").strip()
    m = re.match(r"(\d{4})-(\d{1,2})-(\d{1,2})", s) or re.match(r"(\d{4})(\d{2})(\d{2})(?!\d)", s)
    if m:
        y, mo, d = map(int, m.groups())
    else:
        m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", s)
        if not m:
            return None
        mo, d, y = map(int, m.groups())
    try:
        return dt.date(y, mo, d)
    except ValueError:
        return None


def docket_key(v):
    """'MC-424836' / 'MC424836' / ('MC','424836') -> 'mc424836'; keeps MC and FF numbers apart."""
    m = re.match(r"\s*([A-Za-z]{2})\W*0*(\d+)", str(v or ""))
    return m.group(1).lower() + m.group(2) if m else ""


def key_of(r):
    k = str(r.get("usdot_number") or r.get("dot_number") or "").strip().lstrip("0")
    return k or docket_key(r.get("docket_number"))


def money(v):
    try:
        return f"{float(v):,.0f}"
    except (TypeError, ValueError):
        return ""


# ---------------------------------------------------------------- insurance
def _is_bipd(r):
    return ("91" in str(r.get("ins_form_code", "")) or str(r.get("ins_type_code", "")) == "1"
            or "BIPD" in str(r.get("ins_type_desc", "")).upper())


def load_insurance(active_ds, hist_ds):
    """Status per carrier from liability (BIPD) filings.
       Active               = a current filing exists and no future-dated cancellation of it
       Pending cancellation = cancellation notice with an effective date still in the future
       Cancelled            = no current filing; last policy ended (cancel date in the past)"""
    diag, today = {"active_dataset": active_ds, "history_dataset": hist_ds}, dt.date.today()
    stores = {}
    for role, ds in (("active", active_ds), ("history", hist_ds)):
        st = stores[role] = {}
        try:
            print(f"Insurance {role} dataset {ds} columns:", ", ".join(fields(ds)))
            n = 0
            for r in pull(ds):
                n += 1
                k = key_of(r)
                if k:
                    st.setdefault(k, {"b": [], "o": []})["b" if _is_bipd(r) else "o"].append(r)
            diag[role + "_filings"] = {"rows": n, "carriers": len(st)}
            print(f"Insurance {role}: {n} rows, {len(st)} carriers")
        except (Exception, SystemExit) as e:
            diag[role + "_filings"] = {"error": (str(e) or repr(e))[:300]}
            print(f"Insurance {role} dataset {ds} failed: {e}", file=sys.stderr)
    out = {}
    for k in set(stores["active"]) | set(stores["history"]):
        c, h = stores["active"].get(k, {}), stores["history"].get(k, {})
        g = "b" if (c.get("b") or h.get("b")) else "o"
        act, past = c.get(g, []), h.get(g, [])
        cd = lambda x: parse_date(x.get("cancl_effective_date"))
        if act:
            src = max(act, key=lambda x: parse_date(x.get("effective_date")) or dt.date.min)
            pols = {str(x.get("policy_no", "")).strip() for x in act}
            pend = [cd(x) for x in past if cd(x) and cd(x) >= today and "CANCEL" in str(x.get("filing_status_reason", "")).upper()
                    and str(x.get("policy_no", "")).strip() in pols]
            status, cdate, reason = ("Pending cancellation", min(pend).isoformat(), "CANCEL") if pend else ("Active", "", "")
        else:
            dated = [(cd(x), x) for x in past if cd(x) and "CANCEL" in str(x.get("filing_status_reason", "")).upper()]
            if not dated:
                continue
            day, src = max(dated, key=lambda t: t[0])
            status, cdate, reason = ("Pending cancellation" if day >= today else "Cancelled"), day.isoformat(), str(src.get("filing_status_reason", ""))
        eff = parse_date(src.get("effective_date"))
        row = {"insurance_status": status, "cancel_effective_date": cdate,
               "ins_insurer": src.get("insurance_company_name", ""), "ins_policy_no": src.get("policy_no", ""),
               "ins_liability_limit": money(src.get("max_cov_amount")), "ins_underlying_limit": money(src.get("underl_lim_amount")),
               "ins_effective_date": eff.isoformat() if eff else "", "ins_form": src.get("ins_form_code", ""),
               "ins_cancel_reason": reason}
        out[k] = {a: b for a, b in row.items() if b != ""}
        out[k]["insurance_status"], out[k]["cancel_effective_date"] = status, cdate
    vals = [v["insurance_status"] for v in out.values()]
    diag.update(carriers=len(out), active=vals.count("Active"), pending=vals.count("Pending cancellation"), cancelled=vals.count("Cancelled"))
    print(f"Insurance result: {len(out)} carriers; active {diag['active']}, pending cancellation {diag['pending']}, cancelled {diag['cancelled']}")
    return out, diag


# ---------------------------------------------------------------- authority
def load_authority(auth_ds, order_ds):
    """Authority status from the status-change history, plus pending suspensions from served orders."""
    diag, today, out = {"dataset": auth_ds, "orders": order_ds}, dt.date.today(), {}
    try:
        print(f"Authority dataset {auth_ds} columns:", ", ".join(fields(auth_ds)))
        rank = {"pending": 0, "active": 2}
        latest, reinst, n = {}, {}, 0
        for r in pull(auth_ds):
            n += 1
            k, day = key_of(r), parse_date(r.get("status_change_date"))
            if not k or not day:
                continue
            tv = str(r.get("docket_number", "")) + "|" + str(r.get("op_auth_type", ""))
            s = str(r.get("op_auth_status", "")).strip().lower()
            cur = latest.setdefault(k, {})
            if tv not in cur or (day, rank.get(s, 1)) >= cur[tv][0]:
                cur[tv] = ((day, rank.get(s, 1)), s)
            if "reinstat" in str(r.get("reason", "")).lower() and day >= reinst.get(k, dt.date.min):
                reinst[k] = day
        for k, types in latest.items():
            sts = [s for _, s in types.values()]
            status = "Active" if "active" in sts else "Application pending" if "pending" in sts else "Inactive"
            out[k] = {"authority_status": status}
            if k in reinst:
                out[k]["reinstated_date"] = reinst[k].isoformat()
        diag.update(rows=n, carriers=len(out))
        print(f"Authority history: {n} rows, {len(out)} carriers")
    except (Exception, SystemExit) as e:
        diag["error"] = (str(e) or repr(e))[:300]
        print(f"Authority dataset {auth_ds} failed: {e}", file=sys.stderr)
    try:
        pend, n = {}, 0
        for r in pull(order_ds):
            n += 1
            k, day = key_of(r), parse_date(r.get("order1_effective_date"))
            if k and day and today <= day < dt.date(2100, 1, 1) and (k not in pend or day < pend[k][0]):
                pend[k] = (day, str(r.get("order1_type_desc", "")))
        for k, (day, desc) in pend.items():
            if out.get(k, {}).get("authority_status", "Active") == "Active":
                out.setdefault(k, {}).update(authority_status="Pending cancellation", ins_authority_pending_date=day.isoformat(),
                                             ins_authority_pending_type=desc)
        diag["orders_rows"], diag["pending_orders"] = n, len(pend)
        print(f"Suspension/revocation orders: {n} rows; pending (future effective date): {len(pend)}")
    except (Exception, SystemExit) as e:
        diag["orders_error"] = (str(e) or repr(e))[:300]
        print(f"Orders dataset {order_ds} failed: {e}", file=sys.stderr)
    vals = [v.get("authority_status") for v in out.values()]
    diag.update(active=vals.count("Active"), inactive=vals.count("Inactive"), pending_cancellation=vals.count("Pending cancellation"),
                application_pending=vals.count("Application pending"))
    return out, diag


# ---------------------------------------------------------------- geocoding
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


# ---------------------------------------------------------------- main run
def run(a):
    os.makedirs(a.out, exist_ok=True)
    have = fields(CENSUS)
    m = {k: (v if v in have else None) for k, v in ALIASES.items()}
    for need in ("DOT_NUMBER", "LEGAL_NAME", "PHY_STATE"):
        if not m[need]:
            sys.exit(f"Census column for {need} not found. Run: columns {CENSUS}")
    select = ",".join(f for f in m.values() if f)
    li = {}
    if not a.no_insurance:
        ins, DIAG["insurance"] = load_insurance(a.ins_dataset, a.ins_hist_dataset)
        for k, v in ins.items():
            li.setdefault(k, {}).update(v)
    if not a.no_authority:
        auth, DIAG["authority"] = load_authority(a.auth_dataset, a.pend_dataset)
        for k, v in auth.items():
            li.setdefault(k, {}).update(v)
    extra = sorted({c for v in li.values() for c in v})
    cols = [k for k in ALIASES if m[k]] + ["LATITUDE", "LONGITUDE"] + extra
    cache = json.load(open(a.cache)) if os.path.exists(a.cache) else {}
    if a.retry_misses:
        cache = {k: v for k, v in cache.items() if v}
    summary = {}
    for st in (a.states.split(",") if a.states else STATES):
        where = f"{m['PHY_STATE']}='{st}'"
        if a.status and m["STATUS_CODE"]:
            where += f" AND {m['STATUS_CODE']}='{a.status}'"
        print(f"{st}: pulling census ...")
        rows = [{k: str(r.get(f) or "").strip() for k, f in m.items() if f} for r in pull(CENSUS, where=where, select=select)]
        if not a.no_geocode and m["PHY_STREET"]:
            items = {}
            gs = a.geocode_status.split(",") if a.geocode_status else None
            for r in rows:
                key = "|".join(x.lower() for x in (r.get("PHY_STREET", ""), r.get("PHY_CITY", ""), st, r.get("PHY_ZIP", "")[:5]))
                r["_k"] = key
                if r.get("PHY_STREET") and (not gs or r.get("STATUS_CODE") in gs):
                    items[key] = (r["PHY_STREET"], r.get("PHY_CITY", ""), st, r.get("PHY_ZIP", "")[:5])
            geocode(items, cache, a.max_geocode)
            json.dump(cache, open(a.cache, "w"))
        for r in rows:
            g = cache.get(r.get("_k", "")) or ["", ""]
            r["LATITUDE"], r["LONGITUDE"] = g
            v = {}
            mc = docket_key(r.get("DOCKET1PREFIX", "") + r.get("DOCKET1", "")) if r.get("DOCKET1") else ""
            v.update(li.get(mc, {}) if mc else {})
            v.update(li.get(r["DOT_NUMBER"].lstrip("0"), {}))
            r.update(v)
            MATCH[0] += "insurance_status" in r
            MATCH[1] += "authority_status" in r
            MATCH[2] += r.get("insurance_status") == "Pending cancellation"
            MATCH[3] += r.get("authority_status") == "Pending cancellation"
            MATCH[4] += r.get("insurance_status") == "Cancelled"
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
    di, da = DIAG.get("insurance", {}), DIAG.get("authority", {})
    ins_err = "; ".join(f"{r}: {di[r + '_filings']['error']}" for r in ("active", "history") if "error" in di.get(r + "_filings", {})) if di else "not run"
    summ = {"used": None if (not di or di.get("carriers") is None or not di.get("carriers")) else f"{di['active_dataset']} + {di['history_dataset']}",
            "carriers": di.get("carriers"), "pending": MATCH[2], "cancelled": MATCH[4], "matched": MATCH[0], "skipped": ins_err or None,
            "error": ins_err or ("" if MATCH[0] else "no insurance rows matched"),
            "authority": {"used": a.auth_dataset if da.get("carriers") else None, "matched": MATCH[1], "pending": MATCH[3],
                          "error": da.get("error") or ("" if da.get("carriers") else "no authority rows read")}}
    json.dump({"updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "states": old, "insurance": summ}, open(idx, "w"))
    json.dump(DIAG, open(os.path.join(a.out, "diagnostics.json"), "w"), indent=1)


PROBE_DEFAULT = "az4n-8mr2,c5y8-a4uz,x96h-evps,3uet-3z4i,yu5v-wbh6,dm5j-zc6c,wb4f-neki,inys-ebih,qh9u-swkp"


def probe(a):
    lines = ["# FMCSA dataset probe", ""]
    for ds in a.datasets.split(","):
        ds = ds.strip()
        lines += [f"## {ds}"]
        try:
            cols = get(f"{BASE}/api/views/{ds}/columns.json").json()
            lines.append("columns: " + ", ".join(f"{c['fieldName']} ({c.get('dataTypeName', '?')})" for c in cols))
        except (Exception, SystemExit) as e:
            lines += [f"COLUMNS FAILED: {e}", ""]
            continue
        for label, params in (("row count", {"$select": "count(*)"}), ("first rows", {"$limit": 3}),
                              ("later rows", {"$limit": 3, "$offset": 200000})):
            try:
                lines.append(f"{label}: " + json.dumps(get(f"{BASE}/resource/{ds}.json", params=params).json())[:2500])
            except (Exception, SystemExit) as e:
                lines.append(f"{label} FAILED: {e}")
        lines.append("")
    text = "\n".join(lines)
    print(text)
    summ = os.getenv("GITHUB_STEP_SUMMARY")
    if summ:
        with open(summ, "a", encoding="utf-8") as f:
            f.write(text.replace("\n", "\n\n"))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    s = p.add_subparsers(dest="cmd", required=True)
    pr = s.add_parser("probe", help="print columns and sample rows of datasets")
    pr.add_argument("--datasets", default=PROBE_DEFAULT)
    c = s.add_parser("columns", help="list a dataset's column names")
    c.add_argument("dataset")
    r = s.add_parser("run", help="pull, join, geocode and write state files")
    r.add_argument("--out", default="data")
    r.add_argument("--states", help="comma list, e.g. UT,FL (default: all)")
    r.add_argument("--status", default="", help="only keep this census status code (default: all statuses)")
    r.add_argument("--geocode-status", default="A", help="comma list of status codes to geocode (default A; '' = all)")
    r.add_argument("--max-geocode", type=int, default=150000, help="max new addresses to geocode per run")
    r.add_argument("--cache", default="geocache.json")
    r.add_argument("--no-geocode", action="store_true")
    r.add_argument("--retry-misses", action="store_true")
    r.add_argument("--ins-dataset", default="c5y8-a4uz", help="Motus Insur (current filings)")
    r.add_argument("--ins-hist-dataset", default="3uet-3z4i", help="Motus InsHist (cancelled / replaced policies)")
    r.add_argument("--auth-dataset", default="yu5v-wbh6", help="Motus AuthHist")
    r.add_argument("--pend-dataset", default="wb4f-neki", help="Motus RevokeSuspend")
    r.add_argument("--no-insurance", action="store_true")
    r.add_argument("--no-authority", action="store_true")
    a = p.parse_args()
    if a.cmd == "probe":
        probe(a)
    elif a.cmd == "columns":
        print("\n".join(fields(a.dataset)))
    else:
        run(a)


if __name__ == "__main__":
    main()
