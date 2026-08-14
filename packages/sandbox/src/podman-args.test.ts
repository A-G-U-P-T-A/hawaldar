import { describe, expect, it } from "vitest";
import { buildPodmanCreateArgs, buildPodmanExecArgs, networkFlag } from "./podman-args.js";
import { NetworkPolicy } from "./types.js";

describe("podman args", () => {
  it("maps network policy to podman networks", () => {
    expect(networkFlag(NetworkPolicy.NONE)).toBe("none");
    expect(networkFlag(NetworkPolicy.ISOLATED)).toBe("none");
    expect(networkFlag(NetworkPolicy.TARGET)).toBe("slirp4netns");
  });

  it("builds a rootless create command with mounts and limits", () => {
    const args = buildPodmanCreateArgs("hw-1", {
      image: "docker.io/instrumentisto/nmap:7.95",
      network: NetworkPolicy.TARGET,
      limits: { cpus: 1, memoryMb: 256, pids: 64 },
      mounts: [{ source: "C:\\eng\\out", target: "/out", readonly: false }],
      environment: { HW_ENGAGEMENT: "abc" },
      workingDirectory: "/out",
    });

    expect(args.slice(0, 4)).toEqual(["create", "--name", "hw-1", "--replace"]);
    expect(args).toContain("--userns=keep-id");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("slirp4netns");
    expect(args).toContain("256m");
    expect(args).toEqual(expect.arrayContaining(["-v", "C:\\eng\\out:/out"]));
    expect(args).toEqual(expect.arrayContaining(["-e", "HW_ENGAGEMENT=abc"]));
    expect(args.slice(-4)).toEqual([
      "--entrypoint",
      "sleep",
      "docker.io/instrumentisto/nmap:7.95",
      "infinity",
    ]);
  });

  it("builds exec without a host shell wrapper", () => {
    const args = buildPodmanExecArgs("hw-1", {
      command: "nmap",
      args: ["-sV", "127.0.0.1"],
      timeoutMs: 1000,
    });
    expect(args).toEqual(["exec", "hw-1", "nmap", "-sV", "127.0.0.1"]);
  });
});
