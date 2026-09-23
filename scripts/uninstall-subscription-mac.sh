#!/bin/zsh
set -euo pipefail

label="com.gmpupdatepremium.subscription"
plist="$HOME/Library/LaunchAgents/$label.plist"

launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
rm -f "$plist"

echo "Stopped and removed $label"
