# Engagement workflows (Strix / Shannon shape)

This note is for security engineers operating Hawaldar. It records what [Strix](https://github.com/usestrix/strix) and [Shannon](https://github.com/KeygraphHQ/shannon) do, what Hawaldar already shipped, the engagement pipeline we run, and the exploit capability we deliberately do not copy.

Hawaldar is an authorized **enterprise engagement workstation**: reconnaissance, workspace SAST, vuln-class detection, evidence validation, and reporting. Policy still refuses exploit execution. Playbooks are stored in `~/.hawaldar/hawaldar.db` and listed under Settings → Workflows.

## What Strix and Shannon do

### Strix (usestrix/strix)

Strix is an autonomous multi-agent pentest product. Agents share a graph and a sandbox toolkit:

- Recon and OSINT (surface mapping, fingerprinting)
- SAST / DAST
- HTTP intercept proxy, browser automation, shell, and a custom exploit runtime
- Findings with CVSS / OWASP labels, PoCs, and optional auto-fix

The product pitch is **validated exploits**, not scanner noise.

### Shannon (KeygraphHQ/shannon)

Shannon is a white-box web/API pentester. Its published pipeline is:

```
Pre-Reconnaissance (source code scan)
        →
Reconnaissance (attack surface mapping)
        →
   parallel Vuln (Injection) | Vuln (XSS) | …
        →
   parallel Exploit (Injection) | Exploit (XSS) | …     ← not implemented in Hawaldar
        →
Reporting
```

Shannon reports only what it can prove with a working PoC. Exploitation is a first-class phase.

## What Hawaldar already had

Before this pipeline, Hawaldar already gated recon through policy + Podman:

| Area | Tools / agents |
|---|---|
| Host / ports | nmap (TCP connect), naabu |
| DNS | dig image, dnsx, subfinder, amass (passive) |
| HTTP | httpx (title/tech), katana, ffuf (short wordlist), nuclei **info/tech/low only** |
| Web | contained Chromium (`browser-*`), Scrapling (`scrapling-*`) |
| Packets / binaries | tshark, Ghidra, radare, binwalk |
| Knowledge | research specialist, Lance RAG |
| QA / writeup | `validation`, `reporting` agents |
| Metasploit | **read-only search / module info / auxiliary scanners** — no exploit, payload, or session |

Nuclei stays info/tech/low. Exploit templates are not an attack kit.

## Pipeline Hawaldar implements

Shannon’s shape, with Shannon’s exploit agents replaced by **bounded PoC validation** (poc-request / poc-act / poc-xss-canary, sqlmap-scan, zap-ascan — all HITL, non-destructive). Validate is required QA after PoC, not a skip.

```
Pre-recon (source / SAST on ~/.hawaldar/workspace; empty workspace is a gap, not a stop)
        →
Recon (attack surface)
        →
Vuln-class detection (Injection / XSS / SSRF / Auth + version/unpatched banners)
        →
PoC validation (HITL probes: sqlmap-scan + zap-ascan on localhost web, then poc-* agents)
        →
Validate (confirmed vs unconfirmed from tool evidence)
        →
Report (Markdown engagement report)
```

There is no agent, tool, or workflow id named exploit. The runner refuses exploit-shaped step ids (msfvenom, payloads, Burp Intruder). Sanctioned `sqlmap-scan` and `poc-*` steps are allowed.

### Phase mapping

| Phase | Workflow id | Slash | What runs |
|---|---|---|---|
| Pre-recon | `pre-recon` | `/pre-recon` | `semgrep-list` → `semgrep-scan` → `semgrep-owasp` → research |
| Source review | `source-review` | `/source-review` | Workspace SAST + optional path + research |
| Recon | `recon-surface` | `/recon-surface`, `/recon` | dns-resolve, scan-top-ports, naabu, httpx (+ httpx-tech on local web), subfinder, katana, scrapling-fetch, browser-open. Loopback skips DNS/subfinder. |
| Web recon | `web-recon` | `/web-recon` | httpx-tech, katana, scrapling-fetch/links, browser-open/links |
| Vuln detect | `vuln-detect` | `/vuln-detect`, `/vuln` | Local web: httpx-tech + nuclei-tech tools, then parallel agents `vuln-injection` / `vuln-xss` / `vuln-ssrf` / `vuln-auth` |
| PoC validate | `poc-validate` | `/poc-validate`, `/poc`, `/prove` | Localhost web: `sqlmap-scan` + `zap-ascan` (HITL) then poc-* agents |
| Validate | `validate` | `/validate` | `validation` agent — confirmed vs unconfirmed |
| Report | `report` | `/report` | `reporting` agent — Markdown for a security team |
| Correlate | `correlate-report` | `/correlate-report` | validate then report (sequential) |
| Full | `full-engagement` | `/full-engagement`, `/full-recon`, `/analyze`, `/engagement` | Nested: pre-recon → recon-surface → vuln-detect → poc-validate → validate → report |

Existing playbooks are unchanged: `authorized-recon`, `pd-recon`, `binary-triage`, `pcap-review`.

### Full engagement

`full-engagement` is six **workflow** steps, not a stub. Each child playbook runs through the same runner:

1. Independent tools in a phase fan out in parallel (`groupIndependentSteps` / `run_specialists`).
2. Same-image tools stay sequential (one Semgrep container at a time).
3. `validation` and `reporting` never fan out with peers; they consume prior-phase evidence.
4. Nested workflows cannot cycle. Exploit-shaped step ids are refused.
5. A missing workspace tree or missing host does **not** abort the engagement. That phase records the gap; later phases still run.

Orchestrator (authoritative instruction, cannot be dropped by a stale `prompts.json`):

- “analyze this application”, “full recon”, “full engagement” → `run_workflow` `full-engagement`
- Implied target: named host, local/this machine, Settings → Scope, or workspace source
- Empty Settings → Scope does not block a named or local target
- Configured scope still blocks out-of-scope hosts
- HITL is unchanged: Podman / Linux VM, then each catalog image

## Evidence

Evidence is **tool output** plus the findings store:

- Hosts, ports, service banners (nmap / naabu)
- HTTP titles, tech, URLs (httpx / katana / scrapling / browser)
- Nuclei **info / tech / low** only — version/unpatched banners become `class=version` hypotheses
- SAST locations: rule id, file, line, class (Semgrep). Empty workspace is a gap finding, not a stop.
- PoC: poc-request / poc-act / poc-xss-canary / sqlmap-scan / zap-ascan (HITL, bounded)

Validation labels each claim **confirmed** (steps + evidence) or **unconfirmed**. Reporting must not inflate severity.

## Explicit gap we will not copy

| Strix / Shannon | Hawaldar |
|---|---|
| Exploit agents / shells / msfvenom | **Refused.** |
| Metasploit exploit / payload / session | **Refused** except bounded `msf-check` / `msf-run` with HITL + auto-kill sessions |
| Burp Intruder, data-dumping SQLMap | **Refused.** Bounded `sqlmap-scan` (level/risk ≤ 2, no dump/os-shell) is the sanctioned replacement |
| Nuclei critical / exploit templates | **Refused.** info/tech/low only |
| Auto-fix PRs / patch generation | Out of scope |

If a future playbook adds a step whose id matches exploit / payload / msfvenom, `assertSafeSteps` and the runner reject it. `sqlmap-scan` and `poc-*` are allowed.

## Operator notes

- Drop application source in `~/.hawaldar/workspace` before pre-recon. An empty workspace yields a clear “no source” result and the rest of the engagement still runs, including poc-validate.
- Localhost Juice Shop (`http://127.0.0.1:3000`): skip ghidra/radare/binwalk/tshark/subfinder/amass. poc-validate always runs sqlmap-scan on `/rest/products/search` and zap-ascan, with per-run HITL.
- First use of a catalog image goes through HITL: start Podman if needed, then build/start the image. PoC probes ask again every run (never remembered).
