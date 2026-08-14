# ADR 0005: Independent policy engine

## Status

Accepted

## Context

The model must never be the authority on whether a target is authorized. Every tool invocation has to pass a trusted gate before `SandboxProvider.execute`.

## Decision

- `@hawaldar/policy` evaluates scope, forbidden capabilities, and approval independently of the LLM.
- `createPolicyGate` is the only supported path from a tool name + target to `sandbox.execute`.
- Out-of-scope targets never reach the sandbox.
- Capabilities `exploit`, `persistence`, `stealth`, `destructive`, `lateral-movement`, and `credential-dump` are denied in all modes.
- Modes are `CTF_LAB` and `AUTHORIZED_PENTEST`. Both are recon-only.

## Consequences

- Phase 6 Nmap adapter must call the policy gate, not `PodmanSandboxProvider` directly.
- Operator approval is a persisted boolean for now; a later UX will set it.
