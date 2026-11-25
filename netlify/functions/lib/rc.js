// Shared RingCentral helpers (used by sms.js, smsq.js, sms-run-background.js).
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
  if (process.env.RC_JWT || process.env.TWILIO_ACCOUNT_SID) list.push({ name: (process.env.RC_MAIN_NAME || "Main").trim(), jwt: process.env.RC_JWT, main: true });
  for (const n of (process.env.RC_ACCOUNTS || "").split(",").map(s => s.trim()).filter(Boolean)) {
    const jwt = process.env["RC_JWT_" + nameKey(n)];
    if (!list.some(a => a.name.toLowerCase() === n.toLowerCase())) list.push({ name: n, jwt });
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
  if (!a.jwt) throw Object.assign(new Error(`${a.name} has no RingCentral login set up (RC_JWT${a.main ? "" : "_" + nameKey(a.name)}). Use Twilio for this user or add the RingCentral JWT.`), { status: 400 });
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

async function sendSms(a, from, to, text) {
  return rc(a, "/restapi/v1.0/account/~/extension/~/sms", { method: "POST", body: JSON.stringify({ from: { phoneNumber: from }, to: [{ phoneNumber: to }], text }) });
}
module.exports = { json, nameKey, checkCode, accounts, pick, rc, e164, sendSms };
