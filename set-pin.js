// set-pin.js - Set or update the 24-hour panel security PIN
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const newPin = process.argv[2];

if (!newPin) {
  console.log("=================================================");
  console.log("🔒 Panel Security PIN Management");
  console.log("=================================================");
  console.log("Usage: node set-pin.js <NEW_PIN>\n");
  console.log("Example:");
  console.log("  node set-pin.js 1234");
  console.log("  node set-pin.js mySecretKey99\n");
  console.log("Default PIN is: 9924");
  console.log("=================================================");
  process.exit(0);
}

const cleanPin = newPin.trim();
const hash = crypto.createHash("sha256").update(cleanPin).digest("hex");

const secPath = path.join(__dirname, "security.js");
if (!fs.existsSync(secPath)) {
  console.error("security.js not found!");
  process.exit(1);
}

let secCode = fs.readFileSync(secPath, "utf8");
// Replace DEFAULT_HASH
secCode = secCode.replace(/const DEFAULT_HASH = "[a-f0-9]+";/, "const DEFAULT_HASH = \"" + hash + "\";");
fs.writeFileSync(secPath, secCode);

console.log("=================================================");
console.log("✅ Security PIN Successfully Updated!");
console.log("=================================================");
console.log("New PIN:        " + cleanPin);
console.log("SHA-256 Hash:   " + hash);
console.log("Saved into:     security.js");
console.log("\nTo apply this to your live site, simply commit and push:");
console.log("  git add security.js && git commit -m \"chore: update security PIN\" && git push");
console.log("=================================================");