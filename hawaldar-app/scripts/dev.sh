#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ ! -d node_modules ]]; then
	npm install
fi
node scripts/ensure-electron.mjs
npm run dev
