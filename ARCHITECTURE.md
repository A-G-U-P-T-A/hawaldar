# Hawaldar Architecture

Hawaldar is a local, AI-native **authorized reconnaissance** workstation. It is not a chatbot wrapper around scanners, and it is not an exploitation platform. The product is the autonomous recon runtime, persistent engagement state, and isolated tool orchestration.

Targets are supplied by the operator and must be explicitly in scope (IP, domain, subdomain, CIDR, or CTF/lab host). The policy engine—not the model—is the authority on whether a target is authorized.

## Current phase

**Phase 3 complete in this milestone:** universal Tool Registry (metadata + adapter type).

Implemented:

- npm workspaces monorepo, Pino logging, env config (`@hawaldar/shared`)
- `@hawaldar/runtime` boots config + SQLite
- `@hawaldar/engagement` — Drizzle schema, stores, workspace, deterministic scope matching
- `@hawaldar/security-graph` — typed nodes/edges over the same database
- `@hawaldar/tool-registry` — `ToolDefinition`, registry, recon catalog
- Unit tests, ESLint, TypeScript project references

Not implemented yet: sandbox/Podman, policy gate on execution, tool adapters, agents, UI.

## System shape

```
Operator (Theia UI / cyber CLI)
        │
        ▼
   apps/runtime          trusted process
        │
        ├── packages/engagement      source of truth (SQLite)
        ├── packages/security-graph  nodes + edges over SQLite
        ├── packages/agent           Mastra orchestrator + specialist agents
        ├── packages/policy          scope + mode enforcement
        ├── packages/tool-runtime    ToolDefinition dispatch
        ├── packages/mcp             MCP servers → ToolDefinition
        ├── packages/browser         Playwright observations
        ├── packages/evidence        finding lifecycle + artifacts
        ├── packages/reporting       engagement reports
        └── packages/sandbox         SandboxProvider
                │
                ▼
         Podman (rootless, ephemeral)
                │
                ▼
         tool container ──► authorized target
```

The agent never receives host `exec` / `spawn` / `shell`. The only execution path is:

`Agent → Tool Runtime → Policy Engine → Sandbox Manager → Podman → Tool Container → Target`

`SandboxProvider` is the interface (`create`, `execute`, `collectArtifacts`, `destroy`). `PodmanSandboxProvider` is the first implementation. A future `MicroVMSandboxProvider` can implement the same interface. Docker is not a dependency.

## Monorepo

```
apps/runtime                 trusted local runtime process
packages/shared              logging, config, Result, errors
packages/engagement          engagement aggregate + SQLite
packages/security-graph      graph API
packages/agent               (Phase 8)
packages/tool-runtime        (Phase 3–4)
packages/sandbox             (Phase 4)
packages/mcp                 (Phase 12)
packages/browser             (Phase 11)
packages/policy              (Phase 5)
packages/evidence            (Phase 15)
packages/reporting           (Phase 19)
tools/registry               ToolDefinition catalog
tests/
docs/architecture
docs/decisions
```

Packages are created when a phase needs them.

## Engagement model

SQLite is the source of truth. Conversation history is not.

Tables: `engagements`, `scope_entries`, `graph_nodes`, `graph_edges`, `findings`, `evidence`, `tool_executions`, `scripts`, `hypotheses`, `agent_decisions`, `checkpoints`, `attack_paths`.

Workspace (outside containers):

```
engagements/<id>/
  scripts/
  artifacts/
  evidence/
  tool-output/
  logs/
  checkpoints/
```

`isAuthorizedTarget` evaluates allow/deny for IP, CIDR, domain, and host. Deny wins.

## Scope and policy (Phase 5)

Every tool invocation must still pass a trusted policy gate before sandbox execution. Modes: `CTF_LAB`, `AUTHORIZED_PENTEST`.

Uncontrolled propagation, persistence, stealth, and destructive actions are out of scope. Exploitation frameworks are not part of this recon product.

## Tooling (Phase 3+)

All capabilities become a `ToolDefinition`. Initial recon registry: Nmap, Nuclei, FFUF, httpx, dnsx, subfinder, Amass, Tshark, Playwright. Tools are integrated incrementally.

Generated scripts execute only through `SandboxProvider`.

## Agents (Phase 8+)

Five agents only: Orchestrator, Recon, Web, Validation, Reporting. Mastra owns workflows, suspend/resume, approvals, and tracing.

## Findings

Lifecycle: `suspected` → `investigating` → `validated` | `false_positive` | `accepted` | `fixed` | `retest_required`. A validated finding requires evidence. An LLM hypothesis is never a confirmed finding.

## Testing

Deterministic local labs only. Never point autonomous runs at random internet hosts.

Critical invariant: agent-facing code cannot execute a host command outside `SandboxProvider`. Current guard: source scan of agent-facing packages for `child_process` imports.

## v0.1 done when

An operator can create a scoped engagement against a local lab, run Nmap in Podman, normalize observations into the graph, let the orchestrator pick a next recon action, run that tool in Podman, persist executions, checkpoint, resume, attach evidence, validate a finding, and inspect the run in Theia — with no host shell available to the agent.
