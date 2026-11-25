// Twilio SMS (second texting provider next to RingCentral). SendGrid itself only does email; Twilio is SendGrid's parent company.
// Netlify variables: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN (or an API key: TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET with the account SID)
//   Numbers each user may send from (comma separated, +1…): main user TWILIO_FROM, other users TWILIO_FROM_<NAME>
const { nameKey, e164 } = require("./rc");

function twNumbers(a) {
  const raw = process.env["TWILIO_FROM_" + nameKey(a.name)] || (a.main ? process.env.TWILIO_FROM : "") || "";
  return raw.split(",").map(x => e164(x.trim())).filter(Boolean);
}
async function twSend(a, from, to, text) {
  const sid = process.env.TWILIO_ACCOUNT_SID, user = process.env.TWILIO_API_KEY_SID || sid, pass = process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !pass) throw Object.assign(new Error("Twilio is not set up in Netlify (TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN)."), { status: 500 });
  if (!twNumbers(a).includes(from)) throw Object.assign(new Error(`${from} is not one of ${a.name}'s Twilio numbers.`), { status: 403 });
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST", headers: { authorization: "Basic " + Buffer.from(user + ":" + pass).toString("base64"), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: from, To: to, Body: text }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error("Twilio: " + (j.message || "error " + r.status) + (j.code ? " (code " + j.code + ")" : "")), { status: r.status === 429 ? 429 : 502 });
  return { id: j.sid, messageStatus: j.status };
}
module.exports = { twNumbers, twSend };
