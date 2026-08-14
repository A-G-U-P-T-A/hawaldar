import { homedir } from "node:os";
import { join } from "node:path";
import { err, ok, type Result } from "./result.js";
import { ErrorCode, HawaldarError } from "./errors.js";
import type { LogLevel } from "./logger.js";

const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

export interface RuntimeConfig {
  readonly dataDir: string;
  readonly logLevel: LogLevel;
  readonly databasePath: string;
}

export interface ProcessEnvReader {
  readonly [key: string]: string | undefined;
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

export function loadRuntimeConfig(
  env: ProcessEnvReader = process.env,
): Result<RuntimeConfig, HawaldarError> {
  const dataDir = env.HAWALDAR_DATA_DIR?.trim() || join(homedir(), ".hawaldar");
  const rawLevel = (env.HAWALDAR_LOG_LEVEL?.trim() || "info").toLowerCase();

  if (!isLogLevel(rawLevel)) {
    return err(
      new HawaldarError(
        ErrorCode.CONFIG_INVALID,
        `HAWALDAR_LOG_LEVEL must be one of: ${LOG_LEVELS.join(", ")}`,
        { value: rawLevel },
      ),
    );
  }

  const databasePath = env.HAWALDAR_DATABASE_PATH?.trim() || join(dataDir, "hawaldar.db");

  return ok({
    dataDir,
    logLevel: rawLevel,
    databasePath,
  });
}
