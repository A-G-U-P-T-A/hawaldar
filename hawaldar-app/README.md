# Hawaldar app

Standalone Electron workstation for authorized reconnaissance. Tools run only in Podman (or Docker if you already have it). Proof-of-concept probes are human-approved, non-destructive, and in-scope only.

This is not an exploit platform. PoC HITL is per-probe. Legal LICENSE text is English; the UI language picker is convenience-only.

Apache-2.0 plus authorized-use terms: first-run **Legal** page and **Settings → Legal**. Acceptance is stored in `~/.hawaldar/settings.json`. Decline quits. See `LICENSE`, `LICENSE-USAGE.md`, and `NOTICE` in this folder (also at the repo root).

## Requirements

- Node.js 22+
- Podman (Windows needs WSL or Hyper-V)
- An LLM API key in Settings

## Setup / dev / dist

From the repo root, `cd hawaldar-app` first (or run these from this folder).

**Daily work:** `scripts\dev.bat` only (macOS/Linux: `./scripts/dev.sh`). It kills leftover Hawaldar/Electron, then runs `electron-vite dev`. It does not run setup, npm, typecheck, or dist.

**First time** (or after deleting `node_modules`): `scripts\setup.bat` once, then `scripts\dev.bat`.

**Installer:** `scripts\dist.bat` in a **separate** command after you stop dev (Ctrl+C). Never chain `setup` → `dev` → `dist`. `dev` is a blocking process, so `dist` will not run until you quit the app, and that chain is what makes Windows installs look hung.

Windows:

```bat
cd hawaldar-app
scripts\setup.bat
scripts\dev.bat
```

Later days:

```bat
cd hawaldar-app
scripts\dev.bat
```

Packaged installer (only when you want an `.exe`, and only after stopping dev):

```bat
cd hawaldar-app
scripts\dist.bat
```

macOS / Linux:

```bash
cd hawaldar-app
chmod +x scripts/*.sh
./scripts/setup.sh
./scripts/dev.sh
```

`setup` stops leftover Hawaldar/Electron processes, runs `npm ci` (falls back to `npm i`), then `scripts/ensure-electron.mjs` so `node_modules/electron/path.txt` exists (Electron 43 has no npm postinstall; do not run ensure-electron during install). After `npm run dist`, electron-builder often leaves Electron uninstalled; `dist` scripts restore it. If `npm run dev` fails with `Error: Electron uninstall`, run `npm run ensure-electron`. `dev` skips that restore when `electron.exe` is already on disk.

Equivalent npm:

```
npm i
npm run typecheck
npm run dev
npm run dist
```

Do not paste those four as one chained command. `npm run dev` blocks like `dev.bat`.

**Installer output** (under `hawaldar-app/release/`):

- Windows: `Hawaldar Setup 0.1.0.exe` (NSIS x64; ia32 is not built)
- macOS: `.dmg` and `.zip`
- Linux: `.AppImage` and `.deb`

Unsigned builds show “unknown publisher” until `CSC_LINK` (and Apple notarization env on macOS). See `../docs/releasing.html` in the public docs site.

## Architecture

- **Main process** — Mastra runtime, policy, container sandbox (Podman or Docker; only spawn path)
- **Preload** — `contextBridge` IPC
- **Renderer** — chat, catalogs, settings, i18n chrome (`src/renderer/src/i18n/`)
- **Shared workspace** — `~/.hawaldar/workspace`. Every tool run bind-mounts it at `/workspace`.

Hawaldar owns the tools; they run in Podman images. No host shell for the model. Browser recon is contained Chromium. Metasploit is search + auxiliary/scanner only.
