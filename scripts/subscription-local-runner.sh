#!/bin/zsh
set -euo pipefail

repo_dir="/Users/milan/Documents/GitHub/gmpupdatepremium"
cd "$repo_dir"

node local-subscription-runner.js
