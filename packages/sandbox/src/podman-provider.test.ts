import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PodmanSandboxProvider } from "./podman-provider.js";
import type { CommandResult, CommandRunner } from "./types.js";
import { NetworkPolicy } from "./types.js";

function recordingRunner(exitCode = 0): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(_command, args): Promise<CommandResult> {
      calls.push([...args]);
      return { exitCode, stdout: "ok", stderr: "", timedOut: false };
    },
  };
}

const createRequest = {
  image: "docker.io/library/alpine:3.20",
  network: NetworkPolicy.NONE,
  limits: { cpus: 1, memoryMb: 128, pids: 32 },
};

describe("PodmanSandboxProvider", () => {
  it("creates, executes, collects, and destroys through podman only", async () => {
    const runner = recordingRunner();
    const provider = new PodmanSandboxProvider(runner);
    const handle = await provider.create(createRequest);
    expect(handle.id.startsWith("hw-")).toBe(true);
    expect(runner.calls[0]?.[0]).toBe("create");
    expect(runner.calls[1]).toEqual(["start", handle.id]);

    const result = await provider.execute(handle, {
      command: "echo",
      args: ["scoped"],
      timeoutMs: 5_000,
    });
    expect(result.stdout).toBe("ok");
    expect(runner.calls[2]?.slice(0, 3)).toEqual(["exec", handle.id, "echo"]);

    const dest = join(mkdtempSync(join(tmpdir(), "hw-art-")), "scan.xml");
    await provider.collectArtifacts(handle, "/out/scan.xml", dest);
    expect(runner.calls[3]).toEqual(["cp", `${handle.id}:/out/scan.xml`, dest]);

    await provider.destroy(handle);
    expect(runner.calls[4]).toEqual(["rm", "-f", handle.id]);
  });

  it("fails closed when podman create fails", async () => {
    const provider = new PodmanSandboxProvider(recordingRunner(1));
    await expect(provider.create(createRequest)).rejects.toMatchObject({
      code: "SANDBOX_FAILURE",
    });
  });
});
