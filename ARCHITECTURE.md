# Hawaldar Architecture

Hawaldar is a local, AI-native **authorized engagement** workstation — reconnaissance plus bounded, HITL-gated PoC validation. The agent runtime is Mastra. The shell is the standalone Electron app in `hawaldar-app/`.

## Shape

```
hawaldar-app/                    Electron app
├── main                         Mastra + policy + Podman IPC
├── preload                      contextBridge
└── renderer                     chat, catalogs, settings, i18n chrome
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
| dns | dns-resolve, dns-records, dns-ptr, dns-ns, dns-mx, dns-txt, dns-cname, dns-soa, dns-axfr-check (permit only); also dnsx / subfinder / amass |
| tshark | analyze_pcap, get_summary_stats, get_conversations |
| ghidra | list_methods, list_imports, list_exports, list_strings, decompile_function |
| radare | r2_info, r2_functions, r2_imports, r2_strings |
| binwalk | binwalk_scan, binwalk_entropy |
| ProjectDiscovery | subfinder, dnsx, httpx, naabu, katana, nuclei (info/tech only) |
| ffuf | ffuf_dir (built-in short wordlist) |
| amass | amass (passive) |
| metasploit | msf-search, msf-info, msf-aux-scan, http/smb/ssh version (auxiliary/scanner only) |
| browser | browser-search, browser-open, browser-snapshot, browser-console, browser-network, browser-links (contained Chromium) |
| scrapling | scrapling-fetch, scrapling-text, scrapling-links, scrapling-select, scrapling-adaptive (contained HTTP Fetcher + adaptive CSS/XPath) |
| poc | poc-request, poc-act, poc-xss-canary (contained browser image; per-probe HITL approval; non-destructive) |
| findings | finding-record, finding-list, finding-export (runtime meta tools over the findings store) |

Refused: msfvenom, exploit/payload/post, SQLMap, `extract_credentials`, stealth nmap types, NSE vuln/exploit, `ghidra.eval`, raw `r2_command`, `shell_command`, host Chrome, password/cookie harvest, `javascript:` XSS proofs, scrapling Python eval, CAPTCHA/WAF-attack kits. PoC probes additionally refuse DELETE, data-mutating SQL, timing delays over 5s, and cookie/storage/network exfiltration.

## Findings and the engagement rail

Agents record findings through the `finding-*` meta tools into a LibSQL store (`~/.hawaldar/findings.db`). A `confirmed` finding requires reproduction steps plus tool evidence — enforced by the store, not the prompt. `finding-export` renders a Markdown report into `~/.hawaldar/workspace/reports/`.

The Findings tab (workspace page) shows the live engagement phase rail (in-memory `EngagementTracker`, fed by `runSequentialSteps`), severity/status/class filters, and expandable finding cards with PoC steps, evidence, impact, and remediation.

The `poc-*` agents prove hypotheses through three bounded tools, each gated by a per-probe `poc-probe` HITL approval: `poc-request` (single HTTP probe), `poc-act` (short contained-browser flow, e.g. register a test user), `poc-xss-canary` (window-marker canary, no exfiltration). All run in the contained browser image against in-scope URLs only.

## Workflows

- `authorized-recon` — discover → quick-scan → detect-services
- `pd-recon` — subfinder → dnsx → httpx
- `binary-triage` — Ghidra functions + r2 info + binwalk
- `pcap-review` — pcap stats, conversations, and packet JSON
- `zap-scan` — zap-status → zap-spider → zap-pscan (safe subset; active scan stays a separate HITL-gated tool)

## Bounded intrusive engines (ZAP / SQLMap / Metasploit)

Three real engines run behind the same gates (policy scope → service HITL → per-run HITL for the intrusive calls). All per-run approvals use the `poc-probe` HITL kind with a tool-built summary (module/URL, flags, boundaries) shown before anything runs.

| Agent | Tools | Boundary |
| --- | --- | --- |
| zap | zap-status, zap-spider, zap-pscan, zap-history, zap-alerts (safe); zap-ascan (HITL, shared with poc-*) | Daemon API only, no host shell |
| sqlmap | sqlmap-scan (HITL, shared with poc-injection) | Proof of injectability only; extraction refused in code |
| metasploit | msf-search, msf-info, msf-aux-scan, version shortcuts; msf-check, msf-run (HITL) | exploit/* + auxiliary/scanner/* only; sessions auto-killed |

**ZAP daemon lifecycle.** ZAP is the one long-running tool. `zap-status` (or any zap tool) starts it on demand after the service HITL gate: `podman run -d --name hw-zap -p 127.0.0.1:8090:8090 --add-host <host-gateway>:host-gateway -e ZAP_API_KEY=<per-start key>`. The API key is generated host-side per daemon start, stored in `~/.hawaldar/zap-daemon.json` (0600), sent only as the `X-ZAP-API-Key` header, and never logged. `ensureDaemon` is idempotent: a running `hw-zap` is reused when its key still answers, otherwise the container is recreated with a fresh key. The hw-* name means quit teardown and stop_service reap it. The daemon publishes loopback only; the operator may proxy their own browser or Burp through 127.0.0.1:8090 to share the session. zap-ascan stays on the scope-gated URL's host; alerts are filtered to that host, capped at 200, and secret-redacted. Loopback targets are rewritten to the host-gateway alias for the daemon container.

**SQLMap bounds.** `sqlmap-scan` builds the entire argv host-side from a strict allowlist: `-u <url> --batch --level ≤2 --risk ≤2 --technique ⊂{B,E,U,S,T} --forms --crawl ≤1 --timeout ≤60 --retries ≤2` plus fingerprint flags `--banner --current-user --current-db --dbs`. Refused on raw input and on the final argv: `--dump/--dump-all`, `--os-shell/--os-pwn`, `--file-read/--file-write`, `--passwords/--users/--privileges/--roles`, `--sql-query/--sql-shell`, `--eval`, `--tor`, tamper scripts, non-scope proxies. Raw flag strings are never passed through. Output parsing extracts injectable-parameter lines, the DBMS fingerprint, and a capped (4 KB) evidence excerpt.

**Metasploit runs.** `msf-check` runs a module's read-only `check` (exploit/* and auxiliary/*) and parses the `[+]`/`[-]` verdict. `msf-run` executes exploit/* and auxiliary/scanner/* only: RHOSTS is scope-gated, payloads are optional and bind/reverse only (persistence/VNC/metsvc refused), the run always appends `run -z` / `exploit -z` so any session is backgrounded, then `sessions -K` kills opened sessions before exit. Console output (capped at 6 KB) is the evidence. post/*, msfvenom, and login/credential/dump modules stay refused.
- `pre-recon` — Semgrep SAST (list / scan / OWASP pack) + research brief
- `source-review` — Semgrep scan of one path + research brief
- `recon-surface` — DNS, top ports, naabu, httpx, subfinder, katana, scrapling, browser open
- `web-recon` — httpx tech, katana, scrapling fetch/links, browser open/links
- `vuln-detect` — vuln-injection / vuln-xss / vuln-ssrf / vuln-auth hypothesis agents
- `poc-validate` — poc-injection / poc-xss / poc-ssrf / poc-auth proof agents (HITL-gated)
- `validate` — validation agent cross-checks evidence and status
- `report` — reporting agent renders the engagement report
- `correlate-report` — validation → reporting
- `full-engagement` — pre-recon → recon-surface → vuln-detect → poc-validate → validate → report
