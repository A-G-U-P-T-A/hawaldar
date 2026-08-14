# Hawaldar Desktop

Standalone Electron app for authorized reconnaissance. Extracts Mastra agents, policy, and Podman-gated tools from the VS Code fork extension.

## Run

```powershell
cd desktop
npm i
npm run dev
```

Requires Node 20+. Configure a provider/API key and scope in **Settings**. For scans, open **Podman**. Setup follows this OS: Windows (winget/MSI + UAC + WSL/Hyper-V), macOS (Homebrew + Podman machine), Linux (locate existing Podman or Docker — no sudo). If Docker is already installed, choose **Use Docker instead** (same OCI images). Hawaldar does not install Docker Desktop. Tools never run on the host.

## Architecture

- **Main process** — Mastra runtime, policy, container sandbox (Podman or Docker; only spawn path)
- **Preload** — `contextBridge` IPC
- **Renderer** — chat, catalogs, settings
- **Shared workspace** — `~/.hawaldar/workspace` (created on app start and during **Set up Podman**). Every tool run bind-mounts it at `/workspace` (`HAWALDAR_WORKSPACE=/workspace`). Ephemeral `podman run --rm` / `docker run --rm` — 0 RAM until a tool is called. Same folder in every container; no copying between tools. **Set up Podman** owns install + machine + workspace; it does not start idle tool containers.

## Brand

Source mark: `resources/brand/hawaldar.svg`. Window / taskbar / dock PNG: `resources/brand/hawaldar.png` (512px; regenerate with `npm run brand:png`). electron-vite serves that folder as the renderer `publicDir` (favicon). A copy also lives at `src/renderer/hawaldar.svg`.

Hawaldar owns the tools; they run in Podman images. No host shell for the model. Metasploit / SQLMap / credential dump / stealth nmap are refused.
