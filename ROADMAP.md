# Roadmap

Product: authorized reconnaissance workstation. Exploitation, persistence, stealth, and destructive behavior are out of scope.

| Phase | Name | Status |
| --- | --- | --- |
| 0 | Inspect repository | done |
| 1 | Architecture + monorepo + configuration + logging | done |
| 2 | SQLite + engagement model + security graph | done |
| 3 | Tool Registry | done |
| 4 | SandboxProvider + Podman | next |
| 5 | Scope / Policy Engine | not started |
| 6 | Nmap adapter (Podman) | not started |
| 7 | Observation normalization | not started |
| 8 | Mastra Orchestrator | not started |
| 9 | Checkpoint / resume | not started |
| 10 | Nuclei + FFUF + HTTP recon tooling | not started |
| 11 | Playwright | not started |
| 12 | MCP → ToolDefinition | not started |
| 13 | Deferred — exploitation frameworks (not in recon product) | skipped |
| 14 | Recursive investigation planner | not started |
| 15 | Evidence + findings | not started |
| 16 | Theia UI | not started |
| 17 | CTF autonomous recon mode | not started |
| 18 | Authorized pentest recon mode | not started |
| 19 | Reporting | not started |
| 20 | Agent evaluation framework | not started |

## v0.1 gate

Local lab target → engagement → scope check → Nmap in Podman → normalized graph → orchestrator next action → second tool in Podman → persisted executions → checkpoint/resume → evidence → validated finding → Theia visibility. No host shell for the agent.
