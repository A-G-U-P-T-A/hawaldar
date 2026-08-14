# Hawaldar Architecture

Hawaldar is a local, AI-native **authorized reconnaissance** workstation. The desktop shell is a VS Code fork. The agent runtime is Mastra.

## Shape

```
Hawaldar (Code-OSS fork)
├── Workbench
├── Chat                 @hawaldar + specialist commands
├── Settings window      providers, Podman, scope, tools
└── extensions/hawaldar
        ├── Mastra       agents, workflows, memory, tracing, logging
        ├── tools        MCP-mapped names, Podman execution
        └── policy       scope gate; exploit tools refused
```

No extra HTTP server. The model never receives `exec` / `spawn` / `shell`. Only `sandbox/runner.ts` may spawn, and only the Podman binary.

## Mastra surfaces in the workbench

Wired: agents, subagents, workflows, tools, memory (`@mastra/memory` + LibSQL), Pino logger, observability traces, model router / providers.

Not shipped as product UI: Mastra Studio, Cloud, voice, RAG, evals, observational memory.

## Tools

Public MCP servers define the *names* and *jobs*. Hawaldar reimplements the recon/analysis subset behind policy + Podman.

| Family | MCP source | Hawaldar tools |
| --- | --- | --- |
| Nmap | Vorota-ai/nmap-mcp | discover-hosts, quick-scan, scan-ports (tcp_connect), detect-services |
| tshark | 0xKoda/WireMCP | analyze_pcap, get_summary_stats, get_conversations |
| Ghidra | LaurieWired/GhidraMCP | list_methods, list_imports, list_exports, list_strings, decompile_function |
| radare2 | radareorg/radare2-mcp | r2_info, r2_functions, r2_imports, r2_strings |
| binwalk | FuzzingLabs/binwalk-mcp | binwalk_scan, binwalk_entropy |
| ProjectDiscovery | intelligent-ears/pd-tools-mcp | subfinder, dnsx, httpx, naabu, katana, nuclei (info/tech only) |
| ffuf | FuzzingLabs/ffuf-mcp | ffuf_dir (built-in short wordlist) |
| amass | cyproxio/mcp-for-security | amass (passive) |

Refused from those same ecosystems: Metasploit, SQLMap, `extract_credentials`, stealth nmap types, NSE vuln/exploit, `ghidra.eval`, raw `r2_command`, `shell_command`.

## Workflows

- `authorized-recon` — nmap-mcp sequence: discover → quick-scan → detect-services
- `pd-recon` — subfinder → dnsx → httpx
- `binary-triage` — Ghidra functions + r2 info + binwalk
- `pcap-review` — WireMCP pcap trio
