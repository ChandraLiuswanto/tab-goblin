import { createHash } from "node:crypto";
import { tabGoblinError, type SessionState } from "@tab-goblin/protocol";

export type PodmanExec = (
  args: string[],
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
  probe: (cdpUrl: string) => Promise<boolean>;
  startTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Entry {
  state: SessionState;
  endpoints: RuntimeEndpoints | null;
  starting: Promise<RuntimeEndpoints> | null;
  stopping: Promise<void> | null;
}

interface PodmanResult {
  code: number;
  stdout: string;
  stderr: string;
}

const GRACEFUL_STOP_SECONDS = 20;
const POLL_INTERVAL_MS = 500;
const lifecycleLocks = new Map<string, Promise<void>>();

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

function unavailable(message: string) {
  return tabGoblinError("runtime_unavailable", message);
}

function withLifecycleLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const previous = lifecycleLocks.get(name) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  lifecycleLocks.set(name, settled);
  void settled.finally(() => {
    if (lifecycleLocks.get(name) === settled) lifecycleLocks.delete(name);
  });
  return result;
}

export class RuntimeSupervisor {
  private readonly entries = new Map<string, Entry>();
  private readonly timeout: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: RuntimeSupervisorOptions) {
    this.timeout = options.startTimeoutMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  state(workspaceId: string): SessionState {
    return this.entries.get(workspaceId)?.state ?? "stopped";
  }

  endpoints(workspaceId: string): RuntimeEndpoints | null {
    return this.entries.get(workspaceId)?.endpoints ?? null;
  }

  start(workspaceId: string): Promise<RuntimeEndpoints> {
    const existing = this.entries.get(workspaceId);
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
    };
    this.entries.set(workspaceId, entry);

    const name = containerNameFor(workspaceId);
    entry.starting = withLifecycleLock(name, () => this.launch(workspaceId))
      .then((runtimeEndpoints) => {
        entry.state = "ready";
        entry.endpoints = runtimeEndpoints;
        return runtimeEndpoints;
      })
      .catch((error: unknown) => {
        entry.state = "failed";
        entry.endpoints = null;
        throw error;
      })
      .finally(() => {
        entry.starting = null;
      });
    return entry.starting;
  }

  async stop(workspaceId: string): Promise<void> {
    const entry = this.entries.get(workspaceId) ?? {
      state: "stopped" as const,
      endpoints: null,
      starting: null,
      stopping: null,
    };
    this.entries.set(workspaceId, entry);
    if (entry.stopping) return entry.stopping;

    entry.stopping = withLifecycleLock(containerNameFor(workspaceId), () =>
      this.gracefullyRemove(containerNameFor(workspaceId)),
    )
      .then(() => {
        entry.state = "stopped";
        entry.endpoints = null;
      })
      .catch((error: unknown) => {
        entry.state = "failed";
        entry.endpoints = null;
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

    const target = `/staging/${name}`;
    await this.requireSuccess(
      ["cp", hostPath, `${containerNameFor(workspaceId)}:${target}`],
      "stage the file into the browser runtime",
    );
    return target;
  }

  private async launch(workspaceId: string): Promise<RuntimeEndpoints> {
    const containerName = containerNameFor(workspaceId);
    const volumeName = volumeNameFor(workspaceId);
    const stagingName = `${volumeName}-staging`;
    const existingState = await this.existingContainerState(containerName, workspaceId);

    if (existingState === "running") {
      return this.resolveAndAwaitReady(containerName, volumeName, true);
    }
    if (existingState && !this.isStaleState(existingState)) {
      throw unavailable(`The existing browser runtime is ${existingState}; refusing to replace it`);
    }
    if (existingState) {
      await this.requireSuccess(
        ["rm", "--ignore", containerName],
        "remove the stale browser runtime",
      );
    }

    await this.requireSuccess(
      ["volume", "create", "--ignore", volumeName],
      "prepare the browser profile volume",
    );
    await this.requireSuccess(
      ["volume", "create", "--ignore", stagingName],
      "prepare the browser staging volume",
    );

    const run = await this.invoke([
      "run",
      "-d",
      "--name",
      containerName,
      "-p",
      "127.0.0.1:0:9222",
      "-p",
      "127.0.0.1:0:5900",
      "-v",
      `${volumeName}:/profile:Z`,
      "-v",
      `${stagingName}:/staging:Z`,
      "--shm-size=512m",
      "--label",
      `tabgoblin.workspace=${workspaceId}`,
      this.options.image,
    ], "start the browser runtime");
    if (run.code !== 0) {
      throw unavailable("Could not start the browser runtime");
    }

    return this.resolveAndAwaitReady(containerName, volumeName, true);
  }

  private async existingContainerState(
    containerName: string,
    workspaceId: string,
  ): Promise<string | null> {
    const exists = await this.invoke(
      ["container", "exists", containerName],
      "check for an existing browser runtime",
    );
    if (exists.code === 1) return null;
    if (exists.code !== 0) {
      throw unavailable("Could not check for an existing browser runtime");
    }

    const status = await this.requireSuccess(
      ["inspect", "--format", "{{.State.Status}}", containerName],
      "inspect the existing browser runtime",
    );
    const label = await this.requireSuccess(
      ["inspect", "--format", '{{ index .Config.Labels "tabgoblin.workspace" }}', containerName],
      "inspect the existing browser runtime owner",
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
    containerName: string,
    volumeName: string,
    cleanUpOnFailure: boolean,
  ): Promise<RuntimeEndpoints> {
    try {
      const cdpPort = await this.publishedPort(containerName, 9222);
      const vncPort = await this.publishedPort(containerName, 5900);
      const runtimeEndpoints: RuntimeEndpoints = {
        containerName,
        volumeName,
        cdpUrl: `http://127.0.0.1:${cdpPort}`,
        vncHost: "127.0.0.1",
        vncPort,
      };

      const deadline = this.now() + this.timeout;
      while (this.now() < deadline) {
        try {
          if (await this.options.probe(runtimeEndpoints.cdpUrl)) return runtimeEndpoints;
        } catch {
          // A transient probe transport failure means "not ready" until the deadline.
        }
        await this.sleep(POLL_INTERVAL_MS);
      }
      throw unavailable("The browser runtime did not become ready in time");
    } catch (error: unknown) {
      if (cleanUpOnFailure) {
        try {
          await this.gracefullyRemove(containerName);
        } catch {
          // Preserve the original bounded startup failure. Cleanup remains non-destructive.
        }
      }
      throw error;
    }
  }

  private async publishedPort(containerName: string, internalPort: number): Promise<number> {
    const result = await this.requireSuccess(
      ["port", containerName, `${internalPort}/tcp`],
      "resolve a browser runtime port",
    );
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    const match = lines.length === 1 ? /^127\.0\.0\.1:(\d+)$/.exec(lines[0]!) : null;
    const port = Number(match?.[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw unavailable("Could not resolve a loopback-only browser runtime port");
    }
    return port;
  }

  private async gracefullyRemove(containerName: string): Promise<void> {
    await this.requireSuccess(
      ["stop", "--ignore", "--time", String(GRACEFUL_STOP_SECONDS), containerName],
      "stop the browser runtime gracefully",
    );
    await this.requireSuccess(
      ["rm", "--ignore", containerName],
      "remove the stopped browser runtime",
    );
  }

  private async requireSuccess(args: string[], action: string): Promise<PodmanResult> {
    const result = await this.invoke(args, action);
    if (result.code !== 0) throw unavailable(`Could not ${action}`);
    return result;
  }

  private async invoke(args: string[], action: string): Promise<PodmanResult> {
    try {
      return await this.options.podman(args);
    } catch {
      throw unavailable(`Could not ${action}`);
    }
  }
}
