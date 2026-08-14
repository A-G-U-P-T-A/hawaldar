# Hawaldar

Authorized reconnaissance workstation. Policy is the authority on scope. Tools run only in Podman.

Not an exploitation platform. Metasploit, SQLMap, credential dumping, and host shells are not wired.

## Preferred: standalone Electron app

```bash
cd desktop
npm i
npm run dev
```

Needs Node 20+. Open **Settings** for provider, API key, Podman path, and engagement scope. Chat supports `/status`, `/tools`, `/workflow`, specialists (`/nmap`, …). Memory is LibSQL at `~/.hawaldar/mastra.db`.

See `desktop/README.md`.

## Reference: VS Code fork

The `vscode/` submodule remains a reference (Code-OSS + `extensions/hawaldar`). Building it requires Node 24.18+, Spectre MSVC libs on Windows, and a long `npm i` / `npm run watch`. Prefer `desktop/` for day-to-day use.

## Tools

Hawaldar owns the recon and analysis tools. They run in Podman images behind the policy gate.

See `ARCHITECTURE.md` for the catalog and the refused list.
