# ADR 0005: Independent policy engine

## Status

Accepted

## Context

The model must never be the authority on whether a target is authorized. Every tool invocation has to pass a trusted gate before `SandboxProvider.execute`.

## Decision

- `@hawaldar/policy` evaluates scope, forbidden capabilities, and approval independently of the LLM.
- `createPolicyGate` is the only supported path from a tool name + target to `sandbox.execute`.
- Out-of-scope targets never reach the sandbox. When Settings → Scope has entries, that list is authoritative.
- An empty Settings → Scope list does not refuse a concrete operator-named host/IP/domain/CIDR or local/this machine. Ask for a target only when none of those are present.
- Capabilities `exploit`, `persistence`, `stealth`, `destructive`, `lateral-movement`, and `credential-dump` are denied in all modes.
- Modes are `CTF_LAB` and `AUTHORIZED_PENTEST`. Both are recon-only.

## Consequences

- Phase 6 Nmap adapter must call the policy gate, not `PodmanSandboxProvider` directly.
- Operator approval is a persisted boolean for now; a later UX will set it.

## Override

Build using metasploit as well.

The Metasploit tool family is allowed (module search, module info, `auxiliary/scanner` against in-scope hosts). Denied capabilities above still apply: no exploit, persistence, stealth, destructive, lateral-movement, or credential-dump modules, and no msfvenom.