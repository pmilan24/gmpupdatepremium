# 📈 IPO Premium – Live GMP Tracker

A real-time Grey Market Premium (GMP) tracker for Indian IPOs (Mainboard & SME) sourced directly from [ipopremium.in](https://www.ipopremium.in).

Designed to run **100% serverless directly in your browser** or hosted on **GitHub Pages** for free. No Python script, no local server, no installation needed—access it from your phone, laptop, or tablet anywhere!

---

## ✨ Features

- **⚡ Zero Setup / No Local Python Needed**: Runs directly in the browser via GitHub Pages.
- **🔄 Auto-Refresh (Every 3–5 Minutes)**: Live countdown timer with configurable interval (1m, 3m, 5m, 10m) and manual "Refresh Now" button.
- **💾 Historical GMP Storage**: Saves previous GMP values in browser `localStorage`.
- **🎯 Right-Side Change Highlighting**:
  - If GMP increases: Glowing emerald green badge `▲ +₹X (₹Prev → ₹Curr)`.
  - If GMP decreases: Glowing red/rose badge `▼ -₹X (₹Prev → ₹Curr)`.
  - If new IPO added: Glowing blue badge `★ NEW IPO`.
- **👆 Click to Dismiss / Change Highlight**: Click on the highlight badge or IPO row to mark it as read/acknowledged—the highlight smoothly updates to a subtle "Seen" state.
- **🔔 Audio Alerts**: Web Audio chime sounds whenever a GMP change is detected.
- **🔍 Search & Filter**:
  - Filter by **All**, **🔥 Changed GMP Only**, **Mainboard**, **SME**, or **Active GMP**.
  - Sort by GMP value, Estimated Profit per Lot, Closing Date, or Company Name.
- **🤖 Automated GitHub Actions Backup**: Optional GitHub Action runs every 5 minutes on GitHub's cloud to keep `data.json` updated 24/7.

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

## 💻 Testing Locally

If you want to view it locally on your computer:
- Simply double-click `index.html` to open it in Chrome, Safari, or Edge.
- Or run any local web server:
  ```bash
  npx serve .
  # or
  python3 -m http.server 8080
  ```
  Then open `http://localhost:8080`.

---

## 📂 Project Structure

```
gmpupdatepremium/
├── index.html                  # Main UI dashboard
├── style.css                   # Premium dark financial terminal styling
├── app.js                      # Core engine: fetcher, diffing, highlights, timer
├── fetch-gmp.js                # Node parser script (used by GitHub Actions)
├── data.json                   # Snapshot of current IPO GMP data
├── .github/
│   └── workflows/
│       └── update-gmp.yml      # Scheduled GitHub Action running every 5 min
└── README.md                   # Documentation & guide
```

---

## ⚠️ Disclaimer

Data is extracted for educational and informational purposes from [ipopremium.in](https://www.ipopremium.in). Grey Market Premium (GMP) is an unofficial, informal market estimate and should not be considered investment or financial advice.
