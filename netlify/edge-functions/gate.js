// Runs in front of EVERY request (pages, data files, functions). No valid session cookie = no access.
// Netlify variables: SESSION_SECRET, TG_BOT_USERNAME (optional, shown on the login page)
export const config = { path: "/*", excludedPath: ["/.netlify/functions/tg", "/.netlify/functions/login"] };

const enc = new TextEncoder();
const hex = u => [...u].map(b => b.toString(16).padStart(2, "0")).join("");
const same = (a, b) => { a = String(a || ""); b = String(b || ""); let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0; };
async function sessionOk(secret, cookieHeader) {
  const m = /(?:^|;\s*)cm_session=(\d+)\.([0-9a-f]{64})(?:;|$)/.exec(cookieHeader || "");
  if (!m || +m[1] < Math.floor(Date.now() / 1000)) return false;
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return same(hex(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode("sess" + m[1])))), m[2]);
}

const page = (bot, locked, via) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Carrier Map – access</title><style>
:root{--bg:#e8ecef;--panel:#fff;--ink:#14202b;--mute:#5d6b78;--line:#cfd7de;--sign:#0b6e4f}
@media (prefers-color-scheme:dark){:root{--bg:#0f1820;--panel:#17232d;--ink:#e6edf2;--mute:#93a2af;--line:#2a3a47;--sign:#3fbf94}}
html{color-scheme:light dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif}
.c{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:24px;width:min(420px,100%)}h1{margin:0 0 6px;font-size:22px}p{color:var(--mute);margin:6px 0 14px}
input{box-sizing:border-box;width:100%;font:600 18px ui-monospace,monospace;letter-spacing:1px;text-transform:uppercase;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
button{margin-top:12px;width:100%;padding:12px;border:0;border-radius:8px;background:var(--sign);color:#fff;font:600 16px system-ui;cursor:pointer}#e{color:#c0392b;min-height:22px;margin-top:10px;font-size:14px}a{color:var(--sign)}</style></head><body><div class="c">
<h1>Carrier Map</h1>${locked ? `<p>This site is locked and not configured yet. The owner needs to set SESSION_SECRET in Netlify.</p>` : `
<p>Enter your access key. To get one, send any message to the Telegram bot${bot ? ` <a href="https://t.me/${bot}" rel="noopener">@${bot}</a>` : ""} – it replies with a new key each time.</p>
<form id="f"><input id="k" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXXX-XXXXX-XXXXX-XXXXX" aria-label="Access key" required><button id="b">Unlock</button><div id="e" role="alert"></div></form>
<script>document.getElementById("f").onsubmit=async function(ev){ev.preventDefault();var e=document.getElementById("e"),b=document.getElementById("b");e.textContent="";b.disabled=true;
try{var r=await fetch("/.netlify/functions/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({key:document.getElementById("k").value})});var j=await r.json().catch(function(){return{}});
if(r.ok){location.reload();return}e.textContent=j.error||"Could not log in."}catch(x){e.textContent="Network problem – try again."}b.disabled=false}</script>`}
${via ? `<p style="font-size:12px;margin:14px 0 0">blocked path: ${via.replace(/[^a-z0-9\/._-]/g, "")}</p>` : ""}</div></body></html>`;

export default async (request, context) => {
  const path = new URL(request.url).pathname.replace(/\/+$/, "").toLowerCase();
  for (const open of ["/.netlify/functions/login", "/.netlify/functions/tg"])
    if (path === open || path.startsWith(open + "/")) return context.next();   // must stay reachable without a session
  const secret = Netlify.env.get("SESSION_SECRET");
  const locked = !secret || secret.length < 16;
  if (!locked && await sessionOk(secret, request.headers.get("cookie"))) return context.next();
  const bot = (Netlify.env.get("TG_BOT_USERNAME") || "").replace(/[^A-Za-z0-9_]/g, "");
  const h = { "cache-control": "no-store" };
  if (request.method === "GET" && (request.headers.get("accept") || "").includes("text/html"))
    return new Response(page(bot, locked, path.startsWith("/.netlify/") ? path : ""), { status: 401, headers: { ...h, "content-type": "text/html; charset=utf-8" } });
  return new Response(JSON.stringify({ error: "Login required" }), { status: 401, headers: { ...h, "content-type": "application/json" } });
};
