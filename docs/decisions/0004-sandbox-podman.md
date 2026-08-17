# ADR 0004: SandboxProvider with Podman backend

## Status

Accepted

## Context

The agent must never receive host `exec` / `spawn` / `shell`. Tool processes run in ephemeral, rootless Podman containers. Docker is not a dependency. A future microVM backend should implement the same interface.

## Decision

- `SandboxProvider` exposes `create`, `execute`, `collectArtifacts`, `destroy`.
- `PodmanSandboxProvider` is the first implementation.
- Only `packages/sandbox` may import `node:child_process`, and only to invoke the `podman` binary.
- The Podman socket is never exposed to the model.
- Containers are created, executed, collected from, then destroyed. Engagement artifacts live in the host workspace via bind mounts / `podman cp`.
- `CommandRunner` is injected so unit tests do not require Podman. The production runner is `createNodeCommandRunner`.

## Consequences

- Phase 5 must call the policy engine before `sandbox.execute`.
- Phase 6 Nmap adapter emits a `SandboxExecuteRequest`, not a host command.
- A later `MicroVMSandboxProvider` can replace the Podman implementation without changing agents.
