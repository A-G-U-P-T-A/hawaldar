# Hawaldar app

Standalone Electron workstation for authorized reconnaissance. Tools run only in Podman (or Docker if you already have it). Proof-of-concept probes are human-approved, non-destructive, and in-scope only.

This is not an exploit platform. PoC HITL is per-probe. Legal LICENSE text is English; the UI language picker is convenience-only.

Apache-2.0 plus authorized-use terms: first-run **Legal** page and **Settings → Legal**. Acceptance is stored in `~/.hawaldar/settings.json`. Decline quits. See `LICENSE`, `LICENSE-USAGE.md`, and `NOTICE` in this folder (also at the repo root).

## Requirements

- Node.js 22+
- Podman (Windows needs WSL or Hyper-V)
- An LLM API key in Settings

## Setup / dev / dist

Windows:

```bat
scripts\setup.bat
scripts\dev.bat
scripts\dist.bat
```

macOS / Linux:

```bash
chmod +x scripts/*.sh
./scripts/setup.sh
./scripts/dev.sh
./scripts/dist.sh
```

`setup` checks Node 22+, runs `npm ci` or `npm i`, then `scripts/ensure-electron.mjs` so `node_modules/electron/path.txt` exists. After `npm run dist`, electron-builder often leaves Electron uninstalled; `dist` scripts and the npm `postinstall` restore it. If `npm run dev` fails with `Error: Electron uninstall`, run `npm run ensure-electron`.

Equivalent npm:

```
npm i
npm run typecheck
npm run dev
npm run dist
```

electron-builder targets: NSIS (Windows x64; ia32 is not built), DMG + ZIP (macOS), AppImage + deb (Linux). Unsigned builds show “unknown publisher” until `CSC_LINK` (and Apple notarization env on macOS). See `../docs/releasing.html` in the public docs site.

## Architecture

- **Main process** — Mastra runtime, policy, container sandbox (Podman or Docker; only spawn path)
- **Preload** — `contextBridge` IPC
- **Renderer** — chat, catalogs, settings, i18n chrome (`src/renderer/src/i18n/`)
- **Shared workspace** — `~/.hawaldar/workspace`. Every tool run bind-mounts it at `/workspace`.

Hawaldar owns the tools; they run in Podman images. No host shell for the model. Browser recon is contained Chromium. Metasploit is search + auxiliary/scanner only.
