# 📈 IPO Premium – Live GMP Tracker

A real-time Grey Market Premium (GMP) tracker for Indian IPOs (Mainboard & SME) with live auto-refresh, historical comparison, change highlights, and instant alert dispatch.

Designed to run 100% serverless directly in your browser or hosted on GitHub Pages for free. No Python script, no local server, no installation needed—access it from your phone, laptop, or tablet anywhere!

---

## ✨ Features

- **⚡ Zero Setup / 100% Serverless**: Runs directly in any browser via GitHub Pages with no server dependencies.
- **🔄 Auto-Refresh (Configurable 1m–10m)**: Real-time countdown timer with automated polling and manual "Refresh Now" trigger.
- **🎯 Smart Change Detection & Badges**:
  - GMP Increases: Glowing emerald badge `▲ +₹X (₹Prev → ₹Curr)`.
  - GMP Decreases: Glowing red/rose badge `▼ -₹X (₹Prev → ₹Curr)`.
  - New IPOs: Glowing cyan badge `★ NEW IPO`.
- **👆 Interactive Dismissal**: Tap or click any badge or row to acknowledge changes and toggle to a subtle "Seen" state.
- **🔔 Audio Alerts**: Subtle Web Audio chimes sound whenever market premiums shift.
- **⚓ Unified Anchor Allocation Tracker (`anchor.html`)**:
  - Live tracking of Exchange Anchor Allocation reports.
  - Direct view & download links for official Anchor Allocation PDFs.
  - Clean filtering, search, and status badges.
- **📊 Live Subscription Tracker (`subscription.html`)**:
  - Real-time bidding multiples across QIB, NII (sNII/bNII), Retail, and Employee categories.
  - Sourced directly from live market feeds.
- **🔒 24-Hour Security PIN Lock (`security.js`)**:
  - Frosted-glass PIN access screen protecting all pages (`index.html`, `anchor.html`, `subscription.html`).
  - Secure SHA-256 Web Crypto hashing (customizable via `PANEL_PIN` GitHub Secret).
  - 24-hour persistent session in `localStorage` with auto-expiration and navbar status badge.
- **📱 Instant Telegram Anchor Alerts (`notifications.js`)**:
  - Free Telegram Bot integration alerting as soon as new Anchor Allocation files are published.
  - Sends the official Anchor Allocation `.pdf` directly to your Telegram chat or channel!
- **🛡️ Secure Secret Key & Dynamic Source Resolver (`sources.js`)**:
  - Target domains and scraping endpoints are obfuscated at runtime and configurable via GitHub Secrets so that raw source links are never exposed in public repositories.
- **🤖 Cloud Automation**: GitHub Actions running on automated schedules (Mon–Fri) to keep data fresh without local computers running.

---

## 🚀 How to Host Live on GitHub Pages (30-Second Setup)

You can publish this directly to GitHub and access it from your phone or any browser:

### Step 1: Push to your GitHub Repository

In your terminal inside this folder:

```bash
git init
git add .
git commit -m "feat: initial commit of IPO Premium GMP tracker"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/gmpupdatepremium.git
git push -u origin main
```

*(Replace `YOUR_USERNAME` with your actual GitHub username)*

### Step 2: Enable GitHub Pages

1. Go to your repository on GitHub: `https://github.com/YOUR_USERNAME/gmpupdatepremium`
2. Click **Settings** (gear icon at the top right).
3. In the left sidebar, click **Pages**.
4. Under **Branch**, select **`main`** and folder **`/ (root)`**, then click **Save**.
5. Within 1 minute, GitHub will give you a live URL, like:
   ```
   https://YOUR_USERNAME.github.io/gmpupdatepremium/
   ```

You can now open this link on your phone, save it to your home screen, or open it on any computer!

---

## 🔒 Security Configuration (GitHub Secrets)

To protect your panel and configure confidential source feeds or Telegram alerts in GitHub Actions, add these repository secrets (**Settings > Secrets and variables > Actions**):

| Secret Name | Description | Example |
| :--- | :--- | :--- |
| `PANEL_PIN` *(Optional)* | 4-digit or custom unlock PIN for dashboard access | `9924` |
| `TELEGRAM_BOT_TOKEN` *(Optional)* | Bot token from `@BotFather` | `123456789:ABCdef...` |
| `TELEGRAM_CHAT_ID` *(Optional)* | Your numeric Telegram user or group ID | `793736493` |
| `GMP_SOURCE_URL` *(Optional)* | Custom primary market GMP feed endpoint | `https://...` |
| `NSE_BASE_URL` *(Optional)* | Primary Exchange 1 base domain override | `https://...` |
| `BSE_BASE_URL` *(Optional)* | Primary Exchange 2 base domain override | `https://...` |

---

## 💻 Testing Locally

If you want to view it locally on your computer:
- Simply double-click `index.html` to open it in Chrome, Safari, or Edge.
- Or run the included local server:
  ```bash
  node server.js
  ```
  Then open `http://localhost:8080`.

---

## 📂 Project Structure

```
gmpupdatepremium/
├── index.html                  # Live GMP Tracker dashboard
├── anchor.html                 # Unified Exchange Anchor Allocation Tracker
├── subscription.html           # Live IPO Subscription Tracker
├── style.css                   # Premium dark financial terminal styling
├── app.js                      # Core engine: fetcher, diffing, highlights, timer
├── security.js                 # 24-hour SHA-256 PIN authentication layer
├── sources.js                  # Dynamic source resolver with secret key support
├── set-pin.js                  # CLI tool to hash and update security PIN
├── notifications.js            # Telegram Bot alert & PDF delivery engine
├── test-notify.js              # Interactive Telegram notification tester
├── fetch-anchor-data.js        # Scraper for Exchange Anchor reports
├── fetch-gmp.js                # Parser for live GMP data
├── server.js                   # Local preview server
├── data.json                   # Snapshot of current IPO GMP data
├── nse-ipo-data.json           # Snapshot of Anchor Allocation reports
├── notified-anchors.json       # Record of sent alerts (prevents duplicates)
├── .github/
│   └── workflows/
│       ├── update-gmp.yml      # Scheduled GMP sync (Mon-Fri)
│       └── update-anchor.yml   # Scheduled Anchor sync & Telegram dispatcher
└── README.md                   # Documentation & guide
```

---

## ⚠️ Disclaimer

Data is extracted for educational and informational purposes from primary market data feeds. Grey Market Premium (GMP) is an unofficial, informal market estimate and should not be considered investment or financial advice.

### Subscription sync and deployment

GitHub Pages is static hosting. The subscription page's Refresh button and timer
read current repository contents through GitHub’s public read API, comparing
timestamps with raw-file and deployed-site fallbacks. Raw branch URLs alone can
remain cached for several minutes. They do not start a scrape. This avoids waiting for
a Pages rebuild after every data update. The page displays the snapshot's age. Pages polls every 75 seconds to leave
headroom in the anonymous API quota; the backend sync still runs every minute.
Manual refresh requests current repository contents. If GitHub rate-limits reads,
the page shows a saved-data warning and respects the API reset time.

Subscription live sync now runs from the Mac with `launchd`. GitHub Actions is
kept as a manual backup only because scheduled Actions can be delayed or missed.
Install/start the Mac runner with:

```bash
chmod +x scripts/*.sh
scripts/install-subscription-mac.sh
```

Stop it with:

```bash
scripts/uninstall-subscription-mac.sh
```

The local runner reads `.env`, fetches `SUB_DASH_URL` with `SUB_WEB_URL` as the
fallback, updates the backend API with the same `GET` and `PUT` flow as before,
commits `subscription-data.json`, and pushes `main`. During active subscription
hours it runs every minute. From 17:00–18:00 IST it runs every ten minutes.

Proxy rotation is enabled by default for source fetching. Set `SOURCE_PROXY_URLS`
in `.env` for your own stable proxies, or let `manage-source-proxies.js` refresh
`cache/source-proxies.json` from public proxy lists. Dead routes are cooled down.
Routes that return 403/429 or fail repeatedly are marked blocked and skipped in
future cycles. Set `SOURCE_DIRECT_ONLY=true` in `.env` to bypass proxies and use
direct HTTPS only.

Useful local commands:

```bash
node manage-source-proxies.js
node local-subscription-runner.js --force --once
tail -f logs/subscription-local.out.log
tail -f logs/subscription-local.err.log
```

Use **Start live updates → Run workflow** on GitHub only as a manual backup.

`Deploy Live Website` publishes public assets on code pushes. Data-only snapshot
pushes are ignored by Pages deployment because `subscription.html` reads the
current branch snapshot through GitHub's public contents API. Source URLs,
backend credentials and server-side scripts are not included in the site.
Backend errors are logged as failures; valid source data can still be published
when a backend update fails. The session retries on its next interval.

Run `node --test tests/*.test.js`. Session logs show each API result and completed
publication cycle. Changes appear in the page on its next refresh, even while
the Actions session is still running.
