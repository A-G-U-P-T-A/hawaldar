import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type Persistence } from "./db.js";
import {
  createCheckpointStore,
  createEngagementStore,
  createFindingStore,
  createToolExecutionStore,
} from "./stores.js";
import { EngagementMode, EngagementStatus, FindingStatus } from "./types.js";

const temps: string[] = [];
const dbs: Persistence[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hawaldar-eng-"));
  temps.push(dir);
  return dir;
}

function openTemp(): { dataDir: string; persistence: Persistence } {
  const dataDir = tempDir();
  const persistence = openDatabase(join(dataDir, "hawaldar.db"));
  dbs.push(persistence);
  return { dataDir, persistence };
}

afterEach(() => {
  for (const persistence of dbs.splice(0)) {
    persistence.close();
  }
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("engagement persistence", () => {
  it("creates an engagement with scope and workspace, then reloads after reopen", () => {
    const { dataDir, persistence } = openTemp();
    const store = createEngagementStore(persistence.db);

    const created = store.create({
      name: "lab-basic-web",
      mode: EngagementMode.CTF_LAB,
      dataDir,
      targets: [{ kind: "ip", value: "127.0.0.1" }],
      excluded: [{ kind: "ip", value: "8.8.8.8" }],
    });

    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    expect(created.value.status).toBe(EngagementStatus.CREATED);
    expect(created.value.scope).toHaveLength(2);
    expect(created.value.workspacePath).toContain(created.value.id);

    persistence.close();
    dbs.pop();

    const reopened = openDatabase(join(dataDir, "hawaldar.db"));
    dbs.push(reopened);
    const loaded = createEngagementStore(reopened.db).get(created.value.id);
    expect(loaded?.name).toBe("lab-basic-web");
    expect(loaded?.scope.map((entry) => entry.value).sort()).toEqual(["127.0.0.1", "8.8.8.8"]);
  });

  it("rejects an engagement with empty scope", () => {
    const { dataDir, persistence } = openTemp();
    const result = createEngagementStore(persistence.db).create({
      name: "empty",
      mode: EngagementMode.CTF_LAB,
      dataDir,
      targets: [],
    });
    expect(result.ok).toBe(false);
  });

  it("persists findings, tool executions, and checkpoints", () => {
    const { dataDir, persistence } = openTemp();
    const engagements = createEngagementStore(persistence.db);
    const created = engagements.create({
      name: "persist",
      mode: EngagementMode.AUTHORIZED_PENTEST,
      dataDir,
      targets: [{ kind: "cidr", value: "10.0.0.0/24" }],
    });
    if (!created.ok) {
      throw new Error("expected engagement");
    }

    const findings = createFindingStore(persistence.db);
    const finding = findings.create({
      engagementId: created.value.id,
      title: "Open HTTP",
      summary: "Port 80 responded",
    });
    findings.setStatus(finding.id, FindingStatus.INVESTIGATING);

    const tools = createToolExecutionStore(persistence.db);
    const execution = tools.start({
      engagementId: created.value.id,
      toolName: "nmap",
      request: { target: "10.0.0.5" },
    });
    tools.finish(execution.id, {
      status: "succeeded",
      stdout: "80/tcp open",
      stderr: "",
      exitCode: 0,
    });

    const checkpoints = createCheckpointStore(persistence.db);
    checkpoints.save({
      engagementId: created.value.id,
      kind: "planner",
      payload: { next: "enumerate-http" },
    });

    expect(findings.list(created.value.id)[0]?.status).toBe(FindingStatus.INVESTIGATING);
    expect(tools.list(created.value.id)[0]?.stdout).toBe("80/tcp open");
    expect(checkpoints.latest(created.value.id)?.payload).toEqual({ next: "enumerate-http" });
  });
});
