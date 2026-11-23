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
const { json, checkCode, accounts, pick, rc, e164, sendSms } = require("./lib/rc");

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
      const j = await sendSms(a, from, to, text);
      return json(200, { id: j.id, status: j.messageStatus, to, account: a.name });
    }
    return json(405, { error: "Method not allowed." });
  } catch (e) {
    return json(e.status || 500, { error: e.message || "Server error" });
  }
};
