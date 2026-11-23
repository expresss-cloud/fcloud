// Background sender (Netlify "-background" function, may run up to 15 minutes). Sends the queued texts one by one with
// the chosen pause, checking before EVERY text whether the job was stopped. Long jobs hand over to a fresh run.
const crypto = require("crypto");
const { open } = require("./lib/blobs");
const { accounts, sendSms } = require("./lib/rc");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const RUN_MS = +process.env.SMS_RUN_MS || 12 * 60 * 1000;

exports.handler = async (ev) => {
  const t0 = Date.now();
  const H = ev.headers || {}, b = JSON.parse(ev.body || "{}"), id = String(b.id || "").replace(/[^a-z0-9-]/gi, ""), seq = +b.seq;
  const want = crypto.createHmac("sha256", process.env.SESSION_SECRET || "").update("run:" + id + ":" + seq).digest();
  const got = Buffer.from(String(H["x-run-token"] || ""), "hex");
  if (!id || !process.env.SESSION_SECRET || got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { statusCode: 401 };
  const st = open(ev);
  const meta0 = await st.get("meta-" + id, { type: "json" });
  if (!meta0) return { statusCode: 404 };
  const acct = accounts().find(x => x.name === meta0.account);
  let res = (await st.get("res-" + id, { type: "json" })) || { pos: 0, results: [] };
  const live = async () => { const m = await st.get("meta-" + id, { type: "json" }); return m && m.status === "running" && m.seq === seq; };
  const save = async () => { res.beat = Date.now(); await st.setJSON("res-" + id, res); };

  if (!acct) { res.fin = "failed"; res.err = "RingCentral user no longer configured."; await save(); return { statusCode: 200 }; }
  while (res.pos < meta0.recips.length) {
    if (!(await live())) return { statusCode: 200 };                                  // stopped (or superseded)
    if (Date.now() - t0 > RUN_MS) {                                                    // hand over to a fresh 15-minute run
      const host = H["x-forwarded-host"] || H.host;
      await save();
      await fetch(`https://${host}/.netlify/functions/sms-run-background`, { method: "POST", headers: { "content-type": "application/json", "x-run-token": ev.headers["x-run-token"] }, body: JSON.stringify({ id, seq }) });
      return { statusCode: 200 };
    }
    const r = meta0.recips[res.pos]; let rec = { s: "sent", e: "", t: new Date().toISOString() };
    for (let a = 0; a < 3; a++) {
      try { await sendSms(acct, meta0.from, r.n, meta0.text); break; }
      catch (e) {
        if (e.status === 429 && a < 2) { await sleep(8000 * (a + 1)); continue; }
        rec = { s: "failed", e: String(e.message || e).slice(0, 300), t: new Date().toISOString() }; break;
      }
    }
    res.results[res.pos] = rec; res.pos++;
    if (rec.s === "failed" && /credential|login failed|not set|permission/i.test(rec.e)) { res.fin = "failed"; res.err = rec.e; await save(); return { statusCode: 200 }; }
    await save();
    if (res.pos >= meta0.recips.length) break;
    const total = meta0.pause * 1000 * (0.7 + Math.random() * 0.6);
    for (let w = 0; w < total; w += 3000) { await sleep(Math.min(3000, total - w)); if (!(await live())) return { statusCode: 200 }; }
  }
  res.fin = "done"; await save();
  return { statusCode: 200 };
};
