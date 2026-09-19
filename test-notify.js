const fs = require("fs");
// test-notify.js - CLI testing tool for Telegram Bot & NTFY Push
const { sendTelegramAlert, sendNtfyAlert } = require("./notifications");

// Load .env if present
if (fs.existsSync(".env")) {
  const envLines = fs.readFileSync(".env", "utf8").split("\n");
  for (const line of envLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx > -1) {
      const k = trimmed.slice(0, idx).trim();
      const v = trimmed.slice(idx + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

// Parse command line flags
const args = process.argv.slice(2);
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx > -1 && args[idx + 1] ? args[idx + 1] : null;
}

const token = getArg("--token") || process.env.TELEGRAM_BOT_TOKEN;
const chatId = getArg("--chat") || process.env.TELEGRAM_CHAT_ID;
const topic = getArg("--topic") || process.env.NTFY_TOPIC;

async function runTest() {
  console.log("=================================================");
  console.log("🔔 Instant Anchor Notification System Test");
  console.log("=================================================");

  const sampleIpo = {
    symbol: "TESTIPO",
    companyName: "Test IPO Innovations Limited",
    exchange: "NSE | BSE",
    issuePrice: "Rs. 250 to Rs. 265",
    issueStartDate: "22-Sep-2026",
    issueEndDate: "24-Sep-2026"
  };
  const samplePdfUrl = "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf";

  // 1. Test Telegram
  console.log("\n[1/2] Testing Telegram Bot Alert (Option 1)...");
  if (!token || !chatId) {
    console.log("⚠️  Skipped Telegram: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not provided.");
    console.log("   Usage: node test-notify.js --token <BOT_TOKEN> --chat <CHAT_ID>");
  } else {
    console.log("   Token: " + token.slice(0, 6) + "..." + token.slice(-4));
    console.log("   Chat ID: " + chatId);
    const caption = "🏛️ <b>TEST ANCHOR REPORT ALERT</b>\n\n" +
      "🏢 <b>Company:</b> " + sampleIpo.companyName + " (" + sampleIpo.symbol + ")\n" +
      "📊 <b>Exchange:</b> " + sampleIpo.exchange + "\n" +
      "💰 <b>Issue Price:</b> " + sampleIpo.issuePrice + "\n\n" +
      "✅ <i>If you received this message and the PDF file, your Telegram Bot is 100% WORKING!</i>";

    const res = await sendTelegramAlert({
      token,
      chatId,
      ipo: sampleIpo,
      pdfUrl: samplePdfUrl,
      caption
    });
    console.log("   Telegram Result:", res);
  }

  // 2. Test NTFY
  console.log("\n[2/2] Testing NTFY Mobile Push Alert (Option 2)...");
  if (!topic) {
    console.log("⚠️  Skipped NTFY: NTFY_TOPIC not provided.");
    console.log("   Usage: node test-notify.js --topic <YOUR_TOPIC_NAME>");
  } else {
    console.log("   Topic: " + topic);
    const res = await sendNtfyAlert({
      topic,
      ipo: sampleIpo,
      title: "Test Anchor Alert: " + sampleIpo.symbol,
      message: "Test IPO Innovations Limited\nPrice: Rs. 250-265\nTap to test PDF download."
    });
    console.log("   NTFY Result:", res);
  }

  console.log("\n=================================================");
  console.log("Test finished.");
}

runTest();