# Hawaldar Architecture

Hawaldar is a local, AI-native **authorized reconnaissance** workstation. The agent runtime is Mastra. The preferred shell is the standalone Electron app in `desktop/`; the VS Code fork under `vscode/` is a reference.

## Shape

```
desktop/                         Electron app (preferred)
├── main                         Mastra + policy + Podman IPC
├── preload                      contextBridge
└── renderer                     chat, catalogs, settings

vscode/extensions/hawaldar/      Reference extension (same core ideas)
```

No extra HTTP server. The model never receives `exec` / `spawn` / `shell`. Only `sandbox/runner.ts` may spawn, and only the Podman binary.

## Mastra surfaces in the workbench

Wired: agents, subagents, workflows, tools, memory (`@mastra/memory` + LibSQL), Pino logger, observability traces, model router / providers.

Not shipped as product UI: Mastra Studio, Cloud, voice, RAG, evals, observational memory.

## Tools

Hawaldar owns the tools. They run in Podman images behind the policy gate.

| Agent | Tools |
| --- | --- |
| nmap | discover-hosts, quick-scan, scan-ports (tcp_connect), detect-services |
| tshark | analyze_pcap, get_summary_stats, get_conversations |
| ghidra | list_methods, list_imports, list_exports, list_strings, decompile_function |
| radare | r2_info, r2_functions, r2_imports, r2_strings |
| binwalk | binwalk_scan, binwalk_entropy |
| ProjectDiscovery | subfinder, dnsx, httpx, naabu, katana, nuclei (info/tech only) |
| ffuf | ffuf_dir (built-in short wordlist) |
| amass | amass (passive) |

Refused: Metasploit, SQLMap, `extract_credentials`, stealth nmap types, NSE vuln/exploit, `ghidra.eval`, raw `r2_command`, `shell_command`.

## Workflows

- `authorized-recon` — discover → quick-scan → detect-services
- `pd-recon` — subfinder → dnsx → httpx
- `binary-triage` — Ghidra functions + r2 info + binwalk
- `pcap-review` — pcap stats, conversations, and packet JSON
