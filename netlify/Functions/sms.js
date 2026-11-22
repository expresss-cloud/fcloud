// RingCentral SMS gateway for the Carrier Map. Runs on Netlify Functions (server-side), so the
// RingCentral credentials never reach the browser.
//   GET  /.netlify/functions/sms?action=numbers   -> SMS-capable numbers of the connected RingCentral extension
//   POST /.netlify/functions/sms  {from,to,text}  -> sends one text message
// Every request must carry the header  x-access-code: <SMS_ACCESS_CODE>  (set in Netlify), because the
// site itself is public and this endpoint spends money.
// Netlify environment variables: RC_CLIENT_ID, RC_CLIENT_SECRET, RC_JWT, RC_SERVER_URL (optional), SMS_ACCESS_CODE
const crypto = require("crypto");
const SERVER = (process.env.RC_SERVER_URL || "https://platform.ringcentral.com").replace(/\/$/, "");
let tok = { value: "", exp: 0 };

const json = (code, obj) => ({ statusCode: code, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(obj) });

function codeOk(given) {
  const want = process.env.SMS_ACCESS_CODE || "";
  if (!want || !given) return false;
  const a = crypto.createHash("sha256").update(String(given)).digest(), b = crypto.createHash("sha256").update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

async function token() {
  if (tok.value && Date.now() < tok.exp - 60000) return tok.value;
  const { RC_CLIENT_ID: id, RC_CLIENT_SECRET: sec, RC_JWT: jwt } = process.env;
  if (!id || !sec || !jwt) throw Object.assign(new Error("RingCentral credentials are not set in Netlify (RC_CLIENT_ID, RC_CLIENT_SECRET, RC_JWT)."), { status: 500 });
  const r = await fetch(SERVER + "/restapi/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic " + Buffer.from(id + ":" + sec).toString("base64") },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error("RingCentral login failed: " + (j.error_description || j.message || r.status)), { status: 502 });
  tok = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tok.value;
}

async function rc(path, opt = {}) {
  const r = await fetch(SERVER + path, { ...opt, headers: { authorization: "Bearer " + (await token()), "content-type": "application/json", ...(opt.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || j.error_description || "RingCentral error " + r.status), { status: r.status === 429 ? 429 : 502, rc: j });
  return j;
}

const e164 = v => { const d = String(v || "").replace(/\D/g, ""); return d.length === 10 ? "+1" + d : d.length === 11 && d[0] === "1" ? "+" + d : ""; };

exports.handler = async (ev) => {
  try {
    if (!codeOk(ev.headers["x-access-code"] || ev.headers["X-Access-Code"])) return json(401, { error: "Wrong or missing access code." });
    if (ev.httpMethod === "GET") {
      if ((ev.queryStringParameters || {}).action !== "numbers") return json(400, { error: "Unknown action." });
      let recs = [], page = 1;
      for (;;) {
        const j = await rc(`/restapi/v1.0/account/~/extension/~/phone-number?perPage=100&page=${page}`);
        recs = recs.concat(j.records || []);
        if (!j.navigation || !j.navigation.nextPage) break;
        page++;
      }
      const numbers = recs.filter(n => (n.features || []).includes("SmsSender") && n.phoneNumber)
        .map(n => ({ number: n.phoneNumber, label: n.label || "", type: n.usageType || "", location: n.location || "" }));
      return json(200, { numbers, total: recs.length });
    }
    if (ev.httpMethod === "POST") {
      const b = JSON.parse(ev.body || "{}"), from = e164(b.from), to = e164(b.to), text = String(b.text || "").trim();
      if (!from) return json(400, { error: "Pick a valid sender number." });
      if (!to) return json(400, { error: "Invalid recipient number." });
      if (!text || text.length > 1000) return json(400, { error: "Message must be 1-1000 characters." });
      const j = await rc("/restapi/v1.0/account/~/extension/~/sms", { method: "POST", body: JSON.stringify({ from: { phoneNumber: from }, to: [{ phoneNumber: to }], text }) });
      return json(200, { id: j.id, status: j.messageStatus, to });
    }
    return json(405, { error: "Method not allowed." });
  } catch (e) {
    return json(e.status || 500, { error: e.message || "Server error" });
  }
};
