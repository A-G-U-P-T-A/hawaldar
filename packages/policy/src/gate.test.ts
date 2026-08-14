import { describe, expect, it, vi } from "vitest";
import { EngagementMode, type ScopeEntry } from "@hawaldar/engagement";
import type { SandboxProvider } from "@hawaldar/sandbox";
import { createReconToolRegistry } from "@hawaldar/tool-registry";
import { createPolicyGate } from "./gate.js";

const scope: ScopeEntry[] = [
  {
    id: "s1",
    engagementId: "e1",
    direction: "allow",
    kind: "ip",
    value: "127.0.0.1",
    createdAt: 0,
  },
];

function sandboxSpy(): SandboxProvider & { execute: ReturnType<typeof vi.fn> } {
  return {
    create: vi.fn(),
    execute: vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "scanned",
      stderr: "",
      timedOut: false,
    }),
    collectArtifacts: vi.fn(),
    destroy: vi.fn(),
  };
}

describe("createPolicyGate", () => {
  it("does not call sandbox.execute for an out-of-scope target", async () => {
    const sandbox = sandboxSpy();
    const gate = createPolicyGate(createReconToolRegistry(), sandbox);
    const result = await gate.execute(
      {
        engagementId: "e1",
        toolName: "nmap",
        target: { kind: "ip", value: "8.8.8.8" },
        handle: { id: "hw-1", image: "nmap" },
        request: { command: "nmap", args: ["8.8.8.8"], timeoutMs: 1000 },
      },
      { mode: EngagementMode.CTF_LAB, scope, approvalGranted: false },
    );

    expect(result.ok).toBe(false);
    expect(sandbox.execute).not.toHaveBeenCalled();
  });

  it("executes only after an independent scope allow", async () => {
    const sandbox = sandboxSpy();
    const gate = createPolicyGate(createReconToolRegistry(), sandbox);
    const result = await gate.execute(
      {
        engagementId: "e1",
        toolName: "nmap",
        target: { kind: "ip", value: "127.0.0.1" },
        handle: { id: "hw-1", image: "nmap" },
        request: { command: "nmap", args: ["127.0.0.1"], timeoutMs: 1000 },
      },
      { mode: EngagementMode.CTF_LAB, scope, approvalGranted: false },
    );

    expect(result.ok).toBe(true);
    expect(sandbox.execute).toHaveBeenCalledOnce();
  });
});
