#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

need=22
major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || true)"
if [[ -z "${major}" || "${major}" -lt "${need}" ]]; then
	echo "Node ${need}+ is required (found $(node -v 2>/dev/null || echo none))."
	exit 1
fi

if [[ -f package-lock.json ]]; then
	if ! npm ci; then
		echo "npm ci failed, falling back to npm install..."
		npm install
	fi
else
	npm install
fi
if [[ ! -x node_modules/.bin/electron-vite || ! -x node_modules/.bin/tsc ]]; then
	echo "Install incomplete: electron-vite or tsc is missing."
	exit 1
fi
node scripts/ensure-electron.mjs
echo "Setup complete. Run scripts/dev.sh or npm run dev."
