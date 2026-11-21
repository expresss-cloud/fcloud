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
