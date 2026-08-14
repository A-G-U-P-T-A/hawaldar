import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const engagements = sqliteTable("engagements", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  mode: text("mode").notNull(),
  status: text("status").notNull(),
  workspacePath: text("workspace_path").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  pausedAt: integer("paused_at"),
});

export const scopeEntries = sqliteTable("scope_entries", {
  id: text("id").primaryKey(),
  engagementId: text("engagement_id")
    .notNull()
    .references(() => engagements.id, { onDelete: "cascade" }),
  direction: text("direction").notNull(),
  kind: text("kind").notNull(),
  value: text("value").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const graphNodes = sqliteTable(
  "graph_nodes",
  {
    id: text("id").primaryKey(),
    engagementId: text("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    canonicalKey: text("canonical_key").notNull(),
    label: text("label").notNull(),
    data: text("data").notNull(),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
  },
  (table) => [uniqueIndex("graph_nodes_engagement_key").on(table.engagementId, table.canonicalKey)],
);

export const graphEdges = sqliteTable(
  "graph_edges",
  {
    id: text("id").primaryKey(),
    engagementId: text("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => graphNodes.id, { onDelete: "cascade" }),
    targetId: text("target_id")
      .notNull()
      .references(() => graphNodes.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    data: text("data").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("graph_edges_unique").on(
      table.engagementId,
      table.sourceId,
      table.targetId,
      table.type,
    ),
  ],
);

export const findings = sqliteTable("findings", {
  id: text("id").primaryKey(),
  engagementId: text("engagement_id")
    .notNull()
    .references(() => engagements.id, { onDelete: "cascade" }),
  nodeId: text("node_id").references(() => graphNodes.id, { onDelete: "set null" }),
  status: text("status").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const evidence = sqliteTable("evidence", {
  id: text("id").primaryKey(),
  engagementId: text("engagement_id")
    .notNull()
    .references(() => engagements.id, { onDelete: "cascade" }),
  findingId: text("finding_id").references(() => findings.id, { onDelete: "set null" }),
  kind: text("kind").notNull(),
  uri: text("uri").notNull(),
  metadata: text("metadata").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const toolExecutions = sqliteTable("tool_executions", {
  id: text("id").primaryKey(),
  engagementId: text("engagement_id")
    .notNull()
    .references(() => engagements.id, { onDelete: "cascade" }),
  toolName: text("tool_name").notNull(),
  status: text("status").notNull(),
  request: text("request").notNull(),
  stdout: text("stdout").notNull(),
  stderr: text("stderr").notNull(),
  exitCode: integer("exit_code"),
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
});

export const scripts = sqliteTable("scripts", {
  id: text("id").primaryKey(),
  engagementId: text("engagement_id")
    .notNull()
    .references(() => engagements.id, { onDelete: "cascade" }),
  hash: text("hash").notNull(),
  creatorAgent: text("creator_agent").notNull(),
  sourcePath: text("source_path").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const hypotheses = sqliteTable("hypotheses", {
  id: text("id").primaryKey(),
  engagementId: text("engagement_id")
    .notNull()
    .references(() => engagements.id, { onDelete: "cascade" }),
  statement: text("statement").notNull(),
  status: text("status").notNull(),
  confidence: integer("confidence").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const agentDecisions = sqliteTable("agent_decisions", {
  id: text("id").primaryKey(),
  engagementId: text("engagement_id")
    .notNull()
    .references(() => engagements.id, { onDelete: "cascade" }),
  agent: text("agent").notNull(),
  decision: text("decision").notNull(),
  rationale: text("rationale").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const checkpoints = sqliteTable("checkpoints", {
  id: text("id").primaryKey(),
  engagementId: text("engagement_id")
    .notNull()
    .references(() => engagements.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  payload: text("payload").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const attackPaths = sqliteTable("attack_paths", {
  id: text("id").primaryKey(),
  engagementId: text("engagement_id")
    .notNull()
    .references(() => engagements.id, { onDelete: "cascade" }),
  nodeIds: text("node_ids").notNull(),
  summary: text("summary").notNull(),
  createdAt: integer("created_at").notNull(),
});
