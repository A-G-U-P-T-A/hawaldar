import type { FilesystemMount, NetworkPolicy, SandboxCreateRequest, SandboxExecuteRequest } from "./types.js";

export function networkFlag(policy: NetworkPolicy): string {
  if (policy === "target") {
    return "slirp4netns";
  }
  return "none";
}

function bindMountFlags(mounts: readonly FilesystemMount[] | undefined): string[] {
  if (!mounts) {
    return [];
  }
  return mounts.flatMap((mount) => [
    "-v",
    `${mount.source}:${mount.target}${mount.readonly ? ":ro" : ""}`,
  ]);
}

function envFlags(environment: Readonly<Record<string, string>> | undefined): string[] {
  if (!environment) {
    return [];
  }
  return Object.entries(environment).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

export function buildPodmanCreateArgs(id: string, request: SandboxCreateRequest): string[] {
  const workdir = request.workingDirectory ? ["-w", request.workingDirectory] : [];
  return [
    "create",
    "--name",
    id,
    "--replace",
    "--userns=keep-id",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop=ALL",
    "--network",
    networkFlag(request.network),
    "--cpus",
    String(request.limits.cpus),
    "--memory",
    `${request.limits.memoryMb}m`,
    "--pids-limit",
    String(request.limits.pids),
    ...bindMountFlags(request.mounts),
    ...envFlags(request.environment),
    ...workdir,
    "--entrypoint",
    "sleep",
    request.image,
    "infinity",
  ];
}

export function buildPodmanExecArgs(
  id: string,
  request: SandboxExecuteRequest,
): string[] {
  const workdir = request.workingDirectory ? ["-w", request.workingDirectory] : [];
  return [
    "exec",
    ...envFlags(request.environment),
    ...workdir,
    id,
    request.command,
    ...request.args,
  ];
}

export function buildPodmanCpArgs(
  id: string,
  containerPath: string,
  destinationPath: string,
): string[] {
  return ["cp", `${id}:${containerPath}`, destinationPath];
}

export function buildPodmanRmArgs(id: string): string[] {
  return ["rm", "-f", id];
}
