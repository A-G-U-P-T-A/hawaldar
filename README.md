# Hawaldar

Authorized reconnaissance workstation. Policy is the authority on scope. Tools run only in Podman. Proof-of-concept validation is bounded: every PoC probe is approved per-probe in the app, non-destructive, and limited to in-scope targets.

This is **not an exploit platform**. Metasploit is search and auxiliary scanners (HITL for intrusive runs). Host shells, credential dumping, and payload generation are not wired.

Licensed under [Apache License 2.0](LICENSE). Authorized use — own systems, written permission, or a contracted engagement — is in [LICENSE-USAGE.md](LICENSE-USAGE.md). That notice is not a clickwrap substitute. The first-run **Legal** gate records that you saw these terms. UI translations are convenience-only; legal LICENSE text stays English.

**Podman is required.** Without a container engine, tools do not run. First-run and the installer point at in-app **Set up Podman** (Windows: WSL or Hyper-V). Do not expect a silent Podman install.

## Requirements

- Node.js 22 or newer
- [Podman](https://podman.io/) (or Docker if you already have it)
- An LLM provider API key (OpenRouter, OpenAI, Anthropic, or a local OpenAI-compatible endpoint)

## Run locally

Windows:

```bat
cd hawaldar-app
scripts\setup.bat
scripts\dev.bat
```

macOS / Linux:

```bash
cd hawaldar-app
chmod +x scripts/*.sh
./scripts/setup.sh
./scripts/dev.sh
```

Equivalent: `npm i` then `npm run dev` in `hawaldar-app/`. Electron 43 does not download its binary in the npm package postinstall. `scripts/ensure-electron.mjs` (wired as npm `postinstall` and before `npm run dev` / `npm run dist`) runs `node_modules/electron/install.js` when `path.txt` or `dist/electron.exe` is missing. After a packaged `npm run dist`, that restore is required or electron-vite throws `Error: Electron uninstall`.

Open **Settings** for provider, API key, Podman path, engagement scope, and UI language (English, Español, हिन्दी, Deutsch, 日本語).

## Package

```bat
cd hawaldar-app
scripts\dist.bat
```

Targets: NSIS (Windows x64), DMG + ZIP (macOS), AppImage + deb (Linux x64). Unsigned betas are expected until `CSC_LINK` (and Apple notarization env on macOS) is set. See [docs/releasing.html](docs/releasing.html).

## Docs

- [Getting started](docs/getting-started.html)
- [Install](docs/install.html)
- [Podman](docs/podman.html)
- [Legal](docs/legal.html)
- [Building from source](docs/building.html)
- [Releasing](docs/releasing.html)

After GitHub Pages is enabled: https://a-g-u-p-t-a.github.io/hawaldar/

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md).
