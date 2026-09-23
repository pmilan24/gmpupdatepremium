#!/bin/zsh
set -euo pipefail

repo_dir="/Users/milan/Documents/GitHub/gmpupdatepremium"
label="com.gmpupdatepremium.subscription"
plist="$HOME/Library/LaunchAgents/$label.plist"
log_dir="$repo_dir/logs"

mkdir -p "$HOME/Library/LaunchAgents" "$log_dir"
chmod +x "$repo_dir/scripts/subscription-local-runner.sh"

cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$repo_dir/scripts/subscription-local-runner.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$repo_dir</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$log_dir/subscription-local.out.log</string>
  <key>StandardErrorPath</key>
  <string>$log_dir/subscription-local.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$plist"
launchctl kickstart -k "gui/$(id -u)/$label"

echo "Installed and started $label"
echo "Logs:"
echo "  $log_dir/subscription-local.out.log"
echo "  $log_dir/subscription-local.err.log"
