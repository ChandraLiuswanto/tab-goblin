import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityFeed } from "../src/activity-feed.js";
import { createAdminServer } from "../src/admin-server.js";
import { EnrollmentRegistry } from "../src/enrollment.js";
import { OwnershipController } from "../src/ownership.js";

const NONCE = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const openServers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

function browser() {
  return {
    listTabs: vi.fn(async () => []),
    newTab: vi.fn(async (url: string) => ({ tabId: "t2", title: "new", url, active: true })),
    closeTab: vi.fn(async () => undefined),
    navigate: vi.fn(async (tabId: string, url: string) => ({ tabId, title: "page", url, active: true })),
    back: vi.fn(async (tabId: string) => ({ tabId, title: "back", url: "https://fixture.test/back", active: true })),
    forward: vi.fn(async (tabId: string) => ({ tabId, title: "forward", url: "https://fixture.test/forward", active: true })),
    reload: vi.fn(async (tabId: string) => ({ tabId, title: "reload", url: "https://fixture.test/reload", active: true })),
    snapshot: vi.fn(async (tabId: string) => ({ tabId, revision: 1, url: "https://fixture.test", title: "fixture", nodes: [] })),
    act: vi.fn(async () => undefined),
    text: vi.fn(async () => "sensitive page text"),
    screenshot: vi.fn(async () => ({ mimeType: "image/png" as const, base64: "c2Vuc2l0aXZl" })),
    logs: vi.fn(async () => ["sensitive console result"]),
    network: vi.fn(() => [{ method: "GET", url: "https://fixture.test/path", status: 200 }]),
    upload: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => "\"sensitive evaluation result\""),
  };
}

function harness(overrides: Record<string, unknown> = {}) {
  let generation = 2;
  let leased = false;
  const activity = new ActivityFeed();
  const release = vi.fn(() => { leased = false; });
  const abandonUncertain = vi.fn(() => { leased = false; });
  const ownership = {
    snapshot: vi.fn(() => ({ state: "agent-ready" as const, generation, owner: leased ? "agent" as const : null, ownerViewerSessionId: null })),
    acquireAgentLease: vi.fn((operationId: string) => {
      leased = true;
      return { generation, operationId, release, abandonUncertain };
    }),
    returnToAgent: vi.fn(async () => ({ state: "agent-ready", generation: ++generation, owner: null })),
  };
  const runtime = {
    state: vi.fn(() => "ready" as const),
    start: vi.fn(async () => ({ cdpUrl: "http://127.0.0.1:9222", volumeName: "secret-profile" })),
    stop: vi.fn(async () => undefined),
    stageFile: vi.fn(async (_workspaceId: string, _hostPath: string, name: string) => `/staging/${name}`),
  };
  const session = browser();
  const services = {
    runtime,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    ownership: vi.fn(() => ownership),
    activity: vi.fn(() => activity),
    browser: vi.fn(async () => session),
    issuePairingCode: vi.fn(() => ({ code: "ABCD-1234", expiresAt: "2026-09-12T00:01:00.000Z" })),
    viewerUrlFor: vi.fn(() => "https://fedora.saga-skink.ts.net/"),
    ...overrides,
  };
  const enrollment = new EnrollmentRegistry();
  const server = createAdminServer({ services: services as never, enrollment, socketPath: "/tmp/unused.sock" });
  return { server, services, enrollment, runtime, ownership, activity, session, release, abandonUncertain, setGeneration: (value: number) => { generation = value; } };
}

function enroll(registry: EnrollmentRegistry, options: { enrollment?: string; cwd?: string; agentId?: string; workspaceId?: string } = {}) {
  const enrollment = options.enrollment ?? NONCE;
  const cwd = options.cwd ?? "/w/one";
  const agentId = options.agentId ?? "agent-1";
  const workspaceId = options.workspaceId ?? "ws-1";
  registry.record(enrollment, cwd, workspaceId);
  registry.bind(enrollment, cwd, agentId, workspaceId);
  registry.noteSessionOpen(agentId, workspaceId, "interactive");
}

function tool(name: string, input: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    op: "tool",
    enrollment: NONCE,
    workspaceId: "ws-1",
    source: "agent:spoofed",
    name,
    input,
    ...overrides,
  };
}

async function post(socketPath: string, body: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { socketPath, path: "/", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

async function postWithSlowDrip(socketPath: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    let dripTimer: ReturnType<typeof setInterval> | undefined;
    const cleanup = (): void => {
      clearTimeout(safetyTimer);
      if (dripTimer) clearInterval(dripTimer);
    };
    const safetyTimer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("admin socket did not enforce its request deadline"));
    }, 750);
    socket.on("connect", () => {
      socket.write(
        `POST / HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body) + 1_024}\r\n\r\n${body}`,
      );
      dripTimer = setInterval(() => {
        if (socket.writable) socket.write(" ", () => undefined);
      }, 5);
    });
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      if (dripTimer) clearInterval(dripTimer);
    });
    socket.on("error", (error) => {
      cleanup();
      if (chunks.length > 0 && "code" in error && ["EPIPE", "ECONNRESET"].includes(error.code as string)) {
        socket.destroy();
        return;
      }
      reject(error);
    });
    socket.on("close", () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

describe("admin request handling", () => {
  it("rejects schema-invalid requests without echoing payloads", async () => {
    const { server } = harness();
    const response = await server.handle({ op: "status", secret: "do-not-echo" });

    expect(response).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(JSON.stringify(response)).not.toContain("do-not-echo");
  });

  it("returns a process-unique bounded identity on an unscoped health probe", async () => {
    const { server, services } = harness();
    const response = await server.handle({ op: "health" });
    expect(response).toMatchObject({ ok: true, protocolVersion: 1, gatewayInstanceId: expect.any(String) });
    expect(response.ok && response.gatewayInstanceId).toMatch(/^[-0-9a-f]{36}$/i);
    expect(services.browser).not.toHaveBeenCalled();
    expect(services.runtime.state).not.toHaveBeenCalled();
  });

  it("allows near-deadline cold attachment before a thirty-second navigation", async () => {
    vi.useFakeTimers();
    const session = browser();
    session.navigate.mockImplementation(async (tabId: string, url: string) =>
      new Promise((resolve) => setTimeout(
        () => resolve({ tabId, title: "delayed", url, active: true }),
        29_999,
      )),
    );
    const { server, enrollment } = harness({
      browser: vi.fn(async () => new Promise((resolve) => setTimeout(() => resolve(session), 9_999))),
    });
    enroll(enrollment);

    const pending = server.handle(tool("tabgoblin_navigate", {
      tabId: "t1",
      url: "https://example.com/delayed",
      timeoutMs: 30_000,
    }));
    await vi.advanceTimersByTimeAsync(39_998);

    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it("returns bounded status without exposing runtime endpoints or profile paths", async () => {
    const { server } = harness();
    const response = await server.handle({ op: "status", workspaceId: "ws-1" });
    const text = JSON.stringify(response);

    expect(response).toMatchObject({
      ok: true,
      status: {
        workspaceId: "ws-1",
        sessionState: "ready",
        ownership: { state: "agent-ready", generation: 2, owner: null },
        viewerUrl: "https://fedora.saga-skink.ts.net/",
      },
    });
    expect(text).not.toMatch(/9222|cdp|\/profile|user-data-dir|volumeName/i);
  });

  it("lists tabs over the trusted admin socket without an agent enrollment", async () => {
    const { server, session } = harness();
    session.listTabs.mockResolvedValueOnce([
      { tabId: "tab-1", title: "Fixture", url: "https://fixture.test/", active: true },
    ]);

    await expect(server.handle({ op: "tabs", workspaceId: "ws-1" })).resolves.toEqual({
      ok: true,
      tabs: [{ tabId: "tab-1", title: "Fixture", url: "https://fixture.test/", active: true }],
    });
    expect(session.listTabs).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it("caps trusted admin tab responses", async () => {
    const { server, session } = harness();
    session.listTabs.mockResolvedValueOnce(Array.from({ length: 120 }, (_, index) => ({
      tabId: `tab-${index}`,
      title: "Fixture",
      url: "https://fixture.test/",
      active: index === 0,
    })));

    const response = await server.handle({ op: "tabs", workspaceId: "ws-1" });
    expect(response.ok && response.tabs).toHaveLength(100);
  });

  it("fails closed without attaching to a browser when tabs are requested before runtime readiness", async () => {
    const runtime = { state: vi.fn(() => "stopped" as const), start: vi.fn(), stop: vi.fn(), stageFile: vi.fn() };
    const { server, services } = harness({ runtime });

    await expect(server.handle({ op: "tabs", workspaceId: "ws-1" })).resolves.toMatchObject({
      ok: false,
      error: { code: "session_not_ready" },
    });
    expect(services.browser).not.toHaveBeenCalled();
  });

  it("records successful and failed panel return transitions exactly once", async () => {
    const controller = new OwnershipController();
    await controller.requestTakeControl("viewer-session");
    const activity = new ActivityFeed();
    const { server } = harness({ ownership: () => controller, activity: () => activity });

    await expect(server.handle({ op: "return-to-agent", workspaceId: "ws-1" })).resolves.toMatchObject({ ok: true });
    await expect(server.handle({ op: "return-to-agent", workspaceId: "ws-1" })).resolves.toMatchObject({ ok: false, error: { code: "manual_control" } });
    expect(activity.list().map(({ action, source, status, code }) => ({ action, source, status, code }))).toEqual([
      { action: "manual-return-to-agent", source: "paseo-panel", status: "error", code: "manual_control" },
      { action: "manual-return-to-agent", source: "paseo-panel", status: "ok", code: null },
    ]);
  });

  it("dispatches admin lifecycle, pairing, and explicit revocation operations", async () => {
    const { server, services, runtime, ownership, enrollment } = harness();
    enroll(enrollment);
    enroll(enrollment, { enrollment: SECOND, agentId: "agent-2" });

    await expect(server.handle({ op: "start", workspaceId: "ws-1" })).resolves.toMatchObject({ ok: true });
    await expect(server.handle({ op: "stop", workspaceId: "ws-1" })).resolves.toEqual({ ok: true });
    await expect(server.handle({ op: "pair", workspaceId: "ws-1" })).resolves.toEqual({
      ok: true,
      pairingCode: "ABCD-1234",
      pairingExpiresAt: "2026-09-12T00:01:00.000Z",
    });
    await expect(server.handle({ op: "return-to-agent", workspaceId: "ws-1" })).resolves.toMatchObject({ ok: true });
    await expect(server.handle({ op: "revoke-agent", agentId: "agent-1" })).resolves.toEqual({ ok: true, lifecycleGeneration: 1 });
    await expect(enrollment.authorize(NONCE)).rejects.toMatchObject({ code: "not_enrolled" });
    await expect(server.handle({ op: "reset-agent", agentId: "agent-1" })).resolves.toEqual({
      ok: true,
      lifecycleGeneration: 2,
    });
    await expect(server.handle({ op: "revoke-workspace", workspaceId: "ws-1" })).resolves.toEqual({ ok: true, lifecycleGeneration: 1 });
    await expect(enrollment.authorize(SECOND)).rejects.toMatchObject({ code: "not_enrolled" });
    await expect(server.handle({ op: "reset-workspace", workspaceId: "ws-1" })).resolves.toEqual({
      ok: true,
      lifecycleGeneration: 2,
    });

    expect(services.start).toHaveBeenCalledWith("ws-1");
    expect(services.stop).toHaveBeenCalledWith("ws-1");
    expect(runtime.start).not.toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(ownership.returnToAgent).toHaveBeenCalledOnce();
  });

  it("starts through workspace lifecycle coordination without acquiring a stale browser lease", async () => {
    const { server, services, enrollment, ownership } = harness();
    enroll(enrollment);

    await expect(server.handle(tool("tabgoblin_start"))).resolves.toMatchObject({ ok: true });

    expect(services.start).toHaveBeenCalledWith("ws-1");
    expect(ownership.acquireAgentLease).not.toHaveBeenCalled();
  });

  it("handles plugin enrollment notifications without starting a runtime", async () => {
    const { server, enrollment, runtime } = harness();
    await expect(server.handle({
      op: "record-enrollment",
      enrollment: NONCE,
      cwd: "/w/one",
    })).resolves.toMatchObject({ ok: false, error: { code: "invalid_input" } });
    await expect(server.handle({
      op: "record-enrollment",
      enrollment: NONCE,
      cwd: "/w/one",
      workspaceId: "ws-1",
    })).resolves.toEqual({ ok: true });
    await expect(server.handle({
      op: "bind-enrollment",
      enrollment: SECOND,
      cwd: "/w/one",
      agentId: "agent-1",
      workspaceId: "ws-1",
    })).resolves.toMatchObject({ ok: false, error: { code: "auth_failed" } });
    await expect(server.handle({
      op: "bind-enrollment",
      enrollment: NONCE,
      cwd: "/w/one",
      agentId: "agent-1",
      workspaceId: "ws-1",
    })).resolves.toEqual({ ok: true });
    await expect(server.handle({ op: "session-open", agentId: "agent-1", workspaceId: "ws-1", purpose: "interactive" })).resolves.toEqual({ ok: true });
    await expect(server.handle({ op: "resolve-enrollment", enrollment: NONCE })).resolves.toEqual({
      ok: true,
      binding: { agentId: "agent-1", workspaceId: "ws-1" },
    });
    expect(runtime.start).not.toHaveBeenCalled();
    await expect(enrollment.authorize(NONCE)).resolves.toMatchObject({ cwd: "/w/one" });
  });
});

describe("authenticated tool dispatch", () => {
  it("uses the live credential binding as authoritative scope and source", async () => {
    const { server, enrollment, session, activity } = harness();
    enroll(enrollment);

    const mismatch = await server.handle(tool("tabgoblin_list_tabs", {}, { workspaceId: "ws-other" }));
    expect(mismatch).toMatchObject({ ok: false, error: { code: "auth_failed" } });
    expect(session.listTabs).not.toHaveBeenCalled();

    const response = await server.handle(tool("tabgoblin_list_tabs"));
    expect(response).toEqual({ ok: true, tabs: [] });
    expect(activity.list()[0]).toMatchObject({ source: "agent:agent-1", action: "tabgoblin_list_tabs" });
    expect(activity.list()[0].source).not.toContain("spoofed");
  });

  it("rejects a revoked credential even when the caller retained its old binding", async () => {
    const { server, enrollment, session } = harness();
    enroll(enrollment);
    await expect(server.handle(tool("tabgoblin_list_tabs"))).resolves.toMatchObject({ ok: true });

    await server.handle({ op: "revoke-agent", agentId: "agent-1" });
    await expect(server.handle(tool("tabgoblin_list_tabs"))).resolves.toMatchObject({
      ok: false,
      error: { code: "not_enrolled" },
    });
    expect(session.listTabs).toHaveBeenCalledTimes(1);
  });

  it("reauthorizes after awaiting browser acquisition and blocks post-revoke dispatch", async () => {
    const { server, services, enrollment, session } = harness();
    enroll(enrollment);
    let releaseBrowser!: () => void;
    const heldBrowser = new Promise<void>((resolve) => { releaseBrowser = resolve; });
    services.browser.mockImplementationOnce(async () => {
      await heldBrowser;
      return session;
    });

    const pending = server.handle(tool("tabgoblin_list_tabs"));
    await vi.waitFor(() => expect(services.browser).toHaveBeenCalledOnce());
    enrollment.revokeWorkspace("ws-1");
    releaseBrowser();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "not_enrolled" },
    });
    expect(session.listTabs).not.toHaveBeenCalled();
  });

  it("re-validates tool input before runtime, ownership, or browser access", async () => {
    const { server, enrollment, runtime, ownership, session } = harness();
    enroll(enrollment);
    const response = await server.handle(tool("tabgoblin_navigate", { tabId: "t1", url: "file:///etc/passwd" }));

    expect(response).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(runtime.state).not.toHaveBeenCalled();
    expect(ownership.acquireAgentLease).not.toHaveBeenCalled();
    expect(session.navigate).not.toHaveBeenCalled();
  });

  it("requires a ready runtime before acquiring ownership or opening a browser", async () => {
    const { server, enrollment, runtime, ownership, services } = harness();
    enroll(enrollment);
    runtime.state.mockReturnValue("stopped");

    const response = await server.handle(tool("tabgoblin_list_tabs"));

    expect(response).toMatchObject({ ok: false, error: { code: "session_not_ready" } });
    expect(ownership.acquireAgentLease).not.toHaveBeenCalled();
    expect(services.browser).not.toHaveBeenCalled();
  });

  it("checks runtime, acquires a lease, and checks generation immediately before browser action", async () => {
    const { server, enrollment, ownership, session, setGeneration, release } = harness();
    enroll(enrollment);
    ownership.acquireAgentLease.mockImplementationOnce((operationId: string) => {
      setGeneration(3);
      return { generation: 2, operationId, release, abandonUncertain: vi.fn() };
    });

    const response = await server.handle(tool("tabgoblin_navigate", { tabId: "t1", url: "https://fixture.test" }));

    expect(response).toMatchObject({ ok: false, error: { code: "stale_ref" } });
    expect(session.navigate).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith("error");
  });

  it("dispatches browser actions and keeps sensitive inputs and results out of activity", async () => {
    const { server, enrollment, session, activity } = harness();
    enroll(enrollment);

    const fill = await server.handle(tool("tabgoblin_fill", { tabId: "t1", ref: "r1-e0", value: "TOP-SECRET" }));
    const evaluated = await server.handle(tool("tabgoblin_evaluate", { tabId: "t1", expression: "'PRIVATE'" }));

    expect(fill).toEqual({ ok: true });
    expect(evaluated).toEqual({ ok: true, result: "\"sensitive evaluation result\"" });
    expect(session.act).toHaveBeenCalledWith("t1", expect.objectContaining({ kind: "fill", value: "TOP-SECRET" }), expect.any(AbortSignal));
    expect(JSON.stringify(activity.list())).not.toMatch(/TOP-SECRET|PRIVATE|sensitive evaluation result/);
  });

  it("returns only strict bounded network metadata", async () => {
    const { server, enrollment } = harness();
    enroll(enrollment);
    const response = await server.handle(tool("tabgoblin_network", { tabId: "t1", maxEntries: 1 }));

    expect(response).toEqual({ ok: true, result: [{ method: "GET", url: "https://fixture.test/path", status: 200 }] });
    expect(JSON.stringify(response)).not.toMatch(/body|headers|cookies/i);
  });

  it("realpaths uploads inside the bound cwd before staging, and rejects symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "tg-upload-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside.txt");
    await mkdir(workspace);
    await writeFile(join(workspace, "inside.txt"), "inside");
    await writeFile(outside, "outside");
    await symlink(outside, join(workspace, "escape.txt"));

    const { server, enrollment, runtime, session } = harness();
    enroll(enrollment, { cwd: workspace });

    await expect(server.handle(tool("tabgoblin_upload", { tabId: "t1", ref: "r1-e0", path: "inside.txt" }))).resolves.toEqual({ ok: true });
    const stagedHostPath = runtime.stageFile.mock.calls[0]?.[1] as string;
    expect(runtime.stageFile).toHaveBeenCalledWith("ws-1", expect.any(String), "inside.txt");
    expect(stagedHostPath).not.toBe(join(workspace, "inside.txt"));
    await expect(stat(stagedHostPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(session.upload).toHaveBeenCalledWith("t1", "r1-e0", "/staging/inside.txt", expect.any(AbortSignal));

    const escaped = await server.handle(tool("tabgoblin_upload", { tabId: "t1", ref: "r1-e0", path: "escape.txt" }));
    expect(escaped).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(runtime.stageFile).toHaveBeenCalledTimes(1);
  });

  it("reauthorizes after the upload staging gap before browser upload", async () => {
    const root = await mkdtemp(join(tmpdir(), "tg-upload-revoke-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "inside.txt"), "inside");

    const { server, enrollment, runtime, session } = harness();
    enroll(enrollment, { cwd: workspace });
    let releaseStage!: () => void;
    const heldStage = new Promise<void>((resolve) => { releaseStage = resolve; });
    let stagedHostPath = "";
    runtime.stageFile.mockImplementationOnce(async (_workspaceId, hostPath) => {
      stagedHostPath = hostPath;
      await heldStage;
      return "/staging/inside.txt";
    });

    const pending = server.handle(tool("tabgoblin_upload", {
      tabId: "t1",
      ref: "r1-e0",
      path: "inside.txt",
    }));
    await vi.waitFor(() => expect(runtime.stageFile).toHaveBeenCalledOnce());
    enrollment.revokeWorkspace("ws-1");
    releaseStage();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "not_enrolled" },
    });
    expect(session.upload).not.toHaveBeenCalled();
    await expect(stat(stagedHostPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stages uploads from a pinned private copy despite a validated parent-path swap", async () => {
    const root = await mkdtemp(join(tmpdir(), "tg-upload-race-"));
    const workspace = join(root, "workspace");
    const documents = join(workspace, "documents");
    const movedDocuments = join(workspace, "documents-original");
    const outside = join(root, "outside");
    await mkdir(documents, { recursive: true });
    await mkdir(outside);
    await writeFile(join(documents, "report.txt"), "INSIDE-SECRET");
    await writeFile(join(outside, "report.txt"), "OUTSIDE-SECRET");

    const { server, enrollment, runtime, activity } = harness();
    enroll(enrollment, { cwd: workspace });
    let stagedHostPath = "";
    let stagedContent = "";
    let stagedMode = 0;
    let stagedDirectoryMode = 0;
    runtime.stageFile.mockImplementationOnce(async (_workspaceId, hostPath, name) => {
      await rename(documents, movedDocuments);
      await symlink(outside, documents, "dir");
      stagedHostPath = hostPath;
      stagedContent = await readFile(hostPath, "utf8");
      stagedMode = (await stat(hostPath)).mode & 0o777;
      stagedDirectoryMode = (await stat(dirname(hostPath))).mode & 0o777;
      return `/staging/${name}`;
    });

    await expect(server.handle(tool("tabgoblin_upload", {
      tabId: "t1",
      ref: "r1-e0",
      path: "documents/report.txt",
    }))).resolves.toEqual({ ok: true });

    expect(stagedContent).toBe("INSIDE-SECRET");
    expect(stagedHostPath).not.toBe(join(documents, "report.txt"));
    expect(stagedMode).toBe(0o600);
    expect(stagedDirectoryMode).toBe(0o700);
    await expect(stat(stagedHostPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(activity.list())).not.toMatch(/INSIDE-SECRET|OUTSIDE-SECRET|documents/);
  });

  it("sanitizes unexpected dependency failures", async () => {
    const { server, enrollment, session } = harness();
    enroll(enrollment);
    session.listTabs.mockRejectedValueOnce(new Error("secret endpoint http://127.0.0.1:9222 and /profile"));

    const response = await server.handle(tool("tabgoblin_list_tabs"));
    expect(response).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
    expect(JSON.stringify(response)).not.toMatch(/9222|\/profile|secret endpoint/);
  });

  it("marks a mutation uncertain when lifecycle generation changes after dispatch", async () => {
    const { server, enrollment, session, abandonUncertain, setGeneration } = harness();
    enroll(enrollment);
    session.act.mockImplementationOnce(async () => { setGeneration(3); });

    const response = await server.handle(tool("tabgoblin_click", { tabId: "t1", ref: "r1-e0" }));

    expect(response).toMatchObject({
      ok: false,
      error: { code: "timeout_uncertain", retryable: false },
    });
    expect(abandonUncertain).toHaveBeenCalledOnce();
  });

  it("fails closed on handler timeout and abandons an uncertain lease", async () => {
    const { services, enrollment, abandonUncertain } = harness();
    enroll(enrollment);
    services.browser.mockImplementation(async () => ({
      ...browser(),
      listTabs: vi.fn((_signal: AbortSignal) => new Promise(() => undefined)),
    }));
    const server = createAdminServer({
      services: services as never,
      enrollment,
      socketPath: "/tmp/unused-timeout.sock",
      handlerTimeoutMs: 5,
    });

    const response = await server.handle(tool("tabgoblin_list_tabs"));
    expect(response).toMatchObject({ ok: false, error: { code: "timeout_uncertain" } });
    expect(abandonUncertain).toHaveBeenCalledOnce();
  });
});

describe("unix socket transport", () => {
  it("creates only a unix socket with 0600 permissions and removes it on close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tg-admin-"));
    const socketPath = join(directory, "gateway.sock");
    const { services, enrollment } = harness();
    const server = createAdminServer({ services: services as never, enrollment, socketPath });
    openServers.push(server);

    await server.listen();
    const details = await stat(socketPath);
    expect(details.isSocket()).toBe(true);
    expect(details.mode & 0o777).toBe(0o600);
    await server.close();
    openServers.pop();
    await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("applies one absolute deadline to a slow body and closes without dispatching or echoing it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tg-admin-slow-"));
    const socketPath = join(directory, "gateway.sock");
    const { services, enrollment, session } = harness();
    enroll(enrollment);
    const server = createAdminServer({
      services: services as never,
      enrollment,
      socketPath,
      handlerTimeoutMs: 30,
    });
    openServers.push(server);
    await server.listen();

    const requestBody = JSON.stringify(
      tool("tabgoblin_fill", { tabId: "t1", ref: "r1-e0", value: "SLOW-SECRET" }),
    );
    const rawResponse = await postWithSlowDrip(socketPath, requestBody);
    const responseBody = JSON.parse(rawResponse.slice(rawResponse.indexOf("\r\n\r\n") + 4));

    expect(rawResponse).toMatch(/^HTTP\/1\.1 400/);
    expect(responseBody).toMatchObject({ ok: false, error: { code: "timeout_uncertain" } });
    expect(rawResponse).not.toContain("SLOW-SECRET");
    expect(session.act).not.toHaveBeenCalled();
  });

  it("accepts bounded JSON and rejects malformed or over-64-KiB bodies without echoing them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tg-admin-"));
    const socketPath = join(directory, "gateway.sock");
    const { services, enrollment } = harness();
    const server = createAdminServer({ services: services as never, enrollment, socketPath });
    openServers.push(server);
    await server.listen();

    const valid = await post(socketPath, JSON.stringify({ op: "status", workspaceId: "ws-1" }));
    expect(valid).toMatchObject({ status: 200, body: { ok: true } });

    const malformed = await post(socketPath, "{TOP-SECRET");
    expect(malformed).toMatchObject({ status: 400, body: { ok: false, error: { code: "invalid_input" } } });
    expect(JSON.stringify(malformed.body)).not.toContain("TOP-SECRET");

    const oversized = await post(socketPath, JSON.stringify({ padding: "x".repeat(65_536) }));
    expect(oversized).toMatchObject({ status: 413, body: { ok: false, error: { code: "invalid_input" } } });
  });
});
