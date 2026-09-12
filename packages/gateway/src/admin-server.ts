import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, realpath, rm, stat, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import {
  AdminRequestSchema,
  AdminResponseSchema,
  NetworkDiagnosticSchema,
  PROTOCOL_VERSION,
  SessionStatusSchema,
  SnapshotSchema,
  TabGoblinErrorSchema,
  TabSchema,
  ToolInputSchemas,
  boundedText,
  tabGoblinError,
  type AdminRequest,
  type AdminResponse,
  type SessionStatus,
  type TabGoblinError,
  type ToolName,
} from "@tab-goblin/protocol";
import type { ActivityFeed } from "./activity-feed.js";
import type { BrowserAction, BrowserSession } from "./browser.js";
import type { EnrollmentRegistry, Binding } from "./enrollment.js";
import type { Lease, OwnershipController } from "./ownership.js";
import type { RuntimeSupervisor } from "./runtime.js";
import { recordManualTransition } from "./manual-activity.js";

export interface WorkspaceServices {
  runtime: RuntimeSupervisor;
  ownership(workspaceId: string): OwnershipController;
  activity(workspaceId: string): ActivityFeed;
  browser(workspaceId: string): Promise<BrowserSession>;
  issuePairingCode(workspaceId: string): { code: string; expiresAt: string };
  viewerUrlFor(workspaceId: string): string | null;
}

export interface AdminServerOptions {
  services: WorkspaceServices;
  enrollment: EnrollmentRegistry;
  socketPath: string;
  /** Test seam; production callers should use the bounded default. */
  handlerTimeoutMs?: number;
}

export interface AdminServer {
  listen(): Promise<void>;
  close(): Promise<void>;
  handle(request: unknown): Promise<AdminResponse>;
}

interface PinnedUpload {
  hostPath: string;
  name: string;
  cleanup(): Promise<void>;
}

interface RequestDeadline {
  readonly signal: AbortSignal;
  check(): void;
  remainingMs(): number;
  run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
  dispose(): void;
}

const MAX_REQUEST_BYTES = 64 * 1024;
const DEFAULT_HANDLER_TIMEOUT_MS = 20_000;

function invalidInput(): TabGoblinError {
  return tabGoblinError("invalid_input", "The admin request is invalid", false);
}

function unexpectedFailure(): TabGoblinError {
  return tabGoblinError("runtime_unavailable", "The gateway operation failed", true);
}

function timeoutFailure(): TabGoblinError {
  return tabGoblinError(
    "timeout_uncertain",
    "The operation timed out and its result is unknown; inspect state before continuing",
    false,
  );
}

const SAFE_ERROR_MESSAGES: Record<TabGoblinError["code"], string> = {
  session_not_ready: "The browser session is not ready",
  tab_not_found: "The requested browser tab was not found",
  stale_ref: "The browser reference is stale; take a fresh snapshot",
  manual_control: "The browser is under manual control",
  busy: "Another browser operation is already in progress",
  timeout_uncertain: "The operation timed out and its result is unknown",
  auth_failed: "The request is not authorized",
  runtime_unavailable: "The browser runtime is unavailable",
  invalid_input: "The request input is invalid",
  not_enrolled: "TabGoblin is not enabled for this agent's workspace",
};

function structuredError(error: unknown): TabGoblinError {
  const parsed = TabGoblinErrorSchema.safeParse(error);
  if (!parsed.success) return unexpectedFailure();
  return tabGoblinError(parsed.data.code, SAFE_ERROR_MESSAGES[parsed.data.code]);
}

function failure(error: unknown): AdminResponse {
  return { ok: false, error: structuredError(error) };
}

function tabIdFromInput(input: unknown): string | null {
  if (typeof input !== "object" || input === null || !("tabId" in input)) return null;
  return typeof input.tabId === "string" ? input.tabId : null;
}

function resultMetadata(result: AdminResponse): { url?: string; title?: string } {
  if (!result.ok || !("result" in result)) return {};
  const tab = TabSchema.safeParse(result.result);
  return tab.success ? { url: tab.data.url, title: tab.data.title } : {};
}

function generationError(): TabGoblinError {
  return tabGoblinError(
    "stale_ref",
    "Browser ownership changed; take a fresh snapshot before acting",
    false,
  );
}

function assertGeneration(ownership: OwnershipController, lease: Lease): void {
  const snapshot = ownership.snapshot();
  if (
    snapshot.generation !== lease.generation ||
    snapshot.state !== "agent-ready" ||
    snapshot.owner !== "agent"
  ) {
    throw generationError();
  }
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot !== "" &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

function sameInode(
  first: { dev: number; ino: number },
  second: { dev: number; ino: number },
): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

async function pinUpload(
  bindingCwd: string,
  requestedPath: string,
  signal: AbortSignal,
): Promise<PinnedUpload> {
  let source: Awaited<ReturnType<typeof open>> | undefined;
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  let privateDirectory: string | undefined;
  try {
    const root = await realpath(bindingCwd);
    const requested = isAbsolute(requestedPath) ? requestedPath : resolve(root, requestedPath);
    const canonicalPath = await realpath(requested);
    if (!isWithin(root, canonicalPath)) throw invalidInput();

    const beforeOpen = await stat(canonicalPath);
    if (!beforeOpen.isFile()) throw invalidInput();
    source = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await source.stat();
    if (
      !opened.isFile() ||
      !sameInode(beforeOpen, opened) ||
      !Number.isSafeInteger(opened.size) ||
      opened.size < 0
    ) {
      throw invalidInput();
    }

    // Re-resolve every parent after opening. A parent/final-component swap either
    // escapes containment or changes the path inode; the descriptor remains pinned.
    const verifiedPath = await realpath(canonicalPath);
    const afterOpen = await stat(verifiedPath);
    if (
      verifiedPath !== canonicalPath ||
      !isWithin(root, verifiedPath) ||
      !sameInode(opened, afterOpen)
    ) {
      throw invalidInput();
    }

    privateDirectory = await mkdtemp(join(tmpdir(), "tabgoblin-upload-"));
    await chmod(privateDirectory, 0o700);
    const privatePath = join(privateDirectory, "upload");
    destination = await open(
      privatePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    await destination.chmod(0o600);

    const buffer = Buffer.allocUnsafe(64 * 1024);
    let sourcePosition = 0;
    let destinationPosition = 0;
    while (sourcePosition < opened.size) {
      if (signal.aborted) throw signal.reason ?? timeoutFailure();
      const bytesRemaining = opened.size - sourcePosition;
      const { bytesRead } = await source.read(
        buffer,
        0,
        Math.min(buffer.length, bytesRemaining),
        sourcePosition,
      );
      if (bytesRead === 0) throw invalidInput();
      sourcePosition += bytesRead;
      let written = 0;
      while (written < bytesRead) {
        if (signal.aborted) throw signal.reason ?? timeoutFailure();
        const result = await destination.write(
          buffer,
          written,
          bytesRead - written,
          destinationPosition,
        );
        if (result.bytesWritten === 0) throw unexpectedFailure();
        written += result.bytesWritten;
        destinationPosition += result.bytesWritten;
      }
    }

    const afterCopy = await source.stat();
    if (
      !sameInode(opened, afterCopy) ||
      opened.size !== afterCopy.size ||
      opened.mtimeMs !== afterCopy.mtimeMs ||
      opened.ctimeMs !== afterCopy.ctimeMs
    ) {
      throw invalidInput();
    }

    await source.close();
    source = undefined;
    await destination.close();
    destination = undefined;
    const directoryToRemove = privateDirectory;
    privateDirectory = undefined;
    return {
      hostPath: privatePath,
      name: basename(canonicalPath),
      cleanup: () => rm(directoryToRemove, { recursive: true, force: true }),
    };
  } catch (error: unknown) {
    await source?.close().catch(() => undefined);
    await destination?.close().catch(() => undefined);
    if (privateDirectory) await rm(privateDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function createAdminServer(options: AdminServerOptions): AdminServer {
  const { services, enrollment, socketPath } = options;
  const handlerTimeoutMs = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
  if (!Number.isSafeInteger(handlerTimeoutMs) || handlerTimeoutMs <= 0) {
    throw new RangeError("handlerTimeoutMs must be a positive safe integer");
  }

  let server: Server | null = null;
  let listening = false;

  const statusFor = (workspaceId: string): SessionStatus => {
    const state = services.runtime.state(workspaceId);
    const ownership = services.ownership(workspaceId).snapshot();
    return SessionStatusSchema.parse({
      workspaceId,
      sessionState: state,
      ownership: {
        state: ownership.state,
        generation: ownership.generation,
        owner: ownership.owner,
      },
      startedAt: null,
      viewerUrl: state === "ready" ? services.viewerUrlFor(workspaceId) : null,
      lastError: null,
    });
  };

  const createRequestDeadline = (): RequestDeadline => {
    const controller = new AbortController();
    const expiresAt = performance.now() + handlerTimeoutMs;
    const expire = (): void => {
      if (!controller.signal.aborted) controller.abort(timeoutFailure());
    };
    const check = (): void => {
      if (performance.now() >= expiresAt) expire();
      if (controller.signal.aborted) throw controller.signal.reason;
    };
    const timer = setTimeout(expire, handlerTimeoutMs);

    return {
      signal: controller.signal,
      check,
      remainingMs: () => {
        check();
        return Math.max(0, expiresAt - performance.now());
      },
      run: async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
        check();
        let onAbort: (() => void) | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(controller.signal.reason);
          controller.signal.addEventListener("abort", onAbort, { once: true });
        });
        try {
          const pending = Promise.resolve().then(() => operation(controller.signal));
          return await Promise.race([pending, timeout]);
        } finally {
          if (onAbort) controller.signal.removeEventListener("abort", onAbort);
        }
      },
      dispose: () => clearTimeout(timer),
    };
  };

  const authorizeTool = async (request: Extract<AdminRequest, { op: "tool" }>): Promise<Binding> => {
    const binding = await enrollment.authorize(request.enrollment);
    if (binding.workspaceId !== request.workspaceId) {
      throw tabGoblinError("auth_failed", "The enrollment is not valid for this workspace", false);
    }
    return binding;
  };

  const dispatchBrowserTool = async (
    name: ToolName,
    input: Record<string, unknown>,
    workspaceId: string,
    ownership: OwnershipController,
    lease: Lease,
    bindingCwd: string,
    signal: AbortSignal,
    ensureAuthorized: () => Promise<void>,
  ): Promise<AdminResponse> => {
    assertGeneration(ownership, lease);

    if (name === "tabgoblin_start") {
      await ensureAuthorized();
      await services.runtime.start(workspaceId);
      assertGeneration(ownership, lease);
      return { ok: true, status: statusFor(workspaceId) };
    }

    if (services.runtime.state(workspaceId) !== "ready") {
      throw tabGoblinError(
        "session_not_ready",
        "The browser session is not ready; run tabgoblin_start",
        false,
      );
    }

    await ensureAuthorized();
    const browser = await services.browser(workspaceId);
    assertGeneration(ownership, lease);
    const perform = async <T>(action: () => T | Promise<T>): Promise<T> => {
      await ensureAuthorized();
      return action();
    };

    switch (name) {
      case "tabgoblin_list_tabs": {
        const tabs = TabSchema.array().max(100).parse(
          await perform(() => browser.listTabs(signal)),
        );
        return { ok: true, tabs };
      }
      case "tabgoblin_new_tab": {
        const value = input as { url: string };
        return {
          ok: true,
          result: TabSchema.parse(await perform(() => browser.newTab(value.url, signal))),
        };
      }
      case "tabgoblin_close_tab": {
        const value = input as { tabId: string };
        await perform(() => browser.closeTab(value.tabId, signal));
        return { ok: true };
      }
      case "tabgoblin_navigate": {
        const value = input as { tabId: string; url: string; timeoutMs: number };
        return {
          ok: true,
          result: TabSchema.parse(
            await perform(() => browser.navigate(value.tabId, value.url, value.timeoutMs, signal)),
          ),
        };
      }
      case "tabgoblin_back": {
        const value = input as { tabId: string; timeoutMs: number };
        return {
          ok: true,
          result: TabSchema.parse(
            await perform(() => browser.back(value.tabId, value.timeoutMs, signal)),
          ),
        };
      }
      case "tabgoblin_forward": {
        const value = input as { tabId: string; timeoutMs: number };
        return {
          ok: true,
          result: TabSchema.parse(
            await perform(() => browser.forward(value.tabId, value.timeoutMs, signal)),
          ),
        };
      }
      case "tabgoblin_reload": {
        const value = input as { tabId: string; timeoutMs: number };
        return {
          ok: true,
          result: TabSchema.parse(
            await perform(() => browser.reload(value.tabId, value.timeoutMs, signal)),
          ),
        };
      }
      case "tabgoblin_snapshot": {
        const value = input as { tabId: string };
        return {
          ok: true,
          snapshot: SnapshotSchema.parse(await perform(() => browser.snapshot(value.tabId, signal))),
        };
      }
      case "tabgoblin_click": {
        const value = input as { tabId: string; ref: string; timeoutMs: number };
        await perform(() =>
          browser.act(value.tabId, { kind: "click", ref: value.ref, timeoutMs: value.timeoutMs }, signal),
        );
        return { ok: true };
      }
      case "tabgoblin_fill": {
        const value = input as { tabId: string; ref: string; value: string; timeoutMs: number };
        await perform(() =>
          browser.act(
            value.tabId,
            { kind: "fill", ref: value.ref, value: value.value, timeoutMs: value.timeoutMs },
            signal,
          ),
        );
        return { ok: true };
      }
      case "tabgoblin_type": {
        const value = input as { tabId: string; ref: string; text: string; timeoutMs: number };
        await perform(() =>
          browser.act(
            value.tabId,
            { kind: "type", ref: value.ref, text: value.text, timeoutMs: value.timeoutMs },
            signal,
          ),
        );
        return { ok: true };
      }
      case "tabgoblin_keypress": {
        const value = input as { tabId: string; key: string; timeoutMs: number };
        await perform(() =>
          browser.act(
            value.tabId,
            { kind: "keypress", key: value.key, timeoutMs: value.timeoutMs },
            signal,
          ),
        );
        return { ok: true };
      }
      case "tabgoblin_select": {
        const value = input as { tabId: string; ref: string; values: string[]; timeoutMs: number };
        await perform(() =>
          browser.act(
            value.tabId,
            { kind: "select", ref: value.ref, values: value.values, timeoutMs: value.timeoutMs },
            signal,
          ),
        );
        return { ok: true };
      }
      case "tabgoblin_hover": {
        const value = input as { tabId: string; ref: string; timeoutMs: number };
        await perform(() =>
          browser.act(value.tabId, { kind: "hover", ref: value.ref, timeoutMs: value.timeoutMs }, signal),
        );
        return { ok: true };
      }
      case "tabgoblin_scroll": {
        const value = input as { tabId: string; dx: number; dy: number };
        await perform(() =>
          browser.act(value.tabId, { kind: "scroll", dx: value.dx, dy: value.dy }, signal),
        );
        return { ok: true };
      }
      case "tabgoblin_drag": {
        const value = input as { tabId: string; fromRef: string; toRef: string; timeoutMs: number };
        await perform(() =>
          browser.act(
            value.tabId,
            {
              kind: "drag",
              fromRef: value.fromRef,
              toRef: value.toRef,
              timeoutMs: value.timeoutMs,
            },
            signal,
          ),
        );
        return { ok: true };
      }
      case "tabgoblin_wait": {
        const value = input as { tabId: string; condition: "load" | "text"; text?: string; timeoutMs: number };
        const action: BrowserAction = {
          kind: "wait",
          condition: value.condition,
          ...(value.text === undefined ? {} : { text: value.text }),
          timeoutMs: value.timeoutMs,
        };
        await perform(() => browser.act(value.tabId, action, signal));
        return { ok: true };
      }
      case "tabgoblin_text": {
        const value = input as { tabId: string; maxChars: number };
        return {
          ok: true,
          result: await perform(() => browser.text(value.tabId, value.maxChars, signal)),
        };
      }
      case "tabgoblin_screenshot": {
        const value = input as { tabId: string; fullPage: boolean };
        return {
          ok: true,
          result: await perform(() => browser.screenshot(value.tabId, value.fullPage, signal)),
        };
      }
      case "tabgoblin_logs": {
        const value = input as { tabId: string; maxEntries: number };
        return {
          ok: true,
          result: await perform(() => browser.logs(value.tabId, value.maxEntries)),
        };
      }
      case "tabgoblin_network": {
        const value = input as { tabId: string; maxEntries: number };
        const entries = NetworkDiagnosticSchema.array().max(value.maxEntries).parse(
          await perform(() => browser.network(value.tabId, value.maxEntries)),
        );
        return { ok: true, result: entries };
      }
      case "tabgoblin_upload": {
        const value = input as { tabId: string; ref: string; path: string };
        let pinned: PinnedUpload;
        try {
          pinned = await pinUpload(bindingCwd, value.path, signal);
        } catch (error: unknown) {
          if (TabGoblinErrorSchema.safeParse(error).success) throw error;
          throw tabGoblinError(
            "invalid_input",
            "Uploads must resolve to a stable file inside the workspace",
            false,
          );
        }
        try {
          if (pinned.name.includes("\\") || pinned.name.includes("\0")) {
            throw tabGoblinError("invalid_input", "The upload filename is invalid", false);
          }
          await ensureAuthorized();
          const staged = await services.runtime.stageFile(
            workspaceId,
            pinned.hostPath,
            pinned.name,
          );
          await perform(() => browser.upload(value.tabId, value.ref, staged, signal));
          return { ok: true };
        } finally {
          await pinned.cleanup();
        }
      }
      case "tabgoblin_evaluate": {
        const value = input as { tabId: string; expression: string; maxChars: number };
        return {
          ok: true,
          result: await perform(() =>
            browser.evaluate(value.tabId, value.expression, value.maxChars, signal),
          ),
        };
      }
      case "tabgoblin_status":
        throw unexpectedFailure();
    }
  };

  const executeTool = async (
    request: Extract<AdminRequest, { op: "tool" }>,
    deadline: RequestDeadline,
  ): Promise<AdminResponse> => {
    const schema = ToolInputSchemas[request.name];
    const parsedInput = schema.safeParse(request.input ?? {});
    if (!parsedInput.success) return failure(invalidInput());
    const input = parsedInput.data as Record<string, unknown>;

    let binding: Binding;
    try {
      binding = await deadline.run(() => authorizeTool(request));
    } catch (error: unknown) {
      return failure(error);
    }

    if (request.name === "tabgoblin_status") {
      try {
        deadline.check();
        return AdminResponseSchema.parse({ ok: true, status: statusFor(binding.workspaceId!) });
      } catch (error: unknown) {
        return failure(error);
      }
    }

    try {
      deadline.check();
    } catch (error: unknown) {
      return failure(error);
    }

    if (
      request.name !== "tabgoblin_start" &&
      services.runtime.state(binding.workspaceId!) !== "ready"
    ) {
      return failure(
        tabGoblinError(
          "session_not_ready",
          "The browser session is not ready; run tabgoblin_start",
          false,
        ),
      );
    }

    const ownership = services.ownership(binding.workspaceId!);
    const feed = services.activity(binding.workspaceId!);
    const operationId = randomUUID();
    let lease: Lease | null = null;
    try {
      deadline.check();
      lease = ownership.acquireAgentLease(operationId);
      feed.begin({
        operationId,
        source: boundedText(`agent:${binding.agentId ?? "unknown"}`, 80),
        tabId: tabIdFromInput(input),
        action: request.name,
      });

      const ensureAuthorized = async (): Promise<void> => {
        deadline.check();
        const current = await enrollment.authorize(request.enrollment);
        deadline.check();
        if (
          current.cwd !== binding.cwd ||
          current.agentId !== binding.agentId ||
          current.workspaceId !== binding.workspaceId ||
          current.agentGeneration !== binding.agentGeneration ||
          current.workspaceGeneration !== binding.workspaceGeneration
        ) {
          throw tabGoblinError("auth_failed", "The enrollment binding changed", false);
        }
        assertGeneration(ownership, lease!);
      };

      const response = await deadline.run((signal) =>
        dispatchBrowserTool(
          request.name,
          input,
          binding.workspaceId!,
          ownership,
          lease!,
          binding.cwd,
          signal,
          ensureAuthorized,
        ),
      );
      const checked = AdminResponseSchema.parse(response);
      lease.release("ok");
      const metadata = resultMetadata(checked);
      feed.finish(operationId, { status: "ok", ...metadata });
      return checked;
    } catch (error: unknown) {
      const safe = structuredError(error);
      if (lease) {
        if (safe.code === "timeout_uncertain") lease.abandonUncertain();
        else lease.release("error");
      }
      feed.finish(operationId, { status: "error", code: safe.code });
      return { ok: false, error: safe };
    }
  };

  const dispatchAdmin = async (
    request: AdminRequest,
    deadline: RequestDeadline,
  ): Promise<AdminResponse> => {
    switch (request.op) {
      case "health":
        return { ok: true, protocolVersion: PROTOCOL_VERSION };
      case "status":
        return { ok: true, status: statusFor(request.workspaceId) };
      case "tabs": {
        if (services.runtime.state(request.workspaceId) !== "ready") {
          throw tabGoblinError("session_not_ready", "The browser session is not ready", false);
        }
        deadline.check();
        const browser = await services.browser(request.workspaceId);
        deadline.check();
        const tabs = await browser.listTabs(deadline.signal);
        return { ok: true, tabs: TabSchema.array().max(100).parse(tabs.slice(0, 100)) };
      }
      case "start":
        await services.runtime.start(request.workspaceId);
        return { ok: true, status: statusFor(request.workspaceId) };
      case "stop":
        await services.runtime.stop(request.workspaceId);
        return { ok: true };
      case "activity":
        return { ok: true, activity: services.activity(request.workspaceId).list() };
      case "pair": {
        const pair = services.issuePairingCode(request.workspaceId);
        return { ok: true, pairingCode: pair.code, pairingExpiresAt: pair.expiresAt };
      }
      case "return-to-agent":
        await recordManualTransition(
          services.activity(request.workspaceId),
          "manual-return-to-agent",
          "paseo-panel",
          () => services.ownership(request.workspaceId).returnToAgent(),
        );
        return { ok: true, status: statusFor(request.workspaceId) };
      case "record-enrollment":
        enrollment.record(
          request.enrollment,
          request.cwd,
          request.workspaceId,
          request.workspaceGeneration,
        );
        return { ok: true };
      case "resolve-enrollment": {
        const binding = await enrollment.resolve(
          request.enrollment,
          Math.max(0, deadline.remainingMs() - POLL_COMPLETION_MARGIN_MS),
        );
        return {
          ok: true,
          binding: { agentId: binding.agentId!, workspaceId: binding.workspaceId! },
        };
      }
      case "bind-enrollment":
        enrollment.bind(request.cwd, request.agentId, request.workspaceId, {
          agentGeneration: request.agentGeneration,
          workspaceGeneration: request.workspaceGeneration,
        });
        return { ok: true };
      case "session-open":
        enrollment.noteSessionOpen(request.agentId, request.workspaceId, request.purpose, {
          agentGeneration: request.agentGeneration,
          workspaceGeneration: request.workspaceGeneration,
        });
        return { ok: true };
      case "revoke-agent":
        return { ok: true, lifecycleGeneration: enrollment.revokeAgent(request.agentId) };
      case "revoke-workspace":
        return { ok: true, lifecycleGeneration: enrollment.revokeWorkspace(request.workspaceId) };
      case "reset-agent":
        return { ok: true, lifecycleGeneration: enrollment.resetAgent(request.agentId) };
      case "reset-workspace":
        return {
          ok: true,
          lifecycleGeneration: enrollment.resetWorkspace(request.workspaceId),
        };
      case "tool":
        return executeTool(request, deadline);
    }
  };

  const handleWithDeadline = async (
    unknownRequest: unknown,
    deadline: RequestDeadline,
  ): Promise<AdminResponse> => {
    const parsed = AdminRequestSchema.safeParse(unknownRequest);
    if (!parsed.success) return failure(invalidInput());
    if (parsed.data.op === "tool") return executeTool(parsed.data, deadline);

    try {
      const response = await deadline.run(() => dispatchAdmin(parsed.data, deadline));
      return AdminResponseSchema.parse(response);
    } catch (error: unknown) {
      return failure(error);
    }
  };

  const handle = async (unknownRequest: unknown): Promise<AdminResponse> => {
    const deadline = createRequestDeadline();
    try {
      return await handleWithDeadline(unknownRequest, deadline);
    } finally {
      deadline.dispose();
    }
  };

  const writeJson = (response: ServerResponse, statusCode: number, body: AdminResponse): void => {
    const json = JSON.stringify(body);
    response.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(json),
      "cache-control": "no-store",
    });
    response.end(json);
  };

  const readBody = (request: IncomingMessage, signal: AbortSignal): Promise<unknown> =>
    new Promise((resolveBody, rejectBody) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;

      const cleanup = (): void => {
        request.off("data", onData);
        request.off("end", onEnd);
        request.off("error", onError);
        request.off("aborted", onRequestAborted);
        signal.removeEventListener("abort", onDeadline);
      };
      const reject = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        request.pause();
        rejectBody(error);
      };
      const onData = (chunk: Buffer | string): void => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_REQUEST_BYTES) {
          reject(REQUEST_TOO_LARGE);
          return;
        }
        chunks.push(bytes);
      };
      const onEnd = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          rejectBody(invalidInput());
        }
      };
      const onError = (error: Error): void => reject(error);
      const onRequestAborted = (): void => reject(invalidInput());
      const onDeadline = (): void => reject(signal.reason ?? timeoutFailure());

      const length = request.headers["content-length"];
      if (typeof length === "string" && Number(length) > MAX_REQUEST_BYTES) {
        reject(REQUEST_TOO_LARGE);
        return;
      }
      if (signal.aborted) {
        onDeadline();
        return;
      }
      request.on("data", onData);
      request.once("end", onEnd);
      request.once("error", onError);
      request.once("aborted", onRequestAborted);
      signal.addEventListener("abort", onDeadline, { once: true });
    });

  const listen = async (): Promise<void> => {
    if (listening) return;
    try {
      const existing = await lstat(socketPath);
      if (!existing.isSocket()) {
        throw new Error("Refusing to replace a non-socket admin path");
      }
      await unlink(socketPath);
    } catch (error: unknown) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }

    const created = createServer((request, response) => {
      const deadline = createRequestDeadline();
      void (async () => {
        try {
          if (request.method !== "POST" || request.url !== "/") {
            request.resume();
            writeJson(response, 404, failure(invalidInput()));
            return;
          }

          const body = await readBody(request, deadline.signal);
          deadline.check();
          const result = await handleWithDeadline(body, deadline);
          writeJson(response, result.ok ? 200 : 400, result);
        } catch (error: unknown) {
          const tooLarge = error === REQUEST_TOO_LARGE;
          const safe = structuredError(tooLarge ? invalidInput() : error);
          const terminateInput = tooLarge || safe.code === "timeout_uncertain";
          if (terminateInput) {
            request.pause();
            response.shouldKeepAlive = false;
            response.setHeader("connection", "close");
            response.once("finish", () => request.socket.end());
          }
          writeJson(response, tooLarge ? 413 : 400, { ok: false, error: safe });
        } finally {
          deadline.dispose();
        }
      })().catch(() => {
        deadline.dispose();
        if (!response.headersSent) writeJson(response, 500, failure(unexpectedFailure()));
        else response.end();
      });
    });
    server = created;

    try {
      await new Promise<void>((resolveListen, reject) => {
        const onError = (error: Error) => {
          created.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          created.off("error", onError);
          resolveListen();
        };
        created.once("error", onError);
        created.once("listening", onListening);
        created.listen(socketPath);
      });
      await chmod(socketPath, 0o600);
      listening = true;
    } catch (error: unknown) {
      await new Promise<void>((resolveClose) => created.close(() => resolveClose()));
      server = null;
      await unlink(socketPath).catch(() => undefined);
      throw error;
    }
  };

  const close = async (): Promise<void> => {
    const active = server;
    server = null;
    listening = false;
    if (active) {
      await new Promise<void>((resolveClose, reject) => {
        active.close((error) => (error ? reject(error) : resolveClose()));
      }).catch(() => undefined);
    }
    try {
      const existing = await lstat(socketPath);
      if (existing.isSocket()) await unlink(socketPath);
    } catch (error: unknown) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  };

  return { listen, close, handle };
}

const REQUEST_TOO_LARGE = Symbol("request-too-large");
const POLL_COMPLETION_MARGIN_MS = 25;
