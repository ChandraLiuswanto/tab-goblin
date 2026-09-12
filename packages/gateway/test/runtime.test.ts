import { describe, expect, it, vi } from "vitest";
import {
  RuntimeSupervisor,
  containerNameFor,
  volumeNameFor,
  type PodmanExec,
} from "../src/runtime.js";

interface FakePodmanOptions {
  state?: "missing" | "configured" | "exited" | "paused" | "running";
  workspaceId?: string;
  runGate?: Promise<void>;
}

function fakePodman(options: FakePodmanOptions = {}) {
  let containerState = options.state ?? "missing";
  const workspaceId = options.workspaceId ?? "w1";
  const calls: string[][] = [];
  const exec: PodmanExec = vi.fn(async (args: string[], _signal?: AbortSignal) => {
    calls.push(args);

    if (args[0] === "container" && args[1] === "exists") {
      return result(containerState === "missing" ? 1 : 0);
    }
    if (args[0] === "inspect" && args.includes("{{.State.Status}}")) {
      return result(0, containerState + "\n");
    }
    if (args[0] === "inspect") {
      return result(0, workspaceId + "\n");
    }
    if (args[0] === "run") {
      await options.runGate;
      containerState = "running";
      return result(0, "container-id\n");
    }
    if (args[0] === "port") {
      return result(0, args.at(-1) === "9222/tcp" ? "127.0.0.1:41001\n" : "127.0.0.1:41002\n");
    }
    if (args[0] === "stop") {
      containerState = "exited";
      return result();
    }
    if (args[0] === "rm") {
      containerState = "missing";
      return result();
    }
    return result();
  });
  return { exec, calls, state: () => containerState };
}

function result(code = 0, stdout = "", stderr = "") {
  return { code, stdout, stderr };
}

function supervisor(podman: PodmanExec, overrides: Partial<ConstructorParameters<typeof RuntimeSupervisor>[0]> = {}) {
  return new RuntimeSupervisor({
    podman,
    image: "localhost/tabgoblin-runtime:dev",
    probe: async () => true,
    sleep: async () => {},
    ...overrides,
  });
}

describe("name derivation", () => {
  it("is deterministic, distinct, and Podman-name safe", () => {
    expect(containerNameFor("ws/one 2")).toBe(containerNameFor("ws/one 2"));
    expect(containerNameFor("ws/one 2")).not.toBe(containerNameFor("ws-one-2"));
    expect(containerNameFor("ws/one 2")).toMatch(/^tabgoblin-[a-z0-9-]+$/);
    expect(volumeNameFor("ws/one 2")).toMatch(/^tabgoblin-profile-[a-z0-9-]+$/);
  });
});

describe("start", () => {
  it("publishes ephemeral ports only on loopback with private SELinux mounts", async () => {
    const podman = fakePodman();
    const runtime = supervisor(podman.exec);

    const endpoints = await runtime.start("w1");

    const run = podman.calls.find((args) => args[0] === "run")!;
    expect(run.join(" ")).toContain("-p 127.0.0.1:0:9222");
    expect(run.join(" ")).toContain("-p 127.0.0.1:0:5900");
    expect(run.join(" ")).toContain(`${volumeNameFor("w1")}:/profile:Z`);
    expect(run.join(" ")).toContain(`${volumeNameFor("w1")}-staging:/staging:Z`);
    expect(run).not.toContain("--privileged");
    expect(run).not.toContain("--network=host");
    expect(run).not.toContain("--no-sandbox");
    expect(endpoints).toEqual({
      containerName: containerNameFor("w1"),
      volumeName: volumeNameFor("w1"),
      cdpUrl: "http://127.0.0.1:41001",
      vncHost: "127.0.0.1",
      vncPort: 41002,
    });
    expect(runtime.state("w1")).toBe("ready");
  });

  it("reports ready only after the CDP probe succeeds", async () => {
    const podman = fakePodman();
    let probes = 0;
    const runtime = supervisor(podman.exec, { probe: async () => ++probes === 3 });

    expect(runtime.state("w1")).toBe("stopped");
    await runtime.start("w1");

    expect(probes).toBe(3);
    expect(runtime.state("w1")).toBe("ready");
    expect(runtime.endpoints("w1")?.cdpUrl).toBe("http://127.0.0.1:41001");
  });

  it("serializes concurrent starts across supervisors before a second run can relabel the volume", async () => {
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const podman = fakePodman({ runGate });
    const first = supervisor(podman.exec);
    const second = supervisor(podman.exec);

    const firstStart = first.start("w1");
    await vi.waitFor(() => expect(podman.calls.some((args) => args[0] === "run")).toBe(true));
    const secondStart = second.start("w1");
    await Promise.resolve();
    expect(podman.calls.filter((args) => args[0] === "run")).toHaveLength(1);

    releaseRun();
    await expect(Promise.all([firstStart, secondStart])).resolves.toHaveLength(2);
    expect(podman.calls.filter((args) => args[0] === "run")).toHaveLength(1);
  });

  it("discovers a running container after supervisor restart without mutating or relabeling it", async () => {
    const podman = fakePodman({ state: "running" });
    const runtime = supervisor(podman.exec);

    await expect(runtime.start("w1")).resolves.toMatchObject({ cdpUrl: "http://127.0.0.1:41001" });

    expect(podman.calls.some((args) => args[0] === "run")).toBe(false);
    expect(podman.calls.some((args) => args[0] === "volume")).toBe(false);
    expect(podman.calls.some((args) => args[0] === "rm")).toBe(false);
  });

  it("removes a stale stopped container without force before starting its replacement", async () => {
    const podman = fakePodman({ state: "exited" });
    const runtime = supervisor(podman.exec);

    await runtime.start("w1");

    const removeIndex = podman.calls.findIndex((args) => args[0] === "rm");
    const runIndex = podman.calls.findIndex((args) => args[0] === "run");
    expect(removeIndex).toBeGreaterThan(-1);
    expect(removeIndex).toBeLessThan(runIndex);
    expect(podman.calls[removeIndex]).not.toContain("-f");
  });

  it("refuses an ambiguous existing live container instead of issuing another run", async () => {
    const podman = fakePodman({ state: "paused" });
    const runtime = supervisor(podman.exec);

    await expect(runtime.start("w1")).rejects.toMatchObject({
      code: "runtime_unavailable",
      retryable: true,
    });
    expect(podman.calls.some((args) => args[0] === "run")).toBe(false);
    expect(podman.calls.some((args) => args[0] === "rm")).toBe(false);
    expect(runtime.state("w1")).toBe("failed");
  });

  it("bounds and normalizes rejected and nonzero child-process failures", async () => {
    const thrown: PodmanExec = vi.fn(async () => {
      throw new Error("secret:" + "x".repeat(10_000));
    });
    const nonzero: PodmanExec = vi.fn(async (args) => {
      if (args[0] === "container") return result(1);
      if (args[0] === "volume") return result(125, "", "detail:" + "y".repeat(10_000));
      return result();
    });

    for (const podman of [thrown, nonzero]) {
      const error = await supervisor(podman).start("w1").catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code: "runtime_unavailable", retryable: true });
      expect(error.message.length).toBeLessThanOrEqual(400);
      expect(error.message).not.toContain("secret:");
      expect(error.message).not.toContain("detail:");
    }
  });

  it("gracefully stops then removes a newly launched container when readiness times out", async () => {
    const podman = fakePodman();
    const runtime = supervisor(podman.exec, {
      probe: async () => false,
      startTimeoutMs: 15,
      sleep: async () => new Promise<void>((resolve) => setTimeout(resolve, 1)),
    });

    await expect(runtime.start("w1")).rejects.toMatchObject({ code: "runtime_unavailable" });
    await vi.waitFor(() => expect(podman.calls.some((args) => args[0] === "rm")).toBe(true));

    const stopIndex = podman.calls.findIndex((args) => args[0] === "stop");
    const removeIndex = podman.calls.findIndex((args) => args[0] === "rm");
    expect(stopIndex).toBeGreaterThan(-1);
    expect(stopIndex).toBeLessThan(removeIndex);
    expect(podman.calls[removeIndex]).not.toContain("-f");
    expect(runtime.state("w1")).toBe("failed");
  });

  it("bounds a never-settling published-port command, aborts it, and fails closed", async () => {
    const workspaceId = "port-timeout";
    const podman = fakePodman({ workspaceId });
    let rejectPort!: (error: Error) => void;
    const pendingPort = new Promise<{ code: number; stdout: string; stderr: string }>((_resolve, reject) => {
      rejectPort = reject;
    });
    let portSignal: AbortSignal | undefined;
    const exec = vi.fn<PodmanExec>((args, signal) => {
      if (args[0] === "port" && args.at(-1) === "9222/tcp") {
        portSignal = signal;
        return pendingPort;
      }
      return podman.exec(args, signal);
    });
    const runtime = supervisor(exec, { startTimeoutMs: 15, operationTimeoutMs: 15 });
    const unhandled: unknown[] = [];
    const captureUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", captureUnhandled);

    try {
      await expect(runtime.start(workspaceId)).rejects.toMatchObject({ code: "runtime_unavailable" });
      expect(runtime.state(workspaceId)).toBe("failed");
      expect(portSignal?.aborted).toBe(true);

      const callsAtTimeout = exec.mock.calls.length;
      await expect(runtime.start(workspaceId)).rejects.toMatchObject({ code: "runtime_unavailable" });
      const restartedSupervisor = supervisor(exec, { startTimeoutMs: 15, operationTimeoutMs: 15 });
      await expect(restartedSupervisor.start(workspaceId)).rejects.toMatchObject({
        code: "runtime_unavailable",
      });
      expect(exec.mock.calls).toHaveLength(callsAtTimeout);

      rejectPort(new Error("late child rejection"));
      await vi.waitFor(() => expect(podman.calls.some((args) => args[0] === "stop")).toBe(true));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", captureUnhandled);
    }
  }, 1_000);

  it("bounds and aborts a never-settling readiness probe", async () => {
    const workspaceId = "probe-timeout";
    const podman = fakePodman({ workspaceId });
    let probeSignal: AbortSignal | undefined;
    const runtime = supervisor(podman.exec, {
      startTimeoutMs: 15,
      operationTimeoutMs: 15,
      probe: async (_url, signal) => {
        probeSignal = signal;
        return new Promise<boolean>(() => {});
      },
    });

    await expect(runtime.start(workspaceId)).rejects.toMatchObject({ code: "runtime_unavailable" });
    expect(probeSignal?.aborted).toBe(true);
    expect(runtime.state(workspaceId)).toBe("failed");
  }, 1_000);

  it("does not extend the startup deadline when the wall clock rolls backward", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const wallClock = vi.spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(-100);
    const exec: PodmanExec = vi.fn(() => new Promise(() => {}));
    const runtime = supervisor(exec, { startTimeoutMs: 20 });
    let failure: unknown;

    try {
      void runtime.start("clock-rollback").catch((error: unknown) => {
        failure = error;
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(failure).toMatchObject({ code: "runtime_unavailable" });
    } finally {
      wallClock.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("stop", () => {
  it("uses a sufficient bounded graceful timeout before non-forced removal and never deletes volumes", async () => {
    const podman = fakePodman({ state: "running" });
    const runtime = supervisor(podman.exec);
    await runtime.start("w1");

    await runtime.stop("w1");
    await runtime.stop("w1");

    const stopCalls = podman.calls.filter((args) => args[0] === "stop");
    const removeCalls = podman.calls.filter((args) => args[0] === "rm");
    expect(stopCalls).toHaveLength(1);
    expect(removeCalls).toHaveLength(1);
    for (let index = 0; index < stopCalls.length; index += 1) {
      const seconds = Number(stopCalls[index][stopCalls[index].indexOf("--time") + 1]);
      expect(seconds).toBeGreaterThanOrEqual(15);
      expect(seconds).toBeLessThanOrEqual(60);
      expect(podman.calls.indexOf(stopCalls[index])).toBeLessThan(podman.calls.indexOf(removeCalls[index]));
      expect(removeCalls[index]).not.toContain("-f");
    }
    expect(podman.calls.some((args) => args[0] === "volume" && args[1] === "rm")).toBe(false);
    expect(runtime.state("w1")).toBe("stopped");
    expect(runtime.endpoints("w1")).toBeNull();
  });

  it("treats a missing container as an idempotent no-op", async () => {
    const podman = fakePodman({ state: "missing", workspaceId: "missing-stop" });
    const runtime = supervisor(podman.exec);

    await runtime.stop("missing-stop");

    expect(podman.calls.some((args) => args[0] === "stop" || args[0] === "rm")).toBe(false);
    expect(runtime.state("missing-stop")).toBe("stopped");
  });

  it("rejects a foreign same-name container without stopping or removing it", async () => {
    const podman = fakePodman({ state: "running", workspaceId: "someone-else" });
    const runtime = supervisor(podman.exec);

    await expect(runtime.stop("owned-workspace")).rejects.toMatchObject({ code: "runtime_unavailable" });

    expect(podman.calls.some((args) => args[0] === "stop" || args[0] === "rm")).toBe(false);
    expect(runtime.state("owned-workspace")).toBe("failed");
  });

  it("keeps a 30-second graceful-stop budget when the general operation timeout is short", async () => {
    vi.useFakeTimers();
    const workspaceId = "stop-timeout";
    const podman = fakePodman({ state: "running", workspaceId });
    let stopSignal: AbortSignal | undefined;
    const exec: PodmanExec = vi.fn((args, signal) => {
      if (args[0] === "stop") {
        stopSignal = signal;
        return new Promise((_resolve, reject) => {
          const onAbort = () => reject(signal?.reason ?? new Error("Stop aborted"));
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      return podman.exec(args, signal);
    });
    const runtime = supervisor(exec, { operationTimeoutMs: 15 });

    try {
      const stopping = runtime.stop(workspaceId).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(stopSignal).toBeDefined();
      expect(exec.mock.calls.find(([args]) => args[0] === "stop")?.[0]).toContain("20");

      await vi.advanceTimersByTimeAsync(15);
      expect(stopSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(29_985);
      await expect(stopping).resolves.toMatchObject({ code: "runtime_unavailable" });
      expect(stopSignal?.aborted).toBe(true);
      expect(runtime.state(workspaceId)).toBe("failed");
      expect(podman.calls.some((args) => args[0] === "rm")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  }, 1_000);
});

describe("staging", () => {
  it("copies into the controlled staging path of an owned running container and maps failures", async () => {
    const podman = fakePodman({ state: "running" });
    const runtime = supervisor(podman.exec);

    await expect(runtime.stageFile("w1", "/workspace/report.txt", "report.txt")).resolves.toBe(
      "/staging/report.txt",
    );
    expect(podman.calls.at(-1)).toEqual([
      "cp",
      "/workspace/report.txt",
      `${containerNameFor("w1")}:/staging/report.txt`,
    ]);

    const failingPodman = fakePodman({ state: "running", workspaceId: "copy-failure" });
    const failing = supervisor(async (args, signal) => {
      if (args[0] === "cp") return result(125, "", "copy failed");
      return failingPodman.exec(args, signal);
    });
    await expect(
      failing.stageFile("copy-failure", "/workspace/report.txt", "report.txt"),
    ).rejects.toMatchObject({ code: "runtime_unavailable" });
  });

  it("rejects missing, stopped, and foreign containers without copying", async () => {
    const cases = [
      fakePodman({ state: "missing", workspaceId: "missing-stage" }),
      fakePodman({ state: "exited", workspaceId: "stopped-stage" }),
      fakePodman({ state: "running", workspaceId: "someone-else" }),
    ];

    for (const [index, podman] of cases.entries()) {
      const workspaceId = ["missing-stage", "stopped-stage", "foreign-stage"][index]!;
      await expect(
        supervisor(podman.exec).stageFile(workspaceId, "/workspace/report.txt", "report.txt"),
      ).rejects.toMatchObject({ code: "runtime_unavailable" });
      expect(podman.calls.some((args) => args[0] === "cp")).toBe(false);
    }
  });

  it("bounds a never-settling copy and passes it an abort signal", async () => {
    const workspaceId = "stage-timeout";
    const podman = fakePodman({ state: "running", workspaceId });
    let copySignal: AbortSignal | undefined;
    const exec: PodmanExec = vi.fn((args, signal) => {
      if (args[0] === "cp") {
        copySignal = signal;
        return new Promise(() => {});
      }
      return podman.exec(args, signal);
    });
    const runtime = supervisor(exec, { operationTimeoutMs: 15 });

    await expect(
      runtime.stageFile(workspaceId, "/workspace/report.txt", "report.txt"),
    ).rejects.toMatchObject({ code: "runtime_unavailable" });
    expect(copySignal?.aborted).toBe(true);
  }, 1_000);
});
