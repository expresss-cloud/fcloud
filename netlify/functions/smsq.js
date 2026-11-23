// Text-message queue (server side). The browser only hands over the list; sending continues on Netlify
// (sms-run-background.js) even when the page is closed.
//   POST {action:"start", account, from, text, pause, recipients:[{n,name,dot}]}  (max 200)
//   POST {action:"stop",  account, id}
//   GET  ?action=status&account=NAME[&id=JOB]      -> newest job of that user (or the given one)
//   GET  ?action=selftest                          -> checks that storage works (no code needed, writes nothing private)
// Every call except selftest needs that RingCentral user's access code (header x-access-code).
const crypto = require("crypto");
const { open } = require("./lib/blobs");
const { json, nameKey, checkCode, pick, e164 } = require("./lib/rc");

const runToken = (id, seq) => crypto.createHmac("sha256", process.env.SESSION_SECRET || "").update("run:" + id + ":" + seq).digest("hex");
const STALE_SEC = 240;

function view(meta, res) {
  const r = res || { pos: 0, results: [], beat: meta.created };
  let status = meta.status === "stopped" ? "stopped" : r.fin || "running";
  const stalled = status === "running" && (Date.now() - (r.beat || meta.created)) / 1000 > Math.max(STALE_SEC, meta.pause * 4 + 60);
  if (stalled) status = "stalled";
  const items = meta.recips.map((x, i) => ({ name: x.name, dot: x.dot, n: x.n, s: (r.results[i] || {}).s || "", e: (r.results[i] || {}).e || "", t: (r.results[i] || {}).t || "" }));
  return { id: meta.id, account: meta.account, from: meta.from, text: meta.text, pause: meta.pause, created: meta.created, total: meta.recips.length, status,
    sent: items.filter(x => x.s === "sent").length, failed: items.filter(x => x.s === "failed").length, error: r.err || "", items };
}
async function latest(st, account, id) {
  const jid = id || await st.get("latest-" + nameKey(account), { type: "text" });
  if (!jid) return null;
  const meta = await st.get("meta-" + jid, { type: "json" });
  if (!meta || meta.account !== account) return null;
  return { meta, res: await st.get("res-" + jid, { type: "json" }) };
}

exports.handler = async (ev) => {
  try {
    const H = ev.headers || {}, given = H["x-access-code"] || H["X-Access-Code"], q = ev.queryStringParameters || {};
    const st = open(ev);
    if (ev.httpMethod === "GET" && q.action === "selftest") {
      const k = "selftest-" + Date.now();
      await st.set(k, "ok"); const v = await st.get(k, { type: "text" }); await st.delete(k);
      return json(200, { storage: v === "ok" ? "working" : "wrong value", sessionSecretSet: (process.env.SESSION_SECRET || "").length >= 16 });
    }
    if (ev.httpMethod === "GET") {
      if (q.action !== "status") return json(400, { error: "Unknown action." });
      const a = pick(q.account); checkCode(a, given);
      const j = await latest(st, a.name, q.id ? String(q.id).replace(/[^a-z0-9-]/gi, "") : "");
      return json(200, { job: j ? view(j.meta, j.res) : null });
    }
    if (ev.httpMethod !== "POST") return json(405, { error: "Method not allowed." });
    const b = JSON.parse(ev.body || "{}"), a = pick(b.account); checkCode(a, given);

    if (b.action === "stop") {
      const j = await latest(st, a.name, String(b.id || "").replace(/[^a-z0-9-]/gi, ""));
      if (!j) return json(404, { error: "No text job found." });
      if (j.meta.status !== "stopped" && !(j.res && j.res.fin)) { j.meta.status = "stopped"; j.meta.stoppedAt = Date.now(); await st.setJSON("meta-" + j.meta.id, j.meta); }
      return json(200, { job: view(j.meta, j.res) });
    }

    if (b.action !== "start") return json(400, { error: "Unknown action." });
    const from = e164(b.from), text = String(b.text || "").trim(), pause = Math.min(120, Math.max(5, Math.round(+b.pause || 15)));
    if (!from) return json(400, { error: "Pick a valid sender number." });
    if (!text || text.length > 1000) return json(400, { error: "Message must be 1-1000 characters." });
    const seen = new Set(), recips = [];
    for (const r of Array.isArray(b.recipients) ? b.recipients : []) {
      const n = e164(r && r.n); if (!n || seen.has(n)) continue; seen.add(n);
      recips.push({ n, name: String((r && r.name) || "").slice(0, 120), dot: String((r && r.dot) || "").slice(0, 20) });
    }
    if (!recips.length) return json(400, { error: "No valid recipients." });
    if (recips.length > 200) return json(400, { error: "At most 200 recipients per batch." });
    if ((process.env.SESSION_SECRET || "").length < 16) return json(500, { error: "SESSION_SECRET is not set in Netlify." });
    const cur = await latest(st, a.name, "");
    if (cur) { const v = view(cur.meta, cur.res); if (v.status === "running") return json(409, { error: `${a.name} already has a text job running (${v.sent + v.failed} of ${v.total} done). Stop it first or wait until it finishes.`, job: v }); }

    const id = Date.now().toString(36) + crypto.randomBytes(4).toString("hex"), seq = 1;
    const meta = { id, account: a.name, from, text, pause, recips, status: "running", seq, created: Date.now() };
    await st.setJSON("meta-" + id, meta);
    await st.setJSON("res-" + id, { pos: 0, results: [], beat: Date.now() });
    await st.set("latest-" + nameKey(a.name), id);
    const host = H["x-forwarded-host"] || H.host || (process.env.URL || "").replace(/^https?:\/\//, "");
    let r;
    try { r = await fetch(`https://${host}/.netlify/functions/sms-run-background`, { method: "POST", headers: { "content-type": "application/json", "x-run-token": runToken(id, seq) }, body: JSON.stringify({ id, seq }) }); }
    catch (e) { r = { status: 0, statusText: e.message }; }
    if (r.status !== 202 && r.status !== 200) {
      meta.status = "stopped"; await st.setJSON("meta-" + id, meta);
      return json(502, { error: `Could not start the background sender (HTTP ${r.status}). Make sure the latest files are deployed (sms-run-background.js and the updated gate.js).` });
    }
    return json(200, { job: view(meta, { pos: 0, results: [], beat: Date.now() }) });
  } catch (e) {
    return json(e.status || 500, { error: e.message || "Server error" });
  }
};
