// test-notify.js - 100% Free Telegram Bot Alert & PDF Delivery Tester
const fs = require("fs");
const { sendTelegramAlert } = require("./notifications");

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

async function runTest() {
  console.log("=================================================");
  console.log("🔔 100% Free Telegram Anchor Alert & PDF Tester");
  console.log("=================================================");

  const sampleIpo = {
    symbol: "TESTIPO",
    companyName: "Test Innovations India Limited",
    exchange: "NSE | BSE",
    issuePrice: "Rs. 250 to Rs. 265",
    issueStartDate: "22-Sep-2026",
    issueEndDate: "24-Sep-2026"
  };
  // Sample test PDF file
  const samplePdfUrl = "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf";

  if (!token || !chatId) {
    console.log("\n⚠️  Telegram Credentials Missing!");
    console.log("   Please provide your Telegram Bot Token and Chat ID:\n");
    console.log("   👉 Command: node test-notify.js --token <BOT_TOKEN> --chat <CHAT_ID>");
    console.log("   👉 Or add them to a .env file:\n      TELEGRAM_BOT_TOKEN=...\n      TELEGRAM_CHAT_ID=...\n");
    console.log("-------------------------------------------------");
    console.log("Quick 2-minute setup:");
    console.log("1. Message @BotFather on Telegram -> /newbot -> copy Token.");
    console.log("2. Message @userinfobot on Telegram -> copy your numeric Id.");
    console.log("3. Send /start to your new bot once, then run this command.");
    console.log("=================================================");
    return;
  }

  console.log("   Token: " + token.slice(0, 6) + "..." + token.slice(-4));
  console.log("   Chat ID: " + chatId);
  console.log("\n🚀 Dispatching test alert with sample PDF to your Telegram...");

  const caption = "🏛️ <b>TEST ANCHOR REPORT ALERT</b>\n\n" +
    "🏢 <b>Company:</b> " + sampleIpo.companyName + " (" + sampleIpo.symbol + ")\n" +
    "📊 <b>Exchange:</b> " + sampleIpo.exchange + "\n" +
    "💰 <b>Issue Price:</b> " + sampleIpo.issuePrice + "\n" +
    "📅 <b>IPO Dates:</b> " + sampleIpo.issueStartDate + " to " + sampleIpo.issueEndDate + "\n\n" +
    "✅ <i>If you received this message and the PDF file, your 100% Free Telegram Bot is WORKING!</i>";

  const res = await sendTelegramAlert({
    token,
    chatId,
    ipo: sampleIpo,
    pdfUrl: samplePdfUrl,
    caption
  });

  console.log("\nTelegram API Result:", res);
  if (res.success) {
    console.log("🎉 SUCCESS! Check your Telegram app — the message and PDF document have arrived!");
  } else {
    console.log("❌ Failed to deliver. Please verify that you started your bot in Telegram by clicking /start.");
  }
  console.log("=================================================");
}

runTest();