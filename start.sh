#!/bin/bash
# Margin: install (first run) and start. Safe to run any time.
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v node >/dev/null; then echo "Node 22+ is required (https://nodejs.org)"; exit 1; fi
[ -d node_modules ] || npm install --no-fund --no-audit
npx vite build --config web/vite.config.ts --logLevel error
node scripts/install.mjs "$@"
