# ADR 0001: Monorepo, TypeScript runtime, npm workspaces

## Status

Accepted

## Context

Hawaldar needs a single local application that will grow into a runtime, CLI, Theia workbench, and several domain packages. The operator machine is Windows with Node 24 and npm 11. Corepack could not enable pnpm (EPERM on `C:\Program Files\nodejs`).

## Decision

- One git repository with npm workspaces (`apps/*`, `packages/*`, `tools/*`).
- TypeScript for application and orchestration code.
- Rust only if a later sandbox/OS boundary genuinely requires it.
- Structured logging via Pino.
- Configuration from environment variables, validated in `@hawaldar/shared`.
- SQLite + Drizzle for engagement state.
- Podman later; Docker is never a dependency.
- Product scope is authorized reconnaissance, not exploitation.

## Consequences

- CLI and Theia will import the same packages; no duplicate business logic.
- Lockfile is `package-lock.json`.
- Packages are added when a phase needs them, not as empty stubs.
