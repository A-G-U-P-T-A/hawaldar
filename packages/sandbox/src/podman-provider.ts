import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { ErrorCode, HawaldarError } from "@hawaldar/shared";
import {
  buildPodmanCpArgs,
  buildPodmanCreateArgs,
  buildPodmanExecArgs,
  buildPodmanRmArgs,
} from "./podman-args.js";
import type {
  CommandRunner,
  SandboxCreateRequest,
  SandboxExecuteRequest,
  SandboxHandle,
  SandboxProvider,
  SandboxResult,
} from "./types.js";

export class PodmanSandboxProvider implements SandboxProvider {
  constructor(
    private readonly runner: CommandRunner,
    private readonly podmanBin = "podman",
  ) {}

  async create(request: SandboxCreateRequest): Promise<SandboxHandle> {
    const id = `hw-${randomUUID()}`;
    await this.runOrThrow(buildPodmanCreateArgs(id, request), 60_000, "create");
    await this.runOrThrow(["start", id], 30_000, "start");
    return { id, image: request.image };
  }

  async execute(handle: SandboxHandle, request: SandboxExecuteRequest): Promise<SandboxResult> {
    const result = await this.runner.run(
      this.podmanBin,
      buildPodmanExecArgs(handle.id, request),
      { timeoutMs: request.timeoutMs },
    );
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    };
  }

  async collectArtifacts(
    handle: SandboxHandle,
    containerPath: string,
    destinationPath: string,
  ): Promise<string[]> {
    mkdirSync(dirname(destinationPath), { recursive: true });
    await this.runOrThrow(buildPodmanCpArgs(handle.id, containerPath, destinationPath), 30_000, "cp");
    return [destinationPath];
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    await this.runOrThrow(buildPodmanRmArgs(handle.id), 30_000, "rm");
  }

  private async runOrThrow(args: readonly string[], timeoutMs: number, step: string): Promise<void> {
    const result = await this.runner.run(this.podmanBin, args, { timeoutMs });
    if (result.exitCode !== 0) {
      throw new HawaldarError(ErrorCode.SANDBOX_FAILURE, `podman ${step} failed`, {
        step,
        exitCode: result.exitCode,
        stderr: result.stderr,
        timedOut: result.timedOut,
      });
    }
  }
}
