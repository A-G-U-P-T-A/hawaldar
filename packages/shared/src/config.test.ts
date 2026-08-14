import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "./config.js";
import { ErrorCode } from "./errors.js";

describe("loadRuntimeConfig", () => {
  it("uses defaults when env is empty", () => {
    const result = loadRuntimeConfig({});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.logLevel).toBe("info");
    expect(result.value.databasePath.endsWith("hawaldar.db")).toBe(true);
    expect(result.value.dataDir.length).toBeGreaterThan(0);
  });

  it("honors overrides", () => {
    const result = loadRuntimeConfig({
      HAWALDAR_DATA_DIR: "C:\\tmp\\hw",
      HAWALDAR_LOG_LEVEL: "debug",
      HAWALDAR_DATABASE_PATH: "C:\\tmp\\hw\\custom.db",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        dataDir: "C:\\tmp\\hw",
        logLevel: "debug",
        databasePath: "C:\\tmp\\hw\\custom.db",
      },
    });
  });

  it("rejects unknown log levels", () => {
    const result = loadRuntimeConfig({ HAWALDAR_LOG_LEVEL: "verbose" });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe(ErrorCode.CONFIG_INVALID);
  });
});
