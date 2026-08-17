#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ ! -d node_modules ]]; then
	npm install
fi
node scripts/ensure-electron.mjs
npm run typecheck
npm run dist
node scripts/ensure-electron.mjs
echo "Dist finished. Electron binary restored for npm run dev."
