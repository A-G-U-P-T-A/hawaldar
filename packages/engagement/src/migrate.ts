import type { Database } from "better-sqlite3";

const INITIAL_SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS engagements (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  paused_at INTEGER
);

CREATE TABLE IF NOT EXISTS scope_entries (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_nodes (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  canonical_key TEXT NOT NULL,
  label TEXT NOT NULL,
  data TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS graph_nodes_engagement_key
  ON graph_nodes(engagement_id, canonical_key);

CREATE TABLE IF NOT EXISTS graph_edges (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS graph_edges_unique
  ON graph_edges(engagement_id, source_id, target_id, type);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES graph_nodes(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  finding_id TEXT REFERENCES findings(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  uri TEXT NOT NULL,
  metadata TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_executions (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  request TEXT NOT NULL,
  stdout TEXT NOT NULL,
  stderr TEXT NOT NULL,
  exit_code INTEGER,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS scripts (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  creator_agent TEXT NOT NULL,
  source_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS hypotheses (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  statement TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_decisions (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  decision TEXT NOT NULL,
  rationale TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attack_paths (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  node_ids TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export function applySchema(sqlite: Database): void {
  sqlite.exec(INITIAL_SCHEMA);
}
