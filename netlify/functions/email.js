// Email through SendGrid for the Carrier Map (server side, so the API key never reaches the browser).
//   GET  ?action=sender&account=NAME   -> the "from" address that user sends as (needs that user's access code)
//   POST {account, subject, body, recipients:[{e,name,dot}]}  -> sends one separate email per recipient (max 200)
// Same RingCentral-user list and access codes as texting (each agent has their own code and their own sender address).
// Netlify variables:
//   SENDGRID_API_KEY   a SendGrid API key with "Mail Send" permission
//   SG_ADDRESS         your business postal address – REQUIRED, it goes into every email footer (CAN-SPAM)
//   SG_FROM            verified sender address of the main user; other users: SG_FROM_<NAME>  (e.g. SG_FROM_ALICE)
//   SG_FROM_NAME       optional display name for the main user; others: SG_FROM_NAME_<NAME>
//   EMAIL_DAILY_CAP (default 500 per user per day), EMAIL_RECENT_DAYS (default 30: nobody is emailed twice in that time)
// SendGrid itself adds the unsubscribe link (subscription tracking) and keeps unsubscribed/bounced addresses off future sends.
const { open } = require("./lib/blobs");
const { json, nameKey, checkCode, pick, accounts } = require("./lib/rc");

const DAY = 86400000, RECENT = +process.env.EMAIL_RECENT_DAYS || 30, CAP = +process.env.EMAIL_DAILY_CAP || 500;
const RX = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[A-Za-z]{2,}$/;
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const senderOf = a => {
  const k = nameKey(a.name), from = (process.env["SG_FROM_" + k] || (a.main ? process.env.SG_FROM : "") || "").trim();
  const nm = (process.env["SG_FROM_NAME_" + k] || (a.main ? process.env.SG_FROM_NAME : "") || "").replace(/[<>"]/g, "").trim();
  return { from, name: nm };
};

const toText = h => String(h).replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>|<\/(p|div|tr|h[1-6]|li)>/gi, "\n").replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

exports.handler = async (ev) => {
  try {
    const H = ev.headers || {}, given = H["x-access-code"] || H["X-Access-Code"], q = ev.queryStringParameters || {};
    if (ev.httpMethod === "GET") {
      if (q.action === "template") {
        const a = pick(q.account); checkCode(a, given);
        return json(200, { template: (await open(ev).get("etpl-" + nameKey(a.name), { type: "json" })) || null });
      }
      if (q.action !== "sender") return json(400, { error: "Unknown action." });
      const a = pick(q.account); checkCode(a, given);
      const s = senderOf(a);
      return json(200, { account: a.name, from: s.from, name: s.name, ready: !!(process.env.SENDGRID_API_KEY && process.env.SG_ADDRESS && s.from),
        missing: [!process.env.SENDGRID_API_KEY && "SENDGRID_API_KEY", !process.env.SG_ADDRESS && "SG_ADDRESS", !s.from && "SG_FROM" + (a.main ? "" : "_" + nameKey(a.name))].filter(Boolean) });
    }
    if (ev.httpMethod !== "POST") return json(405, { error: "Method not allowed." });
    const b = JSON.parse(ev.body || "{}"), a = pick(b.account); checkCode(a, given);
    if (b.action === "savetpl") {
      const t = { subject: String(b.subject || "").slice(0, 200), body: String(b.body || "").slice(0, 150000), html: !!b.html, templateId: String(b.templateId || "").trim().slice(0, 60) };
      if (!t.body.trim() && !t.templateId) return json(400, { error: "Nothing to save: the message is empty." });
      await open(ev).setJSON("etpl-" + nameKey(a.name), t);
      return json(200, { saved: true });
    }
    const s = senderOf(a), key = process.env.SENDGRID_API_KEY, addr = (process.env.SG_ADDRESS || "").replace(/[<>]/g, "").trim();
    if (!key) return json(500, { error: "SENDGRID_API_KEY is not set in Netlify." });
    if (!addr) return json(500, { error: "SG_ADDRESS (your business postal address) is not set in Netlify. It is required in every email footer." });
    if (!RX.test(s.from)) return json(500, { error: `No sender address for ${a.name} (set ${a.main ? "SG_FROM" : "SG_FROM_" + nameKey(a.name)} to a sender verified in SendGrid).` });
    const subject = String(b.subject || "").replace(/[\r\n]+/g, " ").trim(), body = String(b.body || "").trim();
    const tid = String(b.templateId || "").trim(), dyn = /^d-[0-9a-f]{32}$/i.test(tid);
    if (tid && !dyn && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tid)) return json(400, { error: "That does not look like a SendGrid template ID (it is a long code, or starts with d- for dynamic templates)." });
    if ((!subject && !tid) || subject.length > 200) return json(400, { error: "Subject must be 1-200 characters." });
    const isHtml = !!b.html;
    if ((!body && !tid) ||  body.length > (isHtml ? 150000 : 10000)) return json(400, { error: isHtml ? "The HTML must be 1-150000 characters." : "Message must be 1-10000 characters." });
    const seen = new Set(), recips = [];
    for (const r of Array.isArray(b.recipients) ? b.recipients : []) {
      const e = String((r && r.e) || "").trim().toLowerCase(); if (!RX.test(e) || seen.has(e)) continue; seen.add(e);
      recips.push({ e, name: String((r && r.name) || "").replace(/[<>&"'\r\n]/g, "").slice(0, 80).trim(), dot: String((r && r.dot) || "").slice(0, 20) });
    }
    if (!recips.length) return json(400, { error: "No valid email addresses." });
    if (recips.length > 200) return json(400, { error: "At most 200 recipients per batch." });

    const st = open(ev), now = Date.now(), hist = {};
    for (const a2 of accounts()) {                                    // nobody is emailed twice by any agent
      const h2 = (await st.get("ehist-" + nameKey(a2.name), { type: "json" })) || {};
      for (const e of Object.keys(h2)) if (!hist[e] || h2[e] > hist[e]) hist[e] = h2[e];
    }
    const keep = recips.filter(r => !(hist[r.e] && now - hist[r.e] < RECENT * DAY)), skipped = recips.length - keep.length;
    if (!keep.length) return json(400, { error: `Nobody left to email: all ${recips.length} were already emailed in the last ${RECENT} days.` });
    const dk = "eday-" + nameKey(a.name) + "-" + new Date(now).toISOString().slice(0, 10), used = +(await st.get(dk, { type: "text" }) || 0);
    if (used + keep.length > CAP) return json(400, { error: `Daily limit: ${a.name} can send ${CAP} emails per day and has ${Math.max(0, CAP - used)} left today. Enter ${Math.max(0, CAP - used)} or fewer.` });

    const tag = t => t.replace(/\{name\}/gi, "-name-");
    const html = isHtml ? tag(body) : "<div style=\"font:15px/1.5 Arial,sans-serif\">" + esc(tag(body)).replace(/\r?\n/g, "<br>") + "</div>";
    const text = isHtml ? tag(toText(body)) : tag(body);
    const payload = tid ? {
      personalizations: keep.map(r => ({ to: [{ email: r.e }], ...(dyn ? { dynamic_template_data: { name: r.name || "there", dot: r.dot, ...(subject ? { subject } : {}) } } : { substitutions: { "-name-": r.name || "there", "-dot-": r.dot } }) })),
      from: { email: s.from, ...(s.name ? { name: s.name } : {}) }, reply_to: { email: s.from }, template_id: tid,
      ...(!dyn && subject ? { subject: tag(subject) } : {}),
      ...(dyn ? {} : { content: [{ type: "text/plain", value: body ? text : "\u00a0" }, { type: "text/html", value: body ? html : "&nbsp;" }] }),
      categories: ["carrier-map"],
      tracking_settings: { subscription_tracking: { enable: true,
        text: `\n\n${addr}\nTo stop receiving these emails, unsubscribe here: <% %>`,
        html: `<p style="font:12px Arial,sans-serif;color:#666;margin-top:24px">${esc(addr)}<br>Don't want these emails? <% Unsubscribe %>.</p>` } },
    } : {
      personalizations: keep.map(r => ({ to: [{ email: r.e }], substitutions: { "-name-": r.name || "there" } })),
      from: { email: s.from, ...(s.name ? { name: s.name } : {}) }, reply_to: { email: s.from },
      subject: tag(subject),
      content: [{ type: "text/plain", value: text }, { type: "text/html", value: html }],
      categories: ["carrier-map"],
      tracking_settings: { subscription_tracking: { enable: true,
        text: `\n\n${addr}\nTo stop receiving these emails, unsubscribe here: <% %>`,
        html: `<p style="font:12px Arial,sans-serif;color:#666;margin-top:24px">${esc(addr)}<br>Don't want these emails? <% Unsubscribe %>.</p>` } },
    };
    const r = await fetch("https://api.sendgrid.com/v3/mail/send", { method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" }, body: JSON.stringify(payload) });
    if (r.status !== 202 && r.status !== 200) {
      const j = await r.json().catch(() => ({})), m = (j.errors || []).map(x => x.message).join("; ") || "HTTP " + r.status;
      return json(502, { error: "SendGrid refused the send: " + m });
    }
    const mine = (await st.get("ehist-" + nameKey(a.name), { type: "json" })) || {};
    for (const x of Object.keys(mine)) if (now - mine[x] > 90 * DAY) delete mine[x];
    for (const x of keep) mine[x.e] = now;
    await st.setJSON("ehist-" + nameKey(a.name), mine); await st.set(dk, String(used + keep.length));
    return json(200, { accepted: keep.length, skipped, from: s.from, account: a.name, time: new Date(now).toISOString(), list: keep });
  } catch (e) {
    return json(e.status || 500, { error: e.message || "Server error" });
  }
};
