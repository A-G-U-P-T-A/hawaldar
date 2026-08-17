#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "Stopping leftover Hawaldar/Electron (Cursor is left running)..."
pkill -f "$ROOT/node_modules/electron/dist" >/dev/null 2>&1 || true

if [[ ! -d node_modules/electron-vite ]]; then
	echo "Missing node_modules. Run scripts/setup.sh once, then this script again."
	echo "Do not chain setup/dev/dist. dist is a separate step after you stop dev."
	exit 1
fi

ELECTRON_BIN=""
if [[ "$(uname -s)" == "Darwin" ]]; then
	ELECTRON_BIN="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
else
	ELECTRON_BIN="node_modules/electron/dist/electron"
fi

if [[ -x "$ELECTRON_BIN" ]]; then
	if [[ ! -f node_modules/electron/path.txt ]]; then
		if [[ "$(uname -s)" == "Darwin" ]]; then
			printf '%s\n' 'Electron.app/Contents/MacOS/Electron' > node_modules/electron/path.txt
		else
			printf '%s\n' 'electron' > node_modules/electron/path.txt
		fi
	fi
	echo "Electron binary present. Skipping ensure-electron."
else
	echo "Electron binary missing. Restoring..."
	node scripts/ensure-electron.mjs
fi

echo "Starting electron-vite dev..."
exec ./node_modules/.bin/electron-vite dev
