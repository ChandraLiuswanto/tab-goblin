import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ActivityFeed } from "./activity-feed.js";
import { createAdminServer, type WorkspaceServices } from "./admin-server.js";
import { BrowserSession } from "./browser.js";
import { EnrollmentRegistry } from "./enrollment.js";
import { OwnershipController } from "./ownership.js";
import { PairingCodes } from "./pairing.js";
import { RuntimeSupervisor, type PodmanExec } from "./runtime.js";
import { createViewerServer } from "./viewer-server.js";

const PROCESS_OUTPUT_LIMIT = 1024 * 1024;
const ABORT_KILL_GRACE_MS = 1_000;
const DEFAULT_VIEWER_PORT = 8_931;
const DEFAULT_IMAGE = "localhost/tabgoblin-runtime:latest";

export interface WorkspaceServiceOptions {
  runtime: RuntimeSupervisor;
  pairing: PairingCodes;
  viewerUrl: string | null | (() => string | null);
  attachBrowser?: (cdpUrl: string) => Promise<BrowserSession>;
}

interface WorkspaceEntry {
  ownership: OwnershipController;
  activity: ActivityFeed;
  browser: {
    cdpUrl: string;
    promise: Promise<BrowserSession>;
    session: BrowserSession | null;
  } | null;
}

export interface RunGatewayOptions {
  xdgRuntimeDir?: string;
  viewerPort?: number;
  viewerOrigins?: string[];
  staticRoot?: string;
  image?: string;
  podman?: PodmanExec;
  probe?: (cdpUrl: string, signal?: AbortSignal) => Promise<boolean>;
}

export interface GatewayApplication {
  readonly services: WorkspaceServices;
  readonly enrollment: EnrollmentRegistry;
  readonly socketPath: string;
  readonly viewerPort: number;
  close(): Promise<void>;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Operation aborted");
}

/** Execute a bounded child process and settle only after it has exited. */
export function executeProcess(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));

  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let spawnError: Error | null = null;
    let outputExceeded = false;
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const capture = (destination: Buffer[], value: Buffer): void => {
      outputBytes += value.length;
      if (outputBytes > PROCESS_OUTPUT_LIMIT) {
        outputExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      destination.push(Buffer.from(value));
    };
    child.stdout.on("data", (value: Buffer) => capture(stdout, value));
    child.stderr.on("data", (value: Buffer) => capture(stderr, value));
    child.once("error", (error) => { spawnError = error; });

    const onAbort = (): void => {
      if (aborted) return;
      aborted = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), ABORT_KILL_GRACE_MS);
      killTimer.unref();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    child.once("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
      if (aborted) {
        rejectProcess(signal ? abortReason(signal) : new Error("Operation aborted"));
      } else if (outputExceeded) {
        rejectProcess(new Error("Process output exceeded the safety limit"));
      } else if (spawnError) {
        rejectProcess(spawnError);
      } else {
        resolveProcess({
          code: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      }
    });
  });
}

export const podmanExec: PodmanExec = (args, signal) => executeProcess("podman", args, signal);

/** Probe Chromium's CDP endpoint; fetch cancellation is wired directly to the supervisor signal. */
export async function probeCdp(cdpUrl: string, signal?: AbortSignal): Promise<boolean> {
  const endpoint = new URL("/json/version", cdpUrl);
  const response = await fetch(endpoint, {
    method: "GET",
    redirect: "error",
    signal,
    headers: { accept: "application/json" },
  });
  await response.body?.cancel();
  return response.ok;
}

function requireOwnedDirectory(path: string, privateMode: boolean): Promise<void> {
  return lstat(path).then((metadata) => {
    if (metadata.isSymbolicLink()) throw new Error(`${path} must not be a symlink`);
    if (!metadata.isDirectory()) throw new Error(`${path} must be a directory`);
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new Error(`${path} must be owned by the gateway user`);
    }
    if (privateMode && (metadata.mode & 0o077) !== 0) {
      throw new Error(`${path} must not be accessible by group or other users`);
    }
  });
}

/** Prepare $XDG_RUNTIME_DIR/tabgoblin without following or replacing a hostile symlink. */
export async function prepareAdminSocketPath(xdgRuntimeDir: string): Promise<string> {
  if (!isAbsolute(xdgRuntimeDir)) throw new Error("XDG_RUNTIME_DIR must be absolute");
  const normalized = resolve(xdgRuntimeDir);
  await requireOwnedDirectory(normalized, true);
  if (await realpath(normalized) !== normalized) {
    throw new Error("XDG_RUNTIME_DIR must not contain symlink indirection");
  }

  const directory = join(normalized, "tabgoblin");
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error: unknown) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
  }
  await requireOwnedDirectory(directory, false);
  await chmod(directory, 0o700);
  return join(directory, "gateway.sock");
}

export function createWorkspaceServices(options: WorkspaceServiceOptions): WorkspaceServices {
  const entries = new Map<string, WorkspaceEntry>();
  const attach = options.attachBrowser ?? ((cdpUrl) => BrowserSession.attach(cdpUrl));

  const entryFor = (workspaceId: string): WorkspaceEntry => {
    let entry = entries.get(workspaceId);
    if (entry) return entry;
    entry = {
      ownership: new OwnershipController(),
      activity: new ActivityFeed(),
      browser: null,
    };
    const ownedEntry = entry;
    entry.ownership.onGenerationChange(() => ownedEntry.browser?.session?.invalidateRefs());
    entries.set(workspaceId, entry);
    return entry;
  };

  return {
    runtime: options.runtime,
    ownership: (workspaceId) => entryFor(workspaceId).ownership,
    activity: (workspaceId) => entryFor(workspaceId).activity,
    browser: async (workspaceId) => {
      if (options.runtime.state(workspaceId) !== "ready") {
        throw new Error("Browser runtime is not ready");
      }
      const endpoints = options.runtime.endpoints(workspaceId);
      if (!endpoints) throw new Error("Browser runtime endpoints are unavailable");
      const entry = entryFor(workspaceId);
      if (entry.browser?.cdpUrl === endpoints.cdpUrl) return entry.browser.promise;

      const generation = entry.ownership.snapshot().generation;
      const record: WorkspaceEntry["browser"] = {
        cdpUrl: endpoints.cdpUrl,
        session: null,
        promise: Promise.resolve(null as never),
      };
      record.promise = attach(endpoints.cdpUrl).then((session) => {
        record.session = session;
        if (entry.ownership.snapshot().generation !== generation) session.invalidateRefs();
        return session;
      }).catch((error: unknown) => {
        if (entry.browser === record) entry.browser = null;
        throw error;
      });
      entry.browser = record;
      return record.promise;
    },
    issuePairingCode: (workspaceId) => options.pairing.issue(workspaceId),
    viewerUrlFor: () => typeof options.viewerUrl === "function" ? options.viewerUrl() : options.viewerUrl,
  };
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_VIEWER_PORT;
  if (!/^\d+$/.test(value)) throw new Error("TABGOBLIN_VIEWER_PORT must be an integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("TABGOBLIN_VIEWER_PORT is outside the valid range");
  }
  return parsed;
}

function configuredOrigins(port: number): string[] {
  const loopback = `http://127.0.0.1:${port}`;
  const external = process.env.TABGOBLIN_VIEWER_ORIGIN;
  return external ? [external, loopback] : [loopback];
}

export async function runGateway(options: RunGatewayOptions = {}): Promise<GatewayApplication> {
  const xdgRuntimeDir = options.xdgRuntimeDir ?? process.env.XDG_RUNTIME_DIR;
  if (!xdgRuntimeDir) throw new Error("XDG_RUNTIME_DIR is required");
  const requestedPort = options.viewerPort ?? parsePort(process.env.TABGOBLIN_VIEWER_PORT);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error("viewerPort is outside the valid range");
  }
  const image = options.image ?? process.env.TABGOBLIN_IMAGE ?? DEFAULT_IMAGE;
  if (!image) throw new Error("A browser runtime image is required");
  const staticRoot = options.staticRoot
    ?? fileURLToPath(new URL("../../viewer/public/", import.meta.url));
  const origins = options.viewerOrigins ?? configuredOrigins(requestedPort);
  const socketPath = await prepareAdminSocketPath(xdgRuntimeDir);
  const pairing = new PairingCodes();
  const enrollment = new EnrollmentRegistry();
  const runtime = new RuntimeSupervisor({
    podman: options.podman ?? podmanExec,
    image,
    probe: options.probe ?? probeCdp,
  });
  let advertisedViewerUrl: string | null = origins.find((origin) => !origin.startsWith("http://127.0.0.1"))
    ?? origins[0]
    ?? null;
  const services = createWorkspaceServices({
    runtime,
    pairing,
    viewerUrl: () => advertisedViewerUrl,
  });
  // This non-secret process epoch makes a fresh in-memory lifecycle registry
  // distinguishable from the one a durable plugin last reconciled with.
  const admin = createAdminServer({ services, enrollment, socketPath, gatewayInstanceId: randomUUID() });
  const viewer = createViewerServer({
    services,
    pairing,
    port: requestedPort,
    staticRoot,
    allowedOrigins: origins,
  });

  try {
    await admin.listen();
    const viewerPort = await viewer.listen();
    if (
      advertisedViewerUrl === "http://127.0.0.1"
      || advertisedViewerUrl === "http://127.0.0.1:0"
    ) {
      advertisedViewerUrl = `http://127.0.0.1:${viewerPort}`;
    }
    let closePromise: Promise<void> | null = null;
    return {
      services,
      enrollment,
      socketPath,
      viewerPort,
      close: () => {
        closePromise ??= (async () => {
          // Deliberately do not call RuntimeSupervisor.stop: shutdown must preserve
          // browser containers and profile volumes for the next gateway process.
          await Promise.all([viewer.close(), admin.close()]);
        })();
        return closePromise;
      },
    };
  } catch (error: unknown) {
    await viewer.close().catch(() => undefined);
    await admin.close().catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  const application = await runGateway();
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void application.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Gateway startup failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
