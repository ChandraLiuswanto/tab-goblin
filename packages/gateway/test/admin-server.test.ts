import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityFeed } from "../src/activity-feed.js";
import { createAdminServer } from "../src/admin-server.js";
import { EnrollmentRegistry } from "../src/enrollment.js";

const NONCE = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const openServers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
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
  registry.record(enrollment, cwd);
  registry.bind(cwd, agentId, workspaceId);
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

  it("dispatches admin lifecycle, pairing, and explicit revocation operations", async () => {
    const { server, runtime, ownership, enrollment } = harness();
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
    await expect(server.handle({ op: "revoke-agent", agentId: "agent-1" })).resolves.toEqual({ ok: true });
    await expect(enrollment.authorize(NONCE)).rejects.toMatchObject({ code: "not_enrolled" });
    await expect(server.handle({ op: "revoke-workspace", workspaceId: "ws-1" })).resolves.toEqual({ ok: true });
    await expect(enrollment.authorize(SECOND)).rejects.toMatchObject({ code: "not_enrolled" });

    expect(runtime.start).toHaveBeenCalledWith("ws-1");
    expect(runtime.stop).toHaveBeenCalledWith("ws-1");
    expect(ownership.returnToAgent).toHaveBeenCalledOnce();
  });

  it("handles plugin enrollment notifications without starting a runtime", async () => {
    const { server, enrollment, runtime } = harness();
    await expect(server.handle({ op: "record-enrollment", enrollment: NONCE, cwd: "/w/one" })).resolves.toEqual({ ok: true });
    await expect(server.handle({ op: "bind-enrollment", cwd: "/w/one", agentId: "agent-1", workspaceId: "ws-1" })).resolves.toEqual({ ok: true });
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
    expect(runtime.stageFile).toHaveBeenCalledWith("ws-1", join(workspace, "inside.txt"), "inside.txt");
    expect(session.upload).toHaveBeenCalledWith("t1", "r1-e0", "/staging/inside.txt", expect.any(AbortSignal));

    const escaped = await server.handle(tool("tabgoblin_upload", { tabId: "t1", ref: "r1-e0", path: "escape.txt" }));
    expect(escaped).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(runtime.stageFile).toHaveBeenCalledTimes(1);
  });

  it("sanitizes unexpected dependency failures", async () => {
    const { server, enrollment, session } = harness();
    enroll(enrollment);
    session.listTabs.mockRejectedValueOnce(new Error("secret endpoint http://127.0.0.1:9222 and /profile"));

    const response = await server.handle(tool("tabgoblin_list_tabs"));
    expect(response).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
    expect(JSON.stringify(response)).not.toMatch(/9222|\/profile|secret endpoint/);
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
