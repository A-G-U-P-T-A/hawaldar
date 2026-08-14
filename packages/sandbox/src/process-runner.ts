import { spawn } from "node:child_process";
import type { CommandRunner } from "./types.js";

export function createNodeCommandRunner(): CommandRunner {
  return {
    run(command, args, options) {
      return new Promise((resolve, reject) => {
        const child = spawn(command, [...args], {
          windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        let settled = false;

        const timer = setTimeout(() => {
          settled = true;
          child.kill("SIGKILL");
          resolve({
            exitCode: 124,
            stdout,
            stderr,
            timedOut: true,
          });
        }, options.timeoutMs);

        child.stdout.on("data", (chunk: Buffer | string) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });
        child.on("error", (error) => {
          if (settled) {
            return;
          }
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          if (settled) {
            return;
          }
          clearTimeout(timer);
          resolve({
            exitCode: code ?? 1,
            stdout,
            stderr,
            timedOut: false,
          });
        });
      });
    },
  };
}
