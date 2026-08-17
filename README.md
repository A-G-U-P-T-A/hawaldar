# Hawaldar

Authorized engagement workstation. Policy is the authority on scope. Tools run only in Podman. Proof-of-concept validation is built in but bounded: every PoC probe is approved per-probe in the app, non-destructive, and limited to in-scope targets.

Licensed under [Apache License 2.0](LICENSE) (patent grant, company-friendly OSS). Authorized use — own systems, written permission, or a contracted engagement — is in [LICENSE-USAGE.md](LICENSE-USAGE.md). That notice is not a clickwrap substitute.

**Podman is required.** Without a container engine, tools do not run. First-run and the installer point at in-app **Set up Podman** (Windows: WSL or Hyper-V). Do not expect a silent Podman install.

Metasploit is wired for module search and auxiliary scanners only. SQLMap, credential dumping, msfvenom, and host shells are not wired. PoC probes run in the contained browser image and refuse DELETE, data-mutating SQL, and credential/cookie exfiltration. Confirmed findings land in the **Findings** tab with reproduction steps and evidence.

## Build locally

Work only in **`hawaldar-app/`**. Needs Node 22+. `scripts/ensure-electron.mjs` downloads `electron.exe` because Electron 43 has no npm postinstall.

**Daily work (Windows):** `scripts\dev.bat` only. Do not chain `setup.bat` then `dev.bat` then `dist.bat` — `dev` blocks, so `dist` never starts until you Ctrl+C, and that chain is what makes the app look hung.

**First time:** `scripts\setup.bat` once, then `scripts\dev.bat`.

**Installer:** `scripts\dist.bat` in a separate command after you stop dev.

```bat
cd hawaldar-app
scripts\setup.bat
scripts\dev.bat
```

Or `npm i` then `npm run dev`. `npm run dist` is separate.

Installer: `hawaldar-app\release\Hawaldar Setup 0.1.0.exe`

**macOS / Linux:**

```bash
cd hawaldar-app
chmod +x scripts/*.sh
./scripts/setup.sh
./scripts/dev.sh
```

Packaged output is `hawaldar-app/release/` — `.dmg` / `.zip` on macOS, `.AppImage` / `.deb` on Linux. Run `./scripts/dist.sh` only when you want a package, after stopping dev.

`setup` checks Node 22+, runs `npm ci` or `npm i`, then restores Electron. After `dist`, electron-builder often leaves Electron uninstalled; the dist scripts restore it. If `npm run dev` reports `Error: Electron uninstall`, run `npm run ensure-electron`.

Open **Settings** for provider, API key, Podman path, engagement scope, and UI language. Chat supports `/status`, `/tools`, `/workflow`, specialists (`/nmap`, `/dns`, `/browser`, …). Memory is LibSQL at `~/.hawaldar/mastra.db`.

See `hawaldar-app/README.md`.

## Tools

Hawaldar owns the recon and analysis tools. They run in Podman images behind the policy gate.

See `ARCHITECTURE.md` for the catalog and the refused list.
