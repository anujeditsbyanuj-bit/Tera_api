🚀 Tera API — Cloudflare Workers

«⚡ Production-ready TeraBox API powered by Cloudflare Workers with automatic GitHub deployment, secure secret management, caching, rate limiting, and HLS streaming support.»

---

☁️ One-Click Deploy

Deploy your own copy in just a few clicks.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/anujeditsbyanuj-bit/Tera_api)

🚀 Deploy Button

""Deploy to Cloudflare" (https://deploy.workers.cloudflare.com/button)" (https://deploy.workers.cloudflare.com/?url=https://deploy.workers.cloudflare.com/?url=https://github.com/anujeditsbyanuj-bit/Tera_api)

✨ The deployment wizard will automatically:

- 🔗 Connect your GitHub account
- 📂 Copy the repository to your account
- 🔐 Ask for required environment variables
- ☁️ Deploy your own Cloudflare Worker
- 🔄 Enable automatic deployments from GitHub

«💡 Note: The Worker is deployed entirely to your own Cloudflare account, not the original repository owner's account.»

---

📦 Step 1 — Create GitHub Repository

1️⃣ Create a new Public GitHub Repository

2️⃣ Upload the project files exactly like this:

📁 Tera_api
 ├── 📄 wrangler.toml
 ├── 📄 package.json
 ├── 📄 .gitignore
 └── 📁 src
      └── 📄 worker.js

3️⃣ Commit everything to the main branch.

---

☁️ Step 2 — Connect Cloudflare

Open:

☁️ Cloudflare Dashboard

➡️ Workers & Pages

➡️ Create

➡️ Import Repository

Select your GitHub repository.

⚙️ Build Settings

Setting| Value
📁 Root Directory| "/"
🛠 Build Command| (Leave Empty)
🚀 Deploy Command| "npx wrangler deploy"

Click ✅ Save & Deploy

---

🔐 Step 3 — Environment Variables

Open:

Worker → Settings → Variables & Secrets

Add these variables:

🔑 Variable| 📖 Description
NDUS| Login Cookie
CSRF_TOKEN| CSRF Token
BROWSER_ID| Browser ID
TSID| Session ID
NDUT_FMT| Cookie Format
RATE_LIMIT| Default: 30
RATE_WINDOW| Default: 60
CACHE_MAX_SIZE| Default: 500
MAX_HLS_SEGMENTS| Default: 45 (≈950 on Paid Plan)

💾 Save the variables.

♻️ Cloudflare automatically restarts the Worker.

---

🔄 Automatic Deployment

Every push to main triggers a new deployment automatically.

Workflow:

✏️ Edit "src/worker.js"

⬇️ Commit Changes

⬆️ Push to GitHub

☁️ Cloudflare Detects Update

🚀 New Deployment Starts Automatically

No manual deployment required.

---

✅ Verify Deployment

Visit:

https://<your-worker>.workers.dev/health

Expected response:

{
  "status": "ok"
}

If you still see Hello World:

- ⏳ Wait for deployment to finish
- 📜 Open the Deployments tab
- 🛠 Check the build logs

---

📂 Project Structure

📁 Tera_api
├── 📁 src
│   └── 📄 worker.js
├── 📄 wrangler.toml
├── 📄 package.json
├── 📄 .gitignore
└── 📄 README.md

---

✨ Features

- 🚀 Production Ready
- ☁️ Cloudflare Workers
- 🔄 Automatic GitHub Deployments
- 🔐 Secure Secret Management
- ⚡ High Performance
- 📦 Smart Response Caching
- 🛡 Built-in Rate Limiting
- 🎥 HLS Streaming Support
- 📱 Mobile Friendly Development
- 🔥 Zero Server Maintenance
- 🌍 Global Cloudflare Edge Network
- 📊 Optimized API Performance
- ⚙️ Easy Configuration
- 💎 One-Click Deployment
- 🏆 Developer Friendly

---

📄 License

⚠️ This project is intended for educational and development purposes only.

Please ensure that your usage complies with the Terms of Service of any third-party platforms you interact with.

---

❤️ Made with Cloudflare Workers + GitHub
