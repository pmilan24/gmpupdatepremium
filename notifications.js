// notifications.js - 100% Free Instant Telegram Anchor Alert & PDF Dispatcher
const fs = require("fs");
const path = require("path");
const SOURCES = require("./sources");

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
 * Dispatch Telegram Alert with Direct PDF Document or Link (100% Free)
 */
async function sendTelegramAlert({ token, chatId, ipo, pdfUrl, caption }) {
  if (!token || !chatId) {
    return { skipped: true, reason: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not provided" };
  }

  const docApi = "https://api.telegram.org/bot" + token + "/sendDocument";

  try {
    // 1. If local PDF file exists, upload directly via multipart FormData (100% reliable, zero Akamai 503 issues)
    const localPdfPath = path.join(__dirname, "anchors", `ANCHOR_${ipo.symbol}.pdf`);
    if (fs.existsSync(localPdfPath)) {
      try {
        const fileBuffer = fs.readFileSync(localPdfPath);
        const formData = new FormData();
        formData.append("chat_id", chatId);
        formData.append("document", new Blob([fileBuffer], { type: "application/pdf" }), `ANCHOR_${ipo.symbol}.pdf`);
        formData.append("caption", caption);
        formData.append("parse_mode", "HTML");

        const res = await fetch(docApi, {
          method: "POST",
          body: formData
        });
        const data = await res.json();
        if (data.ok) {
          console.log("[TELEGRAM] ✅ Sent local Anchor PDF file to chat " + chatId);
          return { success: true, method: "sendDocument-file" };
        } else {
          console.warn("[TELEGRAM] Direct file upload failed: " + data.description + ". Retrying with URL...");
        }
      } catch (fileErr) {
        console.warn("[TELEGRAM] Local file send error: " + fileErr.message);
      }
    }

    // 2. Attempt to send PDF as document via URL
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
        return { success: true, method: "sendDocument-url" };
      } else {
        console.warn("[TELEGRAM] sendDocument returned: " + data.description + ". Falling back to sendMessage...");
      }
    }

    // 2. Fallback: Send rich text message with direct clickable PDF download link
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
 * Check IPOs and dispatch instant alerts for newly released Anchor reports
 */
async function checkAndNotifyNewAnchors(ipos = [], options = {}) {
  const telegramToken = options.telegramToken || process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = options.telegramChatId || process.env.TELEGRAM_CHAT_ID;
  const isDryRun = options.dryRun || false;

  if (!telegramToken || !telegramChatId) {
    return [];
  }

  const notifiedMap = loadNotifiedSet();
  const results = [];

  for (const ipo of ipos) {
    const isAnchorAvailable = ipo.anchor && ipo.anchor.available;
    if (!isAnchorAvailable) continue;

    const id = ipo.id || ("IPO_" + ipo.symbol);
    // Skip if already alerted in a previous run
    if (notifiedMap[id]) continue;

    function resolveDownloadUrl(rawUrl) {
      if (!rawUrl) return '';
      if (rawUrl.startsWith('http')) return rawUrl;
      if (rawUrl.startsWith('/downloads/')) return `${SOURCES.BSE_BASE_URL}${rawUrl}`;
      if (rawUrl.startsWith('/content/')) return `${SOURCES.NSE_ARCHIVE_URL}${rawUrl}`;
      return rawUrl;
    }

    // Best report URL: prefer actual BSE attachment PDF; do not send outer BSE notice as the primary report.
    const bseAttachmentUrl = ipo.anchor.bseAttachmentPdfUrl
      || ((ipo.anchor.hasBseAttachment || /\/Notices\/Attach\//i.test(ipo.anchor.bseIntimationPdfUrl || '')) ? ipo.anchor.bseIntimationPdfUrl : '');
    const candidateUrl = bseAttachmentUrl
      || ipo.anchor.nsePdfUrl
      || ipo.anchor.nseZipUrl
      || ipo.anchor.bseNoticePdfUrl
      || "";
    const pdfUrl = resolveDownloadUrl(candidateUrl);

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

    console.log("[NOTIFY] 🚀 Dispatching Telegram alert with PDF for: " + ipo.symbol + " (" + company + ")");

    const result = {
      id,
      symbol: ipo.symbol,
      company,
      pdfUrl,
      telegram: null
    };

    if (!isDryRun) {
      result.telegram = await sendTelegramAlert({
        token: telegramToken,
        chatId: telegramChatId,
        ipo,
        pdfUrl,
        caption
      });

      // Mark as notified so you never get duplicates
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
  loadNotifiedSet,
  saveNotifiedSet
};