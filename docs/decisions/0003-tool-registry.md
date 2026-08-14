# ADR 0003: Universal Tool Registry

## Status

Accepted

## Context

The agent must not care whether a capability comes from a container image, MCP server, browser, or generated script. Exploitation frameworks are outside product scope.

## Decision

- Every capability is a `ToolDefinition` in `@hawaldar/tool-registry`.
- The Phase 3 catalog is metadata only; images are not pulled and adapters are not executed.
- Seeded recon tools: nmap, nuclei, ffuf, httpx, dnsx, subfinder, amass, tshark, playwright.
- Metasploit and SQLMap are explicitly excluded.
- `ToolAdapter.toSandboxCommand` is the boundary to Phase 4. Adapters do not run host processes.

## Consequences

- Phase 6 implements the Nmap adapter against this registry.
- MCP and Playwright later register as the same `ToolDefinition` type.
