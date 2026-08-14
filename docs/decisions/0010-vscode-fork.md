# ADR 0010: VS Code fork as the Hawaldar workbench

## Status

Accepted

## Context

Electron+HTTP, Theia, FastAPI+pywebview, and a standalone Qt window all fought the product. Cursor, Void, and Windsurf ship a forked Code-OSS: rebrand `product.json`, add a built-in agent extension, keep the workbench.

## Decision

- Vendor VS Code 1.133.0 as a submodule
- Rebrand `product.json` (Hawaldar, `.hawaldar-code`, `hawaldar://`)
- Ship `extensions/hawaldar` as a built-in: default chat participant, memory view, status view
- Persist memory with `@mastra/memory` + LibSQL
- Map public MCP tool names into Podman-gated adapters
- Do not use GitHub Copilot as `defaultChatAgent`

## Consequences

- `npm i` + `npm run watch` + `scripts/code.bat` launches the product (not Yarn)
- Agent UX is the native Chat panel plus a Settings window
- Policy and Podman stay outside the model
- Exploitation MCP tools are catalogued as refused, not implemented
