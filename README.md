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
