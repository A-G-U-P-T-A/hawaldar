import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const TRUSTED_SANDBOX_RUNNER = join(ROOT, "packages", "sandbox", "src", "process-runner.ts");

const FORBIDDEN = [
  /from\s+["']node:child_process["']/,
  /from\s+["']child_process["']/,
  /require\(\s*["']node:child_process["']\s*\)/,
  /require\(\s*["']child_process["']\s*\)/,
];

function walkTsFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
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

function sourceRoots(): string[] {
  const groups = ["packages", "apps", "tools"].map((group) => join(ROOT, group));
  const roots: string[] = [];
  for (const group of groups) {
    if (!existsSync(group)) {
      continue;
    }
    for (const entry of readdirSync(group)) {
      if (group.endsWith("packages") && entry === "sandbox") {
        continue;
      }
      roots.push(join(group, entry, "src"));
    }
  }
  return roots;
}

describe("host process execution boundary", () => {
  it("forbids child_process outside the trusted sandbox runner", () => {
    const violations: string[] = [];
    for (const root of sourceRoots()) {
      for (const file of walkTsFiles(root)) {
        const source = readFileSync(file, "utf8");
        if (FORBIDDEN.some((pattern) => pattern.test(source))) {
          violations.push(file);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the only child_process import inside SandboxProvider", () => {
    const source = readFileSync(TRUSTED_SANDBOX_RUNNER, "utf8");
    expect(source).toMatch(/from\s+["']node:child_process["']/);
  });
});
