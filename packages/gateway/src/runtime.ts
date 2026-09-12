import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  RUNTIME_OPERATION_TIMEOUT_MS,
  RUNTIME_START_TIMEOUT_MS,
  RUNTIME_STOP_TIMEOUT_MS,
  tabGoblinError,
  type SessionState,
  type TabGoblinError,
} from "@tab-goblin/protocol";

/**
 * T9 production executors MUST terminate the child process when this signal aborts.
 * Promise.race bounds the caller only; honoring the signal prevents late external mutation.
 */
export type PodmanExec = (
  args: string[],
  signal?: AbortSignal,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface RuntimeEndpoints {
  containerName: string;
  volumeName: string;
  cdpUrl: string;
  vncHost: string;
  vncPort: number;
}

export interface RuntimeSupervisorOptions {
  podman: PodmanExec;
  image: string;
  /** T9 production probes MUST cancel their request when this signal aborts. */
  probe: (cdpUrl: string, signal?: AbortSignal) => Promise<boolean>;
  startTimeoutMs?: number;
  /**
   * Overall staging-operation budget. Stop and each startup cleanup use one absolute
   * deadline of at least 30 seconds across discovery, graceful stop, and removal.
   */
  operationTimeoutMs?: number;
  /** Monotonic millisecond clock used for deadline accounting; defaults to performance.now. */
  monotonicNow?: () => number;
  /** @deprecated Use monotonicNow. Legacy clocks are guarded against backward jumps. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

interface Entry {
  state: SessionState;
  endpoints: RuntimeEndpoints | null;
  starting: Promise<RuntimeEndpoints> | null;
  stopping: Promise<void> | null;
  blocked: Promise<void> | null;
}

interface PodmanResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_TIMER_MS = 2_147_483_647;
const GRACEFUL_STOP_SECONDS = 20;
const POLL_INTERVAL_MS = 500;
const lifecycleLocks = new Map<string, Promise<void>>();

class DeadlineExceeded {
  constructor(
    readonly failure: TabGoblinError,
    readonly quiesced: Promise<void>,
  ) {}
}

function slug(workspaceId: string): string {
  const readable = workspaceId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const digest = createHash("sha256").update(workspaceId).digest("hex").slice(0, 10);
  return `${readable.slice(0, 24) || "ws"}-${digest}`;
}

export function containerNameFor(workspaceId: string): string {
  return `tabgoblin-${slug(workspaceId)}`;
}

export function volumeNameFor(workspaceId: string): string {
  return `tabgoblin-profile-${slug(workspaceId)}`;
}

function unavailable(message: string): TabGoblinError {
  return tabGoblinError("runtime_unavailable", message);
}

function duration(value: number | undefined, fallback: number, option: string): number {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected) || selected <= 0 || selected > MAX_TIMER_MS) {
    throw tabGoblinError("invalid_input", `${option} must be a finite positive duration`);
  }
  return selected;
}

function guardLegacyClock(clock: () => number): () => number {
  let highWater = clock();
  let value = highWater;
  let performanceMark = performance.now();

  return () => {
    const next = clock();
    const nextPerformanceMark = performance.now();
    const clockElapsed = Number.isFinite(next) && next > highWater ? next - highWater : 0;
    const realElapsed = Math.max(0, nextPerformanceMark - performanceMark);
    value += Math.max(clockElapsed, realElapsed);
    if (Number.isFinite(next)) highWater = Math.max(highWater, next);
    performanceMark = nextPerformanceMark;
    return value;
  };
}

export class RuntimeSupervisor {
  private readonly entries = new Map<string, Entry>();
  private readonly timeout: number;
  private readonly operationTimeout: number;
  private readonly stopOperationTimeout: number;
  private readonly monotonicNow: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly options: RuntimeSupervisorOptions) {
    this.timeout = duration(options.startTimeoutMs, RUNTIME_START_TIMEOUT_MS, "startTimeoutMs");
    this.operationTimeout = duration(
      options.operationTimeoutMs,
      RUNTIME_OPERATION_TIMEOUT_MS,
      "operationTimeoutMs",
    );
    this.stopOperationTimeout = Math.max(
      this.operationTimeout,
      RUNTIME_STOP_TIMEOUT_MS,
    );
    this.monotonicNow = options.monotonicNow
      ?? (options.now ? guardLegacyClock(options.now) : () => performance.now());
    this.sleep = options.sleep ?? ((ms, signal) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new Error("Sleep aborted"));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    }));
  }

  state(workspaceId: string): SessionState {
    return this.entries.get(workspaceId)?.state ?? "stopped";
  }

  endpoints(workspaceId: string): RuntimeEndpoints | null {
    return this.entries.get(workspaceId)?.endpoints ?? null;
  }

  start(workspaceId: string): Promise<RuntimeEndpoints> {
    const existing = this.entries.get(workspaceId);
    if (existing?.blocked) {
      return Promise.reject(unavailable("A prior browser runtime operation has not terminated"));
    }
    if (existing?.stopping) {
      return existing.stopping.then(() => this.start(workspaceId));
    }
    if (existing?.state === "ready" && existing.endpoints) {
      return Promise.resolve(existing.endpoints);
    }
    if (existing?.starting) return existing.starting;

    const entry: Entry = {
      state: "starting",
      endpoints: null,
      starting: null,
      stopping: null,
      blocked: null,
    };
    this.entries.set(workspaceId, entry);

    const name = containerNameFor(workspaceId);
    const deadline = this.deadline(this.timeout);
    entry.starting = this.withLifecycleLock(name, deadline, () => this.launch(workspaceId, deadline))
      .then((runtimeEndpoints) => {
        entry.state = "ready";
        entry.endpoints = runtimeEndpoints;
        return runtimeEndpoints;
      })
      .catch((error: unknown) => {
        entry.state = "failed";
        entry.endpoints = null;
        if (error instanceof DeadlineExceeded) {
          this.blockEntry(entry, error.quiesced);
          throw error.failure;
        }
        throw error;
      })
      .finally(() => {
        entry.starting = null;
      });
    return entry.starting;
  }

  async stop(workspaceId: string): Promise<void> {
    const entry = this.entries.get(workspaceId) ?? this.newStoppedEntry();
    this.entries.set(workspaceId, entry);
    if (entry.blocked) {
      throw unavailable("A prior browser runtime operation has not terminated");
    }
    if (entry.stopping) return entry.stopping;

    const containerName = containerNameFor(workspaceId);
    const deadline = this.deadline(this.stopOperationTimeout);
    entry.stopping = this.withLifecycleLock(containerName, deadline, async () => {
      const state = await this.existingContainerState(containerName, workspaceId, deadline);
      if (state === null) return;
      await this.removeOwnedContainer(containerName, state, deadline);
    })
      .then(() => {
        entry.state = "stopped";
        entry.endpoints = null;
      })
      .catch((error: unknown) => {
        entry.state = "failed";
        entry.endpoints = null;
        if (error instanceof DeadlineExceeded) {
          this.blockEntry(entry, error.quiesced);
          throw tabGoblinError(
            "timeout_uncertain",
            "The browser runtime stop could not be proven complete; inspect state before continuing",
          );
        }
        throw error;
      })
      .finally(() => {
        entry.stopping = null;
      });
    return entry.stopping;
  }

  async stageFile(workspaceId: string, hostPath: string, name: string): Promise<string> {
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      throw tabGoblinError("invalid_input", "The staging file name must be a plain file name");
    }

    const containerName = containerNameFor(workspaceId);
    const target = `/staging/${name}`;
    const deadline = this.deadline(this.operationTimeout);
    try {
      return await this.withLifecycleLock(containerName, deadline, async () => {
        const state = await this.existingContainerState(containerName, workspaceId, deadline);
        if (state !== "running") {
          throw unavailable("File staging requires an owned running browser runtime");
        }
        await this.requireSuccess(
          ["cp", hostPath, `${containerName}:${target}`],
          "stage the file into the browser runtime",
          deadline,
        );
        return target;
      });
    } catch (error: unknown) {
      if (error instanceof DeadlineExceeded) throw error.failure;
      throw error;
    }
  }

  private newStoppedEntry(): Entry {
    return {
      state: "stopped",
      endpoints: null,
      starting: null,
      stopping: null,
      blocked: null,
    };
  }

  private blockEntry(entry: Entry, quiesced: Promise<void>): void {
    entry.blocked = quiesced;
    void quiesced.then(() => {
      if (entry.blocked === quiesced) entry.blocked = null;
    });
  }

  private async launch(workspaceId: string, deadline: number): Promise<RuntimeEndpoints> {
    const containerName = containerNameFor(workspaceId);
    const volumeName = volumeNameFor(workspaceId);
    const stagingName = `${volumeName}-staging`;
    const existingState = await this.existingContainerState(containerName, workspaceId, deadline);

    if (existingState === "running") {
      return this.resolveAndAwaitReady(workspaceId, containerName, volumeName, deadline);
    }
    if (existingState && !this.isStaleState(existingState)) {
      throw unavailable(`The existing browser runtime is ${existingState}; refusing to replace it`);
    }
    if (existingState) {
      await this.requireSuccess(
        ["rm", "--ignore", containerName],
        "remove the stale browser runtime",
        deadline,
      );
    }

    await this.requireSuccess(
      ["volume", "create", "--ignore", volumeName],
      "prepare the browser profile volume",
      deadline,
    );
    await this.requireSuccess(
      ["volume", "create", "--ignore", stagingName],
      "prepare the browser staging volume",
      deadline,
    );

    const run = await this.invoke([
      "run",
      "-d",
      "--name",
      containerName,
      "-p",
      "127.0.0.1::9222",
      "-p",
      "127.0.0.1::5900",
      "-v",
      `${volumeName}:/profile:Z`,
      "-v",
      `${stagingName}:/staging:Z`,
      "--shm-size=512m",
      "--label",
      `tabgoblin.workspace=${workspaceId}`,
      this.options.image,
    ], "start the browser runtime", deadline);
    if (run.code !== 0) throw unavailable("Could not start the browser runtime");

    return this.resolveAndAwaitReady(workspaceId, containerName, volumeName, deadline);
  }

  private async existingContainerState(
    containerName: string,
    workspaceId: string,
    deadline: number,
  ): Promise<string | null> {
    const exists = await this.invoke(
      ["container", "exists", containerName],
      "check for an existing browser runtime",
      deadline,
    );
    if (exists.code === 1) return null;
    if (exists.code !== 0) throw unavailable("Could not check for an existing browser runtime");

    const status = await this.requireSuccess(
      ["inspect", "--format", "{{.State.Status}}", containerName],
      "inspect the existing browser runtime",
      deadline,
    );
    const label = await this.requireSuccess(
      ["inspect", "--format", '{{ index .Config.Labels "tabgoblin.workspace" }}', containerName],
      "inspect the existing browser runtime owner",
      deadline,
    );
    if (label.stdout.trim() !== workspaceId) {
      throw unavailable("The existing browser runtime belongs to a different workspace");
    }

    const state = status.stdout.trim().toLowerCase();
    if (!state) throw unavailable("The existing browser runtime has no lifecycle state");
    return state;
  }

  private isStaleState(state: string): boolean {
    return ["configured", "created", "exited", "initialized", "stopped"].includes(state);
  }

  private async resolveAndAwaitReady(
    workspaceId: string,
    containerName: string,
    volumeName: string,
    deadline: number,
  ): Promise<RuntimeEndpoints> {
    try {
      const cdpPort = await this.publishedPort(containerName, 9222, deadline);
      const vncPort = await this.publishedPort(containerName, 5900, deadline);
      const runtimeEndpoints: RuntimeEndpoints = {
        containerName,
        volumeName,
        cdpUrl: `http://127.0.0.1:${cdpPort}`,
        vncHost: "127.0.0.1",
        vncPort,
      };

      while (true) {
        let ready = false;
        try {
          ready = await this.withDeadline(
            deadline,
            "wait for the browser runtime readiness probe",
            (signal) => this.options.probe(runtimeEndpoints.cdpUrl, signal),
          );
        } catch (error: unknown) {
          if (error instanceof DeadlineExceeded) throw error;
        }
        if (ready) return runtimeEndpoints;

        const pause = Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - this.monotonicNow()));
        await this.withDeadline(deadline, "wait to retry the browser runtime probe", (signal) =>
          this.sleep(pause, signal),
        );
      }
    } catch (error: unknown) {
      if (error instanceof DeadlineExceeded) {
        throw new DeadlineExceeded(
          error.failure,
          this.cleanupAfterQuiescence(error.quiesced, workspaceId, containerName),
        );
      }

      try {
        await this.cleanupOwned(workspaceId, containerName);
      } catch (cleanupError: unknown) {
        if (cleanupError instanceof DeadlineExceeded) {
          throw new DeadlineExceeded(unavailable("Browser runtime startup cleanup timed out"), cleanupError.quiesced);
        }
      }
      throw error;
    }
  }

  private cleanupAfterQuiescence(
    quiesced: Promise<void>,
    workspaceId: string,
    containerName: string,
  ): Promise<void> {
    return quiesced.then(async () => {
      try {
        await this.cleanupOwned(workspaceId, containerName);
      } catch (error: unknown) {
        if (error instanceof DeadlineExceeded) await error.quiesced;
      }
    });
  }

  private async cleanupOwned(workspaceId: string, containerName: string): Promise<void> {
    const deadline = this.deadline(this.stopOperationTimeout);
    const state = await this.existingContainerState(containerName, workspaceId, deadline);
    if (state !== null) await this.removeOwnedContainer(containerName, state, deadline);
  }

  private async publishedPort(
    containerName: string,
    internalPort: number,
    deadline: number,
  ): Promise<number> {
    const result = await this.requireSuccess(
      ["port", containerName, `${internalPort}/tcp`],
      "resolve a browser runtime port",
      deadline,
    );
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    const match = lines.length === 1 ? /^127\.0\.0\.1:(\d+)$/.exec(lines[0]!) : null;
    const port = Number(match?.[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw unavailable("Could not resolve a loopback-only browser runtime port");
    }
    return port;
  }

  private async removeOwnedContainer(
    containerName: string,
    state: string,
    deadline: number,
  ): Promise<void> {
    if (!this.isStaleState(state)) {
      await this.requireSuccess(
        ["stop", "--ignore", "--time", String(GRACEFUL_STOP_SECONDS), containerName],
        "stop the browser runtime gracefully",
        deadline,
      );
    }
    await this.requireSuccess(
      ["rm", "--ignore", containerName],
      "remove the stopped browser runtime",
      deadline,
    );
  }

  private async requireSuccess(
    args: string[],
    action: string,
    deadline: number,
  ): Promise<PodmanResult> {
    const result = await this.invoke(args, action, deadline);
    if (result.code !== 0) throw unavailable(`Could not ${action}`);
    return result;
  }

  private async invoke(args: string[], action: string, deadline: number): Promise<PodmanResult> {
    try {
      return await this.withDeadline(deadline, action, (signal) => this.options.podman(args, signal));
    } catch (error: unknown) {
      if (error instanceof DeadlineExceeded) throw error;
      throw unavailable(`Could not ${action}`);
    }
  }

  private deadline(timeout: number): number {
    return this.monotonicNow() + timeout;
  }

  private async withDeadline<T>(
    deadline: number,
    action: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const remaining = deadline - this.monotonicNow();
    if (remaining <= 0) {
      throw new DeadlineExceeded(unavailable(`Timed out while trying to ${action}`), Promise.resolve());
    }

    const controller = new AbortController();
    const operationPromise = Promise.resolve().then(() => operation(controller.signal));
    const quiesced = operationPromise.then(
      () => undefined,
      () => undefined,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new DeadlineExceeded(unavailable(`Timed out while trying to ${action}`), quiesced));
      }, Math.max(1, Math.ceil(remaining)));
    });

    try {
      return await Promise.race([operationPromise, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private withLifecycleLock<T>(
    name: string,
    deadline: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = lifecycleLocks.get(name) ?? Promise.resolve();
    const result = this.withDeadline(deadline, "wait for the prior browser runtime operation", () => previous)
      .then(operation);
    const hold = result.then(
      () => undefined,
      (error: unknown) => error instanceof DeadlineExceeded ? error.quiesced : undefined,
    );
    lifecycleLocks.set(name, hold);
    void hold.then(() => {
      if (lifecycleLocks.get(name) === hold) lifecycleLocks.delete(name);
    });
    return result;
  }
}
