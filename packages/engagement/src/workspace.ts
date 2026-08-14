import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface EngagementWorkspace {
  readonly root: string;
  readonly scripts: string;
  readonly artifacts: string;
  readonly evidence: string;
  readonly toolOutput: string;
  readonly logs: string;
  readonly checkpoints: string;
}

export function engagementWorkspace(
  dataDir: string,
  engagementId: string,
): EngagementWorkspace {
  const root = join(dataDir, "engagements", engagementId);
  return {
    root,
    scripts: join(root, "scripts"),
    artifacts: join(root, "artifacts"),
    evidence: join(root, "evidence"),
    toolOutput: join(root, "tool-output"),
    logs: join(root, "logs"),
    checkpoints: join(root, "checkpoints"),
  };
}

export function ensureWorkspace(workspace: EngagementWorkspace): EngagementWorkspace {
  for (const dir of Object.values(workspace)) {
    mkdirSync(dir, { recursive: true });
  }
  return workspace;
}
