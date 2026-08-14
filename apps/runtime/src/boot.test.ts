import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootRuntime } from "./boot.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("bootRuntime", () => {
  it("loads config, opens sqlite, and returns a logger", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hawaldar-boot-"));
    temps.push(dataDir);
    const started = bootRuntime({
      HAWALDAR_DATA_DIR: dataDir,
      HAWALDAR_DATABASE_PATH: join(dataDir, "hawaldar.db"),
      HAWALDAR_LOG_LEVEL: "error",
    });

    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    expect(started.value.config.dataDir).toBe(dataDir);
    expect(started.value.logger).toBeDefined();
    started.value.persistence.close();
  });

  it("fails closed on invalid config", () => {
    const started = bootRuntime({ HAWALDAR_LOG_LEVEL: "nope" });
    expect(started.ok).toBe(false);
  });
});
