import { describe, expect, it } from "vitest";
import { createNodeCommandRunner } from "./process-runner.js";

describe("createNodeCommandRunner", () => {
  it("captures stdout from a trusted subprocess", async () => {
    const runner = createNodeCommandRunner();
    const result = await runner.run(process.execPath, ["-e", "process.stdout.write('ok')"], {
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(result.timedOut).toBe(false);
  });
});
