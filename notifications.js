// notifications.js - Multi-channel Instant Anchor Alert Dispatcher (Telegram + NTFY)
const fs = require("fs");
const path = require("path");

const NOTIFIED_FILE = path.join(__dirname, "notified-anchors.json");

function loadNotifiedSet() {
  if (fs.existsSync(NOTIFIED_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(NOTIFIED_FILE, "utf8")) || {};
    } catch (e) {
      return {};
    }
  }
  return {};
}

function saveNotifiedSet(data) {
  try {
    fs.writeFileSync(NOTIFIED_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("[NOTIFY] Failed to save notified-anchors.json:", e.message);
  }
}

/**
 * Format timestamp in India Standard Time
 */
function getNowISTString() {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  }).format(new Date()) + " IST";
}

/**
 * Dispatch Telegram Alert with Direct PDF Document or Link
 */
async function sendTelegramAlert({ token, chatId, ipo, pdfUrl, caption }) {
  if (!token || !chatId) {
    return { skipped: true, reason: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not provided" };
  }

  const docApi = "https://api.telegram.org/bot" + token + "/sendDocument";

  try {
    // 1. Attempt to send PDF as a native document via URL
    if (pdfUrl && pdfUrl.startsWith("http")) {
      const payload = {
        chat_id: chatId,
        document: pdfUrl,
        caption: caption,
        parse_mode: "HTML"
      };

      const res = await fetch(docApi, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (data.ok) {
        console.log("[TELEGRAM] ✅ Sent Anchor PDF document to chat " + chatId);
        return { success: true, method: "sendDocument" };
      } else {
        console.warn("[TELEGRAM] sendDocument returned: " + data.description + ". Falling back to sendMessage...");
      }
    }

    // 2. Fallback: Send rich text message with clickable PDF link
    const msgApi = "https://api.telegram.org/bot" + token + "/sendMessage";
    const fallbackText = caption + "\n\n📄 <b>Download Anchor Report:</b> <a href=\"" + pdfUrl + "\">Click to Open PDF</a>\n🌐 <b>Live Tracker:</b> <a href=\"https://pmilan24.github.io/gmpupdatepremium/anchor.html\">View IPO Dashboard</a>";

    const res = await fetch(msgApi, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: fallbackText,
        parse_mode: "HTML",
        disable_web_page_preview: false
      })
    });
    const data = await res.json();
    return { success: data.ok, description: data.description, method: "sendMessage" };
  } catch (err) {
    console.error("[TELEGRAM] Request failed:", err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Dispatch NTFY.sh Instant Mobile Push Alert
 */
async function sendNtfyAlert({ topic, ipo, pdfUrl, title, message }) {
  if (!topic) {
    return { skipped: true, reason: "NTFY_TOPIC not provided" };
  }

  const cleanTopic = topic.trim();
  const url = "https://ntfy.sh/" + cleanTopic;

  try {
    const cleanTitle = (title || 'New Anchor Report Detected').replace(/[^\x00-\x7F]/g, '').trim();
    const headers = {
      'Title': cleanTitle || 'New Anchor Report Detected',
      'Priority': 'urgent',
      'Tags': 'rotating_light,newspaper,chart_with_upwards_trend'
    };

    if (pdfUrl && pdfUrl.startsWith('http')) {
      headers['Click'] = pdfUrl;
      headers['Attach'] = pdfUrl;
      headers['Actions'] = `view, Open PDF, ${pdfUrl}; view, Open Tracker, https://pmilan24.github.io/gmpupdatepremium/anchor.html`;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: message
    });

    if (res.ok) {
      console.log("[NTFY] ✅ Dispatched push notification to topic '" + cleanTopic + "'");
      return { success: true };
    } else {
      const errText = await res.text();
      console.warn("[NTFY] Request returned " + res.status + ": " + errText);
      return { success: false, error: errText };
    }
  } catch (err) {
    console.error("[NTFY] Request failed:", err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Check IPOs and dispatch instant alerts for newly released Anchor reports
 */
async function checkAndNotifyNewAnchors(ipos = [], options = {}) {
  const telegramToken = options.telegramToken || process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = options.telegramChatId || process.env.TELEGRAM_CHAT_ID;
  const ntfyTopic = options.ntfyTopic || process.env.NTFY_TOPIC;
  const isDryRun = options.dryRun || false;

  const notifiedMap = loadNotifiedSet();
  const results = [];

  for (const ipo of ipos) {
    const isAnchorAvailable = ipo.anchor && ipo.anchor.available;
    if (!isAnchorAvailable) continue;

    const id = ipo.id || ("IPO_" + ipo.symbol);
    // If already notified in a prior run, skip to avoid spamming
    if (notifiedMap[id]) continue;

    // Pick best PDF download URL
    const pdfUrl = (ipo.anchor.bseIntimationPdfUrl && ipo.anchor.bseIntimationPdfUrl.startsWith("http"))
      ? ipo.anchor.bseIntimationPdfUrl
      : (ipo.anchor.bseNoticePdfUrl && ipo.anchor.bseNoticePdfUrl.startsWith("http"))
        ? ipo.anchor.bseNoticePdfUrl
        : (ipo.anchor.nseZipUrl && ipo.anchor.nseZipUrl.startsWith("http"))
          ? ipo.anchor.nseZipUrl
          : (ipo.anchor.nsePdfUrl || "");

    const company = ipo.companyName || ipo.symbol;
    const nowIST = getNowISTString();
    const exchange = ipo.exchange || "NSE / BSE";
    const price = ipo.issuePrice && ipo.issuePrice !== "—" ? ipo.issuePrice : "Price Band Active";
    const dates = (ipo.issueStartDate || "—") + " to " + (ipo.issueEndDate || "—");

    const caption = "🏛️ <b>NEW ANCHOR REPORT DETECTED!</b>\n\n" +
      "🏢 <b>Company:</b> " + company + " (" + ipo.symbol + ")\n" +
      "📊 <b>Exchange:</b> " + exchange + "\n" +
      "💰 <b>Issue Price:</b> " + price + "\n" +
      "📅 <b>IPO Dates:</b> " + dates + "\n" +
      "⏰ <b>Alert Time:</b> " + nowIST + "\n\n" +
      "⚡ <i>Instantly detected by background anchor sync</i>";

    const ntfyTitle = "🏛️ Anchor Released: " + ipo.symbol;
    const ntfyMessage = company + "\nDates: " + dates + " · Price: " + price + "\nTap to download Anchor allocation PDF.";

    console.log("[NOTIFY] 🚀 Dispatching alerts for newly detected anchor: " + ipo.symbol + " (" + company + ")");

    const result = {
      id,
      symbol: ipo.symbol,
      company,
      pdfUrl,
      telegram: null,
      ntfy: null
    };

    if (!isDryRun) {
      // 1. Telegram
      result.telegram = await sendTelegramAlert({
        token: telegramToken,
        chatId: telegramChatId,
        ipo,
        pdfUrl,
        caption
      });

      // 2. NTFY Mobile Push
      result.ntfy = await sendNtfyAlert({
        topic: ntfyTopic,
        ipo,
        pdfUrl,
        title: ntfyTitle,
        message: ntfyMessage
      });

      // Mark as notified
      notifiedMap[id] = {
        symbol: ipo.symbol,
        notifiedAtIST: nowIST,
        notifiedAtEpoch: Date.now(),
        pdfUrl
      };
    } else {
      console.log("[NOTIFY] (Dry-Run) Alert prepared for " + ipo.symbol + ". No messages dispatched.");
    }

    results.push(result);
  }

  if (!isDryRun && results.length > 0) {
    saveNotifiedSet(notifiedMap);
  }

  return results;
}

module.exports = {
  checkAndNotifyNewAnchors,
  sendTelegramAlert,
  sendNtfyAlert,
  loadNotifiedSet,
  saveNotifiedSet
};