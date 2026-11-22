// Telegram bot webhook: a person messages the bot, the bot replies with a fresh random website key.
// Netlify variables: TG_BOT_TOKEN, TG_WEBHOOK_SECRET, SESSION_SECRET, TG_ALLOWED_IDS (comma list of Telegram user IDs),
//                    KEY_MINUTES (optional, default 10)
const { webcrypto } = require("crypto");
const subtle = webcrypto.subtle, enc = new TextEncoder();
const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function b32(bytes) { let bits = 0, v = 0, o = ""; for (const b of bytes) { v = ((v << 8) | b) & 0xfffff; bits += 8; while (bits >= 5) { o += A[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) o += A[(v << (5 - bits)) & 31]; return o; }
async function hmac(secret, bytes) { const k = await subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return new Uint8Array(await subtle.sign("HMAC", k, bytes)); }
const same = (a, b) => { a = String(a || ""); b = String(b || ""); let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0; };

// 12 bytes: 3 random + 4 expiry (minutes since 1970) + 5 signature  ->  20 characters, shown as XXXXX-XXXXX-XXXXX-XXXXX
async function makeKey(secret, minutes) {
  const head = new Uint8Array(7); webcrypto.getRandomValues(head.subarray(0, 3));
  const exp = Math.floor(Date.now() / 60000) + minutes;
  head[3] = (exp >>> 24) & 255; head[4] = (exp >>> 16) & 255; head[5] = (exp >>> 8) & 255; head[6] = exp & 255;
  const mac = (await hmac(secret, new Uint8Array([...enc.encode("key"), ...head]))).subarray(0, 5);
  return b32(new Uint8Array([...head, ...mac])).match(/.{1,5}/g).join("-");
}

async function tgSend(chat, html) {
  await fetch(`https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
  });
}

// Open  /.netlify/functions/tg?check=1  in a browser to see what is configured (shows yes/no only, never the values).
async function selfCheck() {
  const e = process.env, out = {
    version: "tg-3 (with self-check)",
    TG_BOT_TOKEN_set: !!e.TG_BOT_TOKEN, TG_WEBHOOK_SECRET_set: !!e.TG_WEBHOOK_SECRET,
    SESSION_SECRET_ok: !!e.SESSION_SECRET && e.SESSION_SECRET.length >= 16,
    allowed_ids_count: (e.TG_ALLOWED_IDS || "").split(",").map(x => x.trim()).filter(Boolean).length,
  };
  if (e.TG_BOT_TOKEN) {
    try {
      const me = await (await fetch(`https://api.telegram.org/bot${e.TG_BOT_TOKEN}/getMe`)).json();
      out.bot = me.ok ? "@" + me.result.username : "token rejected by Telegram: " + me.description;
      const wi = await (await fetch(`https://api.telegram.org/bot${e.TG_BOT_TOKEN}/getWebhookInfo`)).json();
      if (wi.ok) out.webhook = { url_set: !!wi.result.url, url_ends_with_tg: /\/\.netlify\/functions\/tg$/.test(wi.result.url || ""), pending: wi.result.pending_update_count, last_error: wi.result.last_error_message || "none" };
    } catch (x) { out.telegram_check_failed = String(x.message || x); }
  }
  return { statusCode: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(out, null, 2) };
}

exports.handler = async (ev) => {
  const ok = { statusCode: 200, body: "ok" };   // always answer 200 so Telegram does not keep retrying
  try {
    if (ev.httpMethod === "GET" && (ev.queryStringParameters || {}).check === "1") return await selfCheck();
    if (ev.httpMethod !== "POST") return { statusCode: 405, body: "" };
    const h = ev.headers || {};
    console.log("tg: request received");
    if (!process.env.TG_WEBHOOK_SECRET) { console.error("tg: 401 because TG_WEBHOOK_SECRET is not set in Netlify (or the site was not redeployed after adding it)"); return { statusCode: 401, body: "" }; }
    if (!same(h["x-telegram-bot-api-secret-token"], process.env.TG_WEBHOOK_SECRET)) { console.error("tg: 401 because the secret_token Telegram sent does not match TG_WEBHOOK_SECRET (sent length " + String(h["x-telegram-bot-api-secret-token"] || "").length + ", expected length " + process.env.TG_WEBHOOK_SECRET.length + ")"); return { statusCode: 401, body: "" }; }
    const secret = process.env.SESSION_SECRET;
    if (!secret || secret.length < 16 || !process.env.TG_BOT_TOKEN) { console.error("tg: SESSION_SECRET (16+ chars) and TG_BOT_TOKEN must be set"); return ok; }
    const m = (JSON.parse(ev.body || "{}")).message;
    if (!m || !m.from || !m.chat || m.chat.type !== "private") return ok;
    const allowed = (process.env.TG_ALLOWED_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
    if (!allowed.includes(String(m.from.id))) {
      await tgSend(m.chat.id, `Sorry, you are not on the access list.\nYour Telegram ID is <code>${m.from.id}</code> – send it to the site owner to be added.`);
      return ok;
    }
    const mins = Math.min(Math.max(parseInt(process.env.KEY_MINUTES, 10) || 10, 1), 60);
    const key = await makeKey(secret, mins);
    await tgSend(m.chat.id, `Your access key:\n\n<code>${key}</code>\n\nEnter it on the website within ${mins} minutes. Message me again for a new key any time.`);
    return ok;
  } catch (e) { console.error("tg error", e); return ok; }
};
