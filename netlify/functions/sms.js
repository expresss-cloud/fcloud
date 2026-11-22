// RingCentral SMS gateway for the Carrier Map. Runs on Netlify Functions (server-side), so the
// RingCentral credentials never reach the browser. Supports several RingCentral users ("accounts").
//   GET  ?action=accounts                    -> names of the configured RingCentral users
//   GET  ?action=numbers&account=NAME        -> SMS-capable numbers of that user
//   POST {account,from,to,text}              -> sends one text message as that user
// Every RingCentral user has their OWN access code, so nobody can send from somebody else's phone number.
// Netlify variables: RC_CLIENT_ID, RC_CLIENT_SECRET, RC_SERVER_URL (optional)
//   Main user:  RC_JWT  + SMS_ACCESS_CODE   (shown as "Main", or RC_MAIN_NAME; its code may also be RC_CODE_MAIN)
//   More users: RC_ACCOUNTS=Alice,Bob  plus  RC_JWT_ALICE, RC_JWT_BOB  and their codes  RC_CODE_ALICE, RC_CODE_BOB
//               (variable name = prefix + NAME in capitals). A user with no code set cannot be used.
const crypto = require("crypto");
const SERVER = (process.env.RC_SERVER_URL || "https://platform.ringcentral.com").replace(/\/$/, "");
const tokens = {};   // cached access tokens per account name

const json = (code, obj) => ({ statusCode: code, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(obj) });

const nameKey = n => String(n).toUpperCase().replace(/[^A-Z0-9]/g, "_");
const codeFor = a => process.env["RC_CODE_" + nameKey(a.name)] || (a.main ? process.env.SMS_ACCESS_CODE : "") || "";
const fails = {};   // wrong-code counter per user (kept while the function stays warm)
function checkCode(a, given) {
  const want = codeFor(a), f = fails[a.name] || (fails[a.name] = { n: 0, until: 0 });
  if (!want) throw Object.assign(new Error(`No access code is set for ${a.name} in Netlify (RC_CODE_${nameKey(a.name)}).`), { status: 403 });
  if (Date.now() < f.until) throw Object.assign(new Error("Too many wrong codes. Try again in a few minutes."), { status: 429 });
  const h = v => crypto.createHash("sha256").update(String(v)).digest();
  if (given && crypto.timingSafeEqual(h(given), h(want))) { f.n = 0; return; }
  if (++f.n >= 8) { f.until = Date.now() + 5 * 60000; f.n = 0; }
  throw Object.assign(new Error(`Wrong access code for ${a.name}.`), { status: 401 });
}

function accounts() {
  const list = [];
  if (process.env.RC_JWT) list.push({ name: (process.env.RC_MAIN_NAME || "Main").trim(), jwt: process.env.RC_JWT, main: true });
  for (const n of (process.env.RC_ACCOUNTS || "").split(",").map(s => s.trim()).filter(Boolean)) {
    const jwt = process.env["RC_JWT_" + nameKey(n)];
    if (jwt && !list.some(a => a.name.toLowerCase() === n.toLowerCase())) list.push({ name: n, jwt });
  }
  return list;
}
function pick(name) {
  const list = accounts();
  if (!list.length) throw Object.assign(new Error("No RingCentral user is configured in Netlify (set RC_JWT, or RC_ACCOUNTS plus RC_JWT_<NAME>)."), { status: 500 });
  const a = name ? list.find(x => x.name.toLowerCase() === String(name).toLowerCase()) : list[0];
  if (!a) throw Object.assign(new Error("Unknown RingCentral user: " + String(name).slice(0, 40)), { status: 400 });
  return a;
}

async function token(a) {
  const t = tokens[a.name];
  if (t && Date.now() < t.exp - 60000) return t.value;
  const { RC_CLIENT_ID: id, RC_CLIENT_SECRET: sec } = process.env;
  if (!id || !sec) throw Object.assign(new Error("RingCentral app credentials are not set in Netlify (RC_CLIENT_ID, RC_CLIENT_SECRET)."), { status: 500 });
  const r = await fetch(SERVER + "/restapi/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic " + Buffer.from(id + ":" + sec).toString("base64") },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: a.jwt }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`RingCentral login failed for ${a.name}: ` + (j.error_description || j.message || r.status)), { status: 502 });
  tokens[a.name] = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tokens[a.name].value;
}

async function rc(a, path, opt = {}) {
  const r = await fetch(SERVER + path, { ...opt, headers: { authorization: "Bearer " + (await token(a)), "content-type": "application/json", ...(opt.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || j.error_description || "RingCentral error " + r.status), { status: r.status === 429 ? 429 : 502, rc: j });
  return j;
}

const e164 = v => { const d = String(v || "").replace(/\D/g, ""); return d.length === 10 ? "+1" + d : d.length === 11 && d[0] === "1" ? "+" + d : ""; };

exports.handler = async (ev) => {
  try {
    const q = ev.queryStringParameters || {}, given = (ev.headers || {})["x-access-code"] || (ev.headers || {})["X-Access-Code"];
    if (ev.httpMethod === "GET") {
      if (q.action === "accounts") return json(200, { accounts: accounts().map(a => a.name) });   // names only, no code needed
      if (q.action !== "numbers") return json(400, { error: "Unknown action." });
      const a = pick(q.account);
      checkCode(a, given);
      let recs = [], page = 1;
      for (;;) {
        const j = await rc(a, `/restapi/v1.0/account/~/extension/~/phone-number?perPage=100&page=${page}`);
        recs = recs.concat(j.records || []);
        if (!j.navigation || !j.navigation.nextPage) break;
        page++;
      }
      const numbers = recs.filter(n => (n.features || []).includes("SmsSender") && n.phoneNumber)
        .map(n => ({ number: n.phoneNumber, label: n.label || "", type: n.usageType || "", location: n.location || "" }));
      return json(200, { account: a.name, numbers, total: recs.length });
    }
    if (ev.httpMethod === "POST") {
      const b = JSON.parse(ev.body || "{}"), a = pick(b.account);
      checkCode(a, given);
      const from = e164(b.from), to = e164(b.to), text = String(b.text || "").trim();
      if (!from) return json(400, { error: "Pick a valid sender number." });
      if (!to) return json(400, { error: "Invalid recipient number." });
      if (!text || text.length > 1000) return json(400, { error: "Message must be 1-1000 characters." });
      const j = await rc(a, "/restapi/v1.0/account/~/extension/~/sms", { method: "POST", body: JSON.stringify({ from: { phoneNumber: from }, to: [{ phoneNumber: to }], text }) });
      return json(200, { id: j.id, status: j.messageStatus, to, account: a.name });
    }
    return json(405, { error: "Method not allowed." });
  } catch (e) {
    return json(e.status || 500, { error: e.message || "Server error" });
  }
};
