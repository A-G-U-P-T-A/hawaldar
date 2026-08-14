import { mkdirSync } from "node:fs";
import { openDatabase, type Persistence } from "@hawaldar/engagement";
import {
  createLogger,
  loadRuntimeConfig,
  type HawaldarError,
  type Logger,
  type Result,
  type RuntimeConfig,
} from "@hawaldar/shared";

export interface RuntimeHandle {
  readonly config: RuntimeConfig;
  readonly logger: Logger;
  readonly persistence: Persistence;
}

export function bootRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Result<RuntimeHandle, HawaldarError> {
  const loaded = loadRuntimeConfig(env);
  if (!loaded.ok) {
    return loaded;
  }

  mkdirSync(loaded.value.dataDir, { recursive: true });
  const persistence = openDatabase(loaded.value.databasePath);
  const logger = createLogger("runtime", { level: loaded.value.logLevel });
  logger.info(
    {
      dataDir: loaded.value.dataDir,
      databasePath: loaded.value.databasePath,
    },
    "runtime configured",
  );

  return { ok: true, value: { config: loaded.value, logger, persistence } };
}
