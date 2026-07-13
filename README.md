# Tera API — Cloudflare Worker (GitHub Deploy)

## One-click deploy (after Step 1 below)

Once this code is in your own GitHub repo, add a button like this to your
README — clicking it lets anyone deploy their own copy straight from
Cloudflare, no dashboard clicking-around needed (same idea as Render's
"Deploy to Render" button):

```markdown
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/anujeditsbyanuj-bit/Tera_api)
```

Cloudflare Worker:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/anujeditsbyanuj-bit/Tera_api)

Clicking it walks the user through: connect GitHub → pick account → set the
env vars below (`NDUS`, `RATE_LIMIT`, etc. — Cloudflare's button UI now
supports prompting for these directly) → deploy. It clones the repo into
*their* GitHub account and deploys *their own* Worker — it does not deploy
to your account. The repo must be public (or the visitor must have access)
for the button to work.

## Step 1 — Push this to GitHub (from your phone, no laptop needed)

1. Go to https://github.com/new and create a new **empty** repository
   (don't add a README/license — keep it empty).
2. On the new repo's page, tap **"uploading an existing file"**.
3. Upload all files from this folder, keeping the same structure:
   - `wrangler.toml`
   - `package.json`
   - `.gitignore`
   - `src/worker.js`
4. Commit directly to `main`.

## Step 2 — Connect Cloudflare to that GitHub repo

1. Go to the Cloudflare dashboard → **Workers & Pages**.
2. Click **Create** → **Workers** → **Import a repository** (or **Connect to Git**
   if you're editing an existing Worker — Settings → Build → Connect).
3. Authorize GitHub, pick the repo you just created.
4. Build settings:
   - **Root directory:** `/` (leave default)
   - **Build command:** leave empty (nothing to build)
   - **Deploy command:** leave default (`npx wrangler deploy`)
5. Click **Save and Deploy**.

## Step 3 — Add your environment variables

Whether or not this repo has your NDUS cookie (it doesn't — `wrangler.toml`
deliberately leaves secrets out so nothing sensitive goes to GitHub):

1. Cloudflare dashboard → your Worker → **Settings → Variables and Secrets**.
2. Add (all optional, but `NDUS` recommended):
   - `NDUS`
   - `CSRF_TOKEN`
   - `BROWSER_ID`
   - `TSID`
   - `NDUT_FMT`
   - `RATE_LIMIT` (default 30)
   - `RATE_WINDOW` (default 60)
   - `CACHE_MAX_SIZE` (default 500)
   - `MAX_HLS_SEGMENTS` (default 45; raise to ~950 on a Paid Cloudflare plan — see comment in `src/worker.js` for details on the subrequest-limit error this guards against)
3. Save — the Worker restarts automatically with the new values.

## From now on

Any time you want to update the code: edit `src/worker.js` on GitHub
(GitHub's own web editor works fine on mobile — pencil icon on the file
page), commit, and Cloudflare **redeploys automatically** within a minute.
No more pasting large files into the mobile Quick Edit box.

## Verify it worked

Visit `https://<your-worker>.workers.dev/health` — should return
`{"status":"ok", ...}`, not "Hello World!". If you still see "Hello World!",
the Git deploy hasn't run yet — check the **Deployments** tab on the Worker
for build logs/errors.
