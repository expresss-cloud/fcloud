// Exchanges a valid Telegram-issued key for a session cookie (12 hours by default).
// Netlify variables: SESSION_SECRET, SESSION_HOURS (optional)
const { webcrypto } = require("crypto");
const subtle = webcrypto.subtle, enc = new TextEncoder();
const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32(bytes) { let bits = 0, v = 0, o = ""; for (const b of bytes) { v = ((v << 8) | b) & 0xfffff; bits += 8; while (bits >= 5) { o += A[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) o += A[(v << (5 - bits)) & 31]; return o; }
function unb32(s) { let bits = 0, v = 0; const out = []; for (const ch of s) { const i = A.indexOf(ch); if (i < 0) return null; v = ((v << 5) | i) & 0xfffff; bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Uint8Array.from(out); }
async function hmac(secret, bytes) { const k = await subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return new Uint8Array(await subtle.sign("HMAC", k, bytes)); }
const hex = u => [...u].map(b => b.toString(16).padStart(2, "0")).join("");
const same = (a, b) => { a = String(a || ""); b = String(b || ""); let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0; };
const reply = (code, obj, extra = {}) => ({ statusCode: code, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra }, body: JSON.stringify(obj) });

async function keyValid(secret, input) {
  const clean = String(input || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  if (clean.length !== 20) return false;
  const bytes = unb32(clean);
  if (!bytes || bytes.length < 12 || b32(bytes.subarray(0, 12)) !== clean) return false;
  const head = bytes.subarray(0, 7), mac = hex(bytes.subarray(7, 12));
  const want = hex((await hmac(secret, new Uint8Array([...enc.encode("key"), ...head]))).subarray(0, 5));
  if (!same(mac, want)) return false;
  const exp = ((head[3] << 24) | (head[4] << 16) | (head[5] << 8) | head[6]) >>> 0;
  return exp >= Math.floor(Date.now() / 60000);
}

exports.handler = async (ev) => {
  try {
    const secret = process.env.SESSION_SECRET;
    if (!secret || secret.length < 16) return reply(500, { error: "Site is not configured yet (SESSION_SECRET)." });
    if (ev.httpMethod !== "POST") return reply(405, { error: "Method not allowed." });
    const key = (JSON.parse(ev.body || "{}")).key;
    if (!(await keyValid(secret, key))) return reply(401, { error: "That key is wrong or has expired. Message the bot for a new one." });
    const hours = Math.min(Math.max(parseFloat(process.env.SESSION_HOURS) || 12, 0.5), 168);
    const exp = Math.floor(Date.now() / 1000) + Math.round(hours * 3600);
    const sig = hex(await hmac(secret, enc.encode("sess" + exp)));
    return reply(200, { ok: true }, { "set-cookie": `cm_session=${exp}.${sig}; Max-Age=${Math.round(hours * 3600)}; Path=/; HttpOnly; Secure; SameSite=Lax` });
  } catch (e) { return reply(400, { error: "Bad request." }); }
};
