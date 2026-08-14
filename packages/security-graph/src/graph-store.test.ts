import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEngagementStore,
  EngagementMode,
  openDatabase,
  type Persistence,
} from "@hawaldar/engagement";
import { createGraphStore } from "./graph-store.js";
import { GraphEdgeType, GraphNodeType } from "./types.js";

const temps: string[] = [];
const dbs: Persistence[] = [];

afterEach(() => {
  for (const persistence of dbs.splice(0)) {
    persistence.close();
  }
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("security graph", () => {
  it("upserts nodes and links host → port → service", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hawaldar-graph-"));
    temps.push(dataDir);
    const persistence = openDatabase(join(dataDir, "hawaldar.db"));
    dbs.push(persistence);

    const engagement = createEngagementStore(persistence.db).create({
      name: "graph",
      mode: EngagementMode.CTF_LAB,
      dataDir,
      targets: [{ kind: "ip", value: "127.0.0.1" }],
    });
    if (!engagement.ok) {
      throw new Error("expected engagement");
    }

    const graph = createGraphStore(persistence.db);
    const host = graph.upsertNode({
      engagementId: engagement.value.id,
      type: GraphNodeType.HOST,
      canonicalKey: "host:127.0.0.1",
      label: "127.0.0.1",
    });
    const again = graph.upsertNode({
      engagementId: engagement.value.id,
      type: GraphNodeType.HOST,
      canonicalKey: "host:127.0.0.1",
      label: "127.0.0.1",
      data: { source: "nmap" },
    });
    expect(again.id).toBe(host.id);
    expect(again.data).toEqual({ source: "nmap" });

    const port = graph.upsertNode({
      engagementId: engagement.value.id,
      type: GraphNodeType.PORT,
      canonicalKey: "port:127.0.0.1:80",
      label: "80/tcp",
    });
    const service = graph.upsertNode({
      engagementId: engagement.value.id,
      type: GraphNodeType.SERVICE,
      canonicalKey: "service:127.0.0.1:80:http",
      label: "http",
    });
    graph.addEdge({
      engagementId: engagement.value.id,
      sourceId: host.id,
      targetId: port.id,
      type: GraphEdgeType.HAS_PORT,
    });
    graph.addEdge({
      engagementId: engagement.value.id,
      sourceId: port.id,
      targetId: service.id,
      type: GraphEdgeType.RUNS_SERVICE,
    });

    expect(graph.listNodes(engagement.value.id)).toHaveLength(3);
    expect(graph.listEdges(engagement.value.id)).toHaveLength(2);
  });
});
