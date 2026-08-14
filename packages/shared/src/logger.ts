import { pino, type Logger } from "pino";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type { Logger };

export function createLogger(
  name: string,
  options?: { level?: LogLevel },
): Logger {
  return pino({
    name,
    level: options?.level ?? "info",
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
