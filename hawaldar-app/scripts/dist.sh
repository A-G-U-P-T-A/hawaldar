#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
echo "Dist is a separate step. Do not chain this after scripts/dev.sh — stop dev first, then run dist."
if [[ ! -d node_modules ]]; then
	"$(dirname "$0")/setup.sh"
fi
node scripts/ensure-electron.mjs
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json
npx electron-vite build
npx electron-builder
node scripts/ensure-electron.mjs
echo "Dist finished. Electron binary restored for npm run dev."
