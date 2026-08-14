import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const AGENT_FACING_ROOTS = [
  join(ROOT, "packages", "shared", "src"),
  join(ROOT, "packages", "engagement", "src"),
  join(ROOT, "packages", "security-graph", "src"),
  join(ROOT, "tools", "registry", "src"),
  join(ROOT, "apps", "runtime", "src"),
];

const FORBIDDEN = [
  /from\s+["']node:child_process["']/,
  /from\s+["']child_process["']/,
  /require\(\s*["']node:child_process["']\s*\)/,
  /require\(\s*["']child_process["']\s*\)/,
];

function walkTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...walkTsFiles(path));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

describe("agent-facing packages must not import host process APIs", () => {
  it("does not import child_process", () => {
    const violations: string[] = [];
    for (const root of AGENT_FACING_ROOTS) {
      for (const file of walkTsFiles(root)) {
        const source = readFileSync(file, "utf8");
        if (FORBIDDEN.some((pattern) => pattern.test(source))) {
          violations.push(file);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
