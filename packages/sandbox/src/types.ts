export const NetworkPolicy = {
  NONE: "none",
  ISOLATED: "isolated",
  TARGET: "target",
} as const;

export type NetworkPolicy = (typeof NetworkPolicy)[keyof typeof NetworkPolicy];

export interface FilesystemMount {
  readonly source: string;
  readonly target: string;
  readonly readonly: boolean;
}

export interface SandboxLimits {
  readonly cpus: number;
  readonly memoryMb: number;
  readonly pids: number;
}

export interface SandboxCreateRequest {
  readonly image: string;
  readonly network: NetworkPolicy;
  readonly limits: SandboxLimits;
  readonly mounts?: readonly FilesystemMount[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly workingDirectory?: string;
}

export interface SandboxExecuteRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly workingDirectory?: string;
}

export interface SandboxHandle {
  readonly id: string;
  readonly image: string;
}

export interface SandboxResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface SandboxProvider {
  create(request: SandboxCreateRequest): Promise<SandboxHandle>;
  execute(handle: SandboxHandle, request: SandboxExecuteRequest): Promise<SandboxResult>;
  collectArtifacts(handle: SandboxHandle, containerPath: string, destinationPath: string): Promise<string[]>;
  destroy(handle: SandboxHandle): Promise<void>;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface CommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: { timeoutMs: number },
  ): Promise<CommandResult>;
}
