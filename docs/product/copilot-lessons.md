# Copilot lessons for Hawaldar

## Status

Product note (not a binding ADR). Lessons only. Do not vendor GitHub Copilot or copy `vscode/extensions/copilot`.

## Sources (2026)

Public VS Code / Copilot Chat docs and the July 2026 changelog (VS Code 1.127–1.131): chat surfaces, agents/edits, slash commands, `#` / `@` context, MCP, model picker / BYOK, voice dictation, multi-file review, session fork. Hawaldar facts are from `hawaldar-app/src` (renderer + Mastra runtime), not from a VS Code tree.

The `vscode/` tree is Microsoft Code-OSS plus GitHub Copilot Chat (`extensions/copilot`, publisher GitHub). ADR 0010 already says: do not set Copilot as `defaultChatAgent`. Treat that tree as a reference workbench, never as a source of Copilot UX or tool code.

## Already in Hawaldar

Hawaldar is an authorized-recon workstation, not a code IDE. Several Copilot *patterns* already exist as native surfaces:

| Copilot pattern | Hawaldar today |
| --- | --- |
| Chat view + streaming | `Chat.tsx` — threads, markdown, composer |
| Slash commands | `/` anywhere in the composer; chips; tools, specialists, workflows, `/status`, `/readiness`, `/clear`, … (`prompts.ts`) |
| Agent picker | Orchestrator + specialists in the composer toolbar |
| Model picker / BYOK | Provider + searchable model list, free-only filter, thinking toggle (`model-catalog.ts`, Settings) |
| Session history | Sidebar threads, pin, retention, tab restore (`workspaceTabs.ts`) |
| Tabs next to chat | Chat / note / task / tasks board / graph (`TabStrip`, `RightPanel`) |
| Activity / tool trail | Per-message tool start/done, breadcrumb, “Used N tools” (`chat-activity.ts`) |
| Approvals | HITL modal for **Podman machine** and **tool-image start** only (`hitl.ts`, `HitlConfirm.tsx`) |
| Command menu | Right-click `CommandMenu` (create/open). Not a Ctrl/Cmd+K palette |
| Workspace index (backend) | Lance + keyword RAG; notes/tasks/chats/playbooks ingested; `knowledge-search`; graph (`knowledge/`) |
| Subagents / plans | Mastra specialists + playbook workflows (not Copilot `/plan`) |
| Contained browser | Podman Chromium tools — policy-gated, not host Chrome |
| Contained scrapling | Podman Scrapling Fetcher — policy-gated page extract / adaptive CSS/XPath |

Hawaldar already exceeds Copilot on **policy**: scope is injected every turn, the model never gets `exec`/`spawn`/`shell`, and MCP names are stripped from product UI (`toPublicTool`, `EXCLUDED_MCP_TOOLS`).

Gaps vs Copilot Chat (by design or missing): no inline ghost completions, no host terminal / `!` prefix, no operator-installable MCP, no voice, no `@` / `#` context chips, no accept/reject of proposed writes, composer locks while tools run.

## Integrate next (recon-native)

Copy the *job*, not the widget. Skip anything that implies a host shell, a plugin marketplace, or auto-approve of gated tools.

1. **`@` / Add Context for engagement objects**  
   Copilot’s `#file` / Add Context. Hawaldar should attach **notes, tasks, scope hosts, workspace files** (`~/.hawaldar/workspace` pcaps/reports), and **graph nodes** as composer chips. RAG already runs silently on each prompt (`runtime.streamAgent`); the operator cannot pin “this note” or “this pcap”. Highest leverage, small UI, no new privilege.

2. **Accept / reject proposed artifacts (not scans)**  
   Copilot Edits review. After a turn, if the agent wants to write a note, task, or graph edge, show Keep / Edit / Discard. HITL today is only `podman` | `tool-image`. Policy already decided the scan; the operator should still own the engagement record.

3. **Tool-result review cards**  
   Activity is a breadcrumb; evidence lands in markdown. Add Keep / Open as note / Pin to graph on a finished tool card. This is the recon equivalent of inline accept/reject — not ghost-text in a code editor.

4. **Steer or queue while tools run**  
   Copilot queue/steer. Composer is busy-locked (`Running tools…`). Long nmap / httpx / Ghidra runs need “add this host next” or “stop after this tool” without killing the container blindly.

5. **Engagement index as product UI**  
   Copilot `#codebase`. `KnowledgeStore` + `reindexKnowledge` exist; `ARCHITECTURE.md` still lists RAG as not shipped UI. Show what is indexed, last sync, and a force-reindex. Graph tab is visualization, not an index control.

6. **Voice dictation in the composer**  
   Copilot’s July 2026 built-in dictation. Use the Chromium Web Speech API in the renderer — do not ship Mastra Cloud voice (`ARCHITECTURE.md`). Useful while reading a scan. Expect weaker Linux OS speech stacks.

7. **Fork + compact a session**  
   Copilot `/fork` and `/compact`. Recon threads grow past the context window. Fork a hypothesis from a scan thread; compact old tool dumps into a knowledge snippet. `/clear` already starts a new thread and drops history.

## Do not take from Copilot

- **Inline completions / editor Inline Chat** — Hawaldar is not a coding IDE. Notes are markdown, not a completion host.
- **Host terminal, `!` commands, `#execute/runInTerminal`** — contradicts the spawn boundary (`sandbox/runner.ts` → Podman/Docker only).
- **Operator MCP / extension host** — Copilot’s strength is a marketplace. Hawaldar owns the catalog. Mapping MCP *names* into gated adapters (ADR 0003 / 0010) is fine; loading arbitrary MCP servers is not.
- **`/yolo` / global auto-approve** — HITL and policy stay human. Never auto-start images or skip scope.
- **Any file under `vscode/extensions/copilot`** — proprietary GitHub/Microsoft code. Lessons and Hawaldar-native designs only.

## Cross-platform: not the same as Copilot

**Verdict:** Same *OS names* (Windows, macOS, Linux), much less *product* maturity. Copilot/VS Code is a signed, auto-updated, ARM-ready IDE with one chat/agent UX everywhere. Hawaldar is a source-run Electron app (`electron-vite` + Electron 34) whose real backend is a **container engine**, and that backend is not the same on each OS.

`hawaldar-app/package.json` ships electron-builder targets (NSIS / DMG / AppImage / deb). Daily work is `scripts\setup.bat` once, then `scripts\dev.bat` only. `scripts\dist.bat` is a separate packaging step after you stop dev (never chain setup → dev → dist).

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| App process | Electron | Electron | Electron |
| Containers | Podman machine (WSL or Hyper-V); UAC + winget/MSI install | Podman machine (Apple HV / QEMU); Homebrew install | Native Podman or existing Docker; **no sudo install** |
| Localhost from a tool | `host.containers.internal` (VM, not the host loopback) | same gateway alias | `--network host`; `127.0.0.1` is the operator |
| First-run | Minutes (WSL/VM) | Minutes (VM) | Locate binaries; daemon must already run |

Honest gaps vs Copilot’s cross-platform bar:

- **Installers, signing, SmartScreen, notarization, auto-update** — absent.
- **Windows ARM:** `@libsql/client` in the lockfile ships `win32-x64-msvc` only. LanceDB has `win32-arm64`. Memory/SQLite is the hard stop on ARM Windows.
- **Apple Silicon / Linux ARM:** Electron and LibSQL have darwin/linux arm64; images are local `alpine` Containerfiles with no published multi-arch list. Fine for “build on this machine,” not for shipping one image set.
- **WSL/VM reliability** is the Windows/macOS product, not a footnote. Linux is the mature container host.
- A `vscode/` fork is not part of this product. Prefer `hawaldar-app/`.

Hawaldar can be *used* on the same three desktops Copilot supports. It is not *as mature* on them, and it should not pretend the Podman VM is an implementation detail.

## Consequence

Stay on the Electron workstation. Steal Copilot’s **context, review, and mid-run control** patterns. Do not steal Copilot’s editor, marketplace, or tree.
