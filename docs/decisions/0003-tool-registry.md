# ADR 0003: Universal Tool Registry

## Status

Accepted

## Context

The agent must not care whether a capability comes from a container image, MCP server, browser, or generated script. Exploitation frameworks are outside product scope.

## Decision

- Every capability is a `ToolDefinition` in `@hawaldar/tool-registry`.
- The Phase 3 catalog is metadata only; images are not pulled and adapters are not executed.
- Seeded recon/SAST tools: nmap, dns (dig records / PTR / AXFR permit-check), nuclei (info/tech/low), ffuf, httpx, dnsx, subfinder, amass, tshark, contained Playwright/Chromium (`localhost/hawaldar/browser:min`), contained Scrapling (`localhost/hawaldar/scrapling:min`, HTTP Fetcher + adaptive CSS/XPath), contained Semgrep (`localhost/hawaldar/semgrep:min`, workspace SAST), Metasploit (search + auxiliary/scanner).
- SQLMap remains excluded. Metasploit exploit/payload/post and msfvenom stay refused (ADR 0005).
- `ToolAdapter.toSandboxCommand` is the boundary to Phase 4. Adapters do not run host processes.

## Consequences

- Phase 6 implements the Nmap adapter against this registry.
- MCP and Playwright later register as the same `ToolDefinition` type.
- Browser recon is implemented as Podman `browser-*` tools. Host Chrome / host Playwright is not a tool path.
- Scrapling recon is implemented as Podman `scrapling-*` tools (HTTP Fetcher + CSS/XPath). Arbitrary Python eval is not a tool path.
- Semgrep SAST is implemented as Podman `semgrep-*` tools on `~/.hawaldar/workspace`. Autofix exploits and payload generation are not a tool path.
