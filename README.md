# Carrier Map (Netlify)
index.html = the site (state outline map). data/ = one gzip CSV per state, written by scripts/fmcsa_nightly.py.

## One-time setup
1. Create a GitHub repo and upload this folder (data/*.csv.gz is not committed; see .gitignore).
2. Netlify: Add new site > Deploy manually (drop this folder once) to create the site. Note its Site ID
   (Site configuration > Site ID) and create a personal access token (User settings > Applications).
3. GitHub repo > Settings > Secrets > Actions: add NETLIFY_AUTH_TOKEN, NETLIFY_SITE_ID,
   and optionally SOCRATA_APP_TOKEN (free, from data.transportation.gov).
4. Actions tab > "Nightly FMCSA data" > Run workflow. It then runs every night by itself.

## Test locally first
cd scripts && pip install requests && python fmcsa_nightly.py run --states UT --out ../data
python -m http.server 8000   (from this folder) then open http://localhost:8000

## Text messages (RingCentral)
Files: `netlify/functions/sms.js`, `netlify.toml` (`[functions]`), "Send text" button in `index.html`.
Netlify > Site configuration > Environment variables: RC_CLIENT_ID, RC_CLIENT_SECRET, RC_JWT, SMS_ACCESS_CODE
(optional RC_SERVER_URL; sandbox = https://platform.devtest.ringcentral.com).
RingCentral developer console: create a private REST API app, auth flow "JWT", permissions SMS + ReadAccounts, then
create a JWT for the user whose numbers should send. Redeploy after setting variables.

## Access key (Telegram bot + gate)
Files: `netlify/functions/tg.js` (bot webhook), `netlify/functions/login.js` (key -> session cookie),
`netlify/edge-functions/gate.js` (blocks every request, including data files, without a valid session).
Netlify variables: SESSION_SECRET (random, 32+ chars), TG_BOT_TOKEN, TG_WEBHOOK_SECRET (random), TG_ALLOWED_IDS
(comma-separated Telegram user IDs), TG_BOT_USERNAME (optional), KEY_MINUTES (default 10), SESSION_HOURS (default 12).
After deploying, register the webhook once (open in a browser):
https://api.telegram.org/bot<TG_BOT_TOKEN>/setWebhook?url=https://<your-site>/.netlify/functions/tg&secret_token=<TG_WEBHOOK_SECRET>

## Several RingCentral users
Netlify variables: RC_JWT (one user, shown as "Main"), or RC_ACCOUNTS=Alice,Bob plus RC_JWT_ALICE, RC_JWT_BOB.
Each person creates their own JWT in the RingCentral developer console (Credentials > Create JWT). The text panel shows a
"Send as" menu when more than one user is configured. Netlify limits the combined size of function variables (about 4 KB),
and each JWT is long, so plan for roughly 2-3 users with this method.

## Per-user access codes for texting
Each RingCentral user has their own code: Main uses SMS_ACCESS_CODE (or RC_CODE_MAIN); every other user needs RC_CODE_<NAME>
(for example RC_CODE_ALICE). A user without a code cannot be used. In the text panel: pick the user first, then type that
user's code. Codes are never stored in the browser, and 8 wrong guesses lock a user for 5 minutes.

## Texting runs on the server (page can be closed)
Press Send and the list goes to Netlify (`smsq.js` stores the job in Netlify Blobs, `sms-run-background.js` sends the texts with the pause).
You choose how many people (1–200, the first rows of the table). Reopen the text panel and type your access code to see progress or press **Stop sending**
(it takes effect before the next text). Needs the `package.json` (`@netlify/blobs`); the workflows run `npm install` before deploying.
Check storage after deploying: open `/.netlify/functions/smsq?action=selftest` while logged in – it should say `"storage":"working"`.

### Safety limits (to avoid getting the RingCentral number flagged)
- **Daily cap** per RingCentral user: 200 texts per day (Netlify variable `SMS_DAILY_CAP` to change). Unsent texts are given back when a job is stopped.
- **No repeats:** numbers texted – or that failed – in the last 30 days are skipped automatically (`SMS_RECENT_DAYS`). The panel says how many were skipped.
- **Auto-stop:** a job stops itself after 3 failures in a row, or when 25% or more of the texts fail (after 8 texts).
- **Shared across agents:** the "texted / failed in the last 30 days" check covers ALL RingCentral users, so a carrier texted by one agent is skipped for the others.
- **Do-not-text list:** in the text panel, paste numbers of people who asked to stop; every agent skips them. (STOP replies are not captured automatically – add them here.)

## Email through SendGrid
Button **Send email** (next to Send text). Netlify variables: `SENDGRID_API_KEY` (Mail Send permission), `SG_ADDRESS` (your business postal address – required, it is put in every footer),
`SG_FROM` (a sender verified in SendGrid) for the main user, and `SG_FROM_<NAME>` for each extra user (same names and access codes as texting).
Optional: `SG_FROM_NAME`, `SG_FROM_NAME_<NAME>`, `EMAIL_DAILY_CAP` (500 per user per day), `EMAIL_RECENT_DAYS` (30).
Each recipient gets their own email; `{name}` in the subject or message becomes the company name. SendGrid adds the unsubscribe link and never emails unsubscribed or bounced addresses again.
- **Your own template:** in the email panel choose "HTML (paste my template)", paste the HTML, use **Preview** to check it, and **Save as my template** to keep it (one per user; it loads automatically next time). `{name}` is replaced by the company name. A plain-text version is generated automatically; the unsubscribe link and address are added at the bottom.
- **SendGrid template:** choose "My SendGrid template (by ID)" in the email panel and paste the template ID (legacy = long code, dynamic starts with `d-`). Leave the subject empty to use the template's own subject. Merge tags: `-name-`, `-dot-` (legacy) or `{{name}}`, `{{dot}}` (dynamic). The sender address always comes from `SG_FROM`.
- **Footer:** the email panel has a tick box "My email already has its own unsubscribe link and business address – don't add the automatic footer". Leave it off unless your template really contains both.

## Twilio texting (second provider)
SendGrid itself only sends email; its parent company Twilio sells SMS. The text panel has a **Send with** choice: RingCentral or Twilio.
Netlify variables: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (or `TWILIO_API_KEY_SID` + `TWILIO_API_KEY_SECRET`), and the numbers each user may send from:
`TWILIO_FROM` (main user, comma separated) and `TWILIO_FROM_<NAME>` for the other users. Same users and access codes as before; a user may use only their own numbers.
A user with only Twilio needs no RingCentral JWT, but must be listed in `RC_ACCOUNTS` (or be the main user). US business texting through Twilio needs A2P 10DLC registration. A recipient who replied STOP is added to the do-not-text list automatically.
