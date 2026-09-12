import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { chmod, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { CSRF_HEADER, VIEWER_COOKIE, ViewerStatusSchema } from "@tab-goblin/protocol";
import { ActivityFeed } from "../src/activity-feed.js";
import { OwnershipController } from "../src/ownership.js";
import { PairingCodes } from "../src/pairing.js";
import {
  createWorkspaceServices,
  executeProcess,
  prepareAdminSocketPath,
  probeCdp,
  runGateway,
} from "../src/main.js";
import { createViewerServer } from "../src/viewer-server.js";

interface Paired {
  cookie: string;
  csrfToken: string;
  workspaceId: string;
}

let staticRoot: string;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  staticRoot = await mkdtemp(join(tmpdir(), "tg-viewer-static-"));
  await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>viewer fixture</title>");
  await writeFile(join(staticRoot, "viewer.js"), "console.log('fixture')");
});

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
  await rm(staticRoot, { recursive: true, force: true });
});

function harness(options: {
  now?: () => number;
  vncPort?: number;
  sessionTtlMs?: number;
  maxViewerSocketsPerWorkspace?: number;
} = {}) {
  const pairing = new PairingCodes({ now: options.now });
  const ownerships = new Map<string, OwnershipController>();
  const ownership = (workspaceId: string) => {
    let value = ownerships.get(workspaceId);
    if (!value) {
      value = new OwnershipController();
      ownerships.set(workspaceId, value);
    }
    return value;
  };
  const services = {
    runtime: {
      state: vi.fn(() => "ready" as const),
      endpoints: vi.fn((workspaceId: string) => workspaceId === "stopped" ? null : ({
        containerName: "runtime",
        volumeName: "profile",
        cdpUrl: "http://127.0.0.1:9222",
        vncHost: "127.0.0.1",
        vncPort: options.vncPort ?? 9,
      })),
    },
    ownership,
    activity: vi.fn(() => new ActivityFeed()),
    browser: vi.fn(),
    issuePairingCode: vi.fn(),
    viewerUrlFor: vi.fn((workspaceId: string) => `https://viewer.example/${workspaceId}`),
  };
  const server = createViewerServer({
    services: services as never,
    pairing,
    port: 0,
    staticRoot,
    allowedOrigins: ["http://127.0.0.1", "https://viewer.example"],
    now: options.now,
    sessionTtlMs: options.sessionTtlMs,
    maxViewerSocketsPerWorkspace: options.maxViewerSocketsPerWorkspace,
  });
  cleanups.push(() => server.close());
  return { server, pairing, ownership, services };
}

async function start(h: ReturnType<typeof harness>): Promise<{ base: string; origin: string; port: number }> {
  const port = await h.server.listen();
  const origin = `http://127.0.0.1:${port}`;
  return { base: origin, origin, port };
}

async function pair(
  h: ReturnType<typeof harness>,
  address: Awaited<ReturnType<typeof start>>,
  workspaceId = "ws-1",
): Promise<Paired> {
  const issued = h.pairing.issue(workspaceId);
  const response = await fetch(`${address.base}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: address.origin },
    body: JSON.stringify({ code: issued.code }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { csrfToken: string; workspaceId: string };
  return {
    cookie: response.headers.get("set-cookie")!.split(";", 1)[0]!,
    csrfToken: body.csrfToken,
    workspaceId: body.workspaceId,
  };
}

function authenticatedHeaders(session: Paired, origin?: string): Record<string, string> {
  return {
    cookie: session.cookie,
    [CSRF_HEADER]: session.csrfToken,
    ...(origin ? { origin } : {}),
    "content-type": "application/json",
  };
}

function openWebSocket(url: string, session: Paired, origin: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie: session.cookie, origin } });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fakeVnc(): Promise<{ server: TcpServer; port: number; received: Buffer[]; sockets: Socket[] }> {
  const received: Buffer[] = [];
  const sockets: Socket[] = [];
  const server = createTcpServer((socket) => {
    sockets.push(socket);
    socket.write("RFB 003.008\n");
    let phase = 0;
    socket.on("data", (chunk) => {
      received.push(Buffer.from(chunk));
      const all = Buffer.concat(received);
      if (phase === 0 && all.includes(Buffer.from("RFB 003.008\n"))) {
        phase = 1;
        socket.write(Buffer.from([1, 1]));
      } else if (phase === 1 && chunk.includes(1)) {
        phase = 2;
        socket.write(Buffer.alloc(4));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing VNC address");
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { server, port: address.port, received, sockets };
}

async function completeWebSocketHandshake(socket: WebSocket): Promise<void> {
  const messages: Buffer[] = [];
  socket.on("message", (data) => messages.push(Buffer.from(data as Buffer)));
  await waitFor(() => Buffer.concat(messages).includes(Buffer.from("RFB 003.008\n")), "missing server version");
  socket.send(Buffer.from("RFB 003.008\n"));
  await waitFor(() => Buffer.concat(messages).includes(Buffer.from([1, 1])), "missing security types");
  socket.send(Buffer.from([1]));
  await waitFor(() => Buffer.concat(messages).length >= 18, "missing security result");
  socket.send(Buffer.from([1]));
}

describe("viewer HTTP authentication", () => {
  it("serves only fixed static assets with browser hardening headers", async () => {
    const h = harness();
    const address = await start(h);
    const response = await fetch(`${address.base}/`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("viewer fixture");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'self'; connect-src 'self'");
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect((await fetch(`${address.base}/..%2fpackage.json`)).status).toBe(404);
  });

  it("exchanges a valid one-use code for a strict bounded cookie without echoing the code", async () => {
    const h = harness();
    const address = await start(h);
    const issued = h.pairing.issue("ws-1");
    const response = await fetch(`${address.base}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: address.origin },
      body: JSON.stringify({ code: issued.code }),
    });
    const responseText = await response.text();
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(200);
    expect(`${responseText}${cookie}`).not.toContain(issued.code);
    expect(cookie).toContain(`${VIEWER_COOKIE}=`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Max-Age=43200/i);

    const reused = await fetch(`${address.base}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: address.origin },
      body: JSON.stringify({ code: issued.code }),
    });
    expect(reused.status).toBe(401);
    expect(reused.headers.get("set-cookie")).toBeNull();
  });

  it("strictly rejects missing or foreign Origin, mismatched Host, oversized JSON, and detailed auth errors", async () => {
    const h = harness();
    const address = await start(h);
    const calls = [
      fetch(`${address.base}/api/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      fetch(`${address.base}/api/pair`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" }),
      fetch(`${address.base}/api/pair`, { method: "POST", headers: { "content-type": "application/json", origin: "https://viewer.example" }, body: "{}" }),
      fetch(`${address.base}/api/pair`, { method: "POST", headers: { "content-type": "application/json", origin: address.origin }, body: JSON.stringify({ code: "A".repeat(70_000) }) }),
    ];
    const responses = await Promise.all(calls);
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 413]);
    for (const response of responses) expect(await response.text()).not.toMatch(/origin|csrf|code|cookie/i);
  });

  it("expires short-lived sessions", async () => {
    let now = 1_000;
    const h = harness({ now: () => now, sessionTtlMs: 50 });
    const address = await start(h);
    const session = await pair(h, address);
    now += 51;

    const response = await fetch(`${address.base}/api/status`, {
      headers: authenticatedHeaders(session),
    });
    expect(response.status).toBe(403);
  });

  it("requires session and CSRF on status and every state-changing action", async () => {
    const h = harness();
    const address = await start(h);
    const session = await pair(h, address);
    for (const [method, path] of [
      ["GET", "/api/status"],
      ["POST", "/api/take-control"],
      ["POST", "/api/return-to-agent"],
      ["POST", "/api/reclaim"],
      ["POST", "/api/sign-out"],
    ]) {
      const response = await fetch(address.base + path, {
        method,
        headers: { cookie: session.cookie, origin: address.origin, "content-type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(response.status, path).toBe(403);
    }
  });

  it("returns ViewerStatusSchema with session-specific isOwner", async () => {
    const h = harness();
    const address = await start(h);
    const first = await pair(h, address);
    const second = await pair(h, address);
    const takeover = await fetch(`${address.base}/api/take-control`, {
      method: "POST",
      headers: authenticatedHeaders(first, address.origin),
      body: "{}",
    });
    expect(takeover.status).toBe(200);

    const statuses = await Promise.all([first, second].map(async (session) => {
      const response = await fetch(`${address.base}/api/status`, {
        headers: authenticatedHeaders(session),
      });
      expect(response.status).toBe(200);
      return ViewerStatusSchema.parse(await response.json());
    }));
    expect(statuses.map((status) => status.isOwner)).toEqual([true, false]);
    expect(statuses[0]!.ownership.owner).toBe("viewer");
  });

  it("requires explicit reclaim confirmation and invalidates a signed-out session", async () => {
    const h = harness();
    const address = await start(h);
    const first = await pair(h, address);
    const second = await pair(h, address);
    await fetch(`${address.base}/api/take-control`, { method: "POST", headers: authenticatedHeaders(first, address.origin), body: "{}" });

    const denied = await fetch(`${address.base}/api/reclaim`, { method: "POST", headers: authenticatedHeaders(second, address.origin), body: "{}" });
    expect(denied.status).toBe(400);
    const reclaimed = await fetch(`${address.base}/api/reclaim`, { method: "POST", headers: authenticatedHeaders(second, address.origin), body: JSON.stringify({ confirm: true }) });
    expect(reclaimed.status).toBe(200);

    const signOut = await fetch(`${address.base}/api/sign-out`, { method: "POST", headers: authenticatedHeaders(second, address.origin), body: "{}" });
    expect(signOut.status).toBe(200);
    expect(signOut.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
    const stale = await fetch(`${address.base}/api/status`, { headers: authenticatedHeaders(second) });
    expect(stale.status).toBe(403);
  });
});

describe("viewer WebSocket input gate", () => {
  it("rejects unauthenticated, cross-origin, and cross-workspace upgrades", async () => {
    const vnc = await fakeVnc();
    const h = harness({ vncPort: vnc.port });
    const address = await start(h);
    const session = await pair(h, address);

    const attempts = [
      new WebSocket(`ws://127.0.0.1:${address.port}/ws/vnc`, { headers: { origin: address.origin } }),
      new WebSocket(`ws://127.0.0.1:${address.port}/ws/vnc`, { headers: { origin: "https://evil.example", cookie: session.cookie } }),
      new WebSocket(`ws://127.0.0.1:${address.port}/ws/vnc?workspaceId=ws-2`, { headers: { origin: address.origin, cookie: session.cookie } }),
    ];
    const statuses = await Promise.all(attempts.map((socket) => new Promise<number>((resolve) => {
      socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      socket.once("error", () => resolve(0));
    })));
    expect(statuses).toEqual([401, 403, 403]);
  });

  it("bounds concurrent sockets per workspace", async () => {
    const vnc = await fakeVnc();
    const h = harness({ vncPort: vnc.port, maxViewerSocketsPerWorkspace: 2 });
    const address = await start(h);
    const session = await pair(h, address);
    const first = await openWebSocket(`ws://127.0.0.1:${address.port}/ws/vnc`, session, address.origin);
    const second = await openWebSocket(`ws://127.0.0.1:${address.port}/ws/vnc`, session, address.origin);
    const third = new WebSocket(`ws://127.0.0.1:${address.port}/ws/vnc`, {
      headers: { cookie: session.cookie, origin: address.origin },
    });
    const status = await new Promise<number>((resolve) => {
      third.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      third.once("error", () => resolve(0));
    });
    expect(status).toBe(429);
    first.close();
    second.close();
  });

  it("closes established workspace sockets when the viewer signs out", async () => {
    const vnc = await fakeVnc();
    const h = harness({ vncPort: vnc.port });
    const address = await start(h);
    const session = await pair(h, address);
    const socket = await openWebSocket(`ws://127.0.0.1:${address.port}/ws/vnc`, session, address.origin);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

    const response = await fetch(`${address.base}/api/sign-out`, {
      method: "POST",
      headers: authenticatedHeaders(session, address.origin),
      body: "{}",
    });
    expect(response.status).toBe(200);
    await closed;
  });

  it("expires an already-established WebSocket session", async () => {
    const vnc = await fakeVnc();
    const h = harness({ vncPort: vnc.port, sessionTtlMs: 40 });
    const address = await start(h);
    const session = await pair(h, address);
    const socket = await openWebSocket(`ws://127.0.0.1:${address.port}/ws/vnc`, session, address.origin);
    const closeCode = await new Promise<number>((resolve) => socket.once("close", resolve));
    expect(closeCode).toBe(1008);
  });

  it("closes the tunnel on an unsupported client message", async () => {
    const vnc = await fakeVnc();
    const h = harness({ vncPort: vnc.port });
    const address = await start(h);
    const session = await pair(h, address);
    const socket = await openWebSocket(`ws://127.0.0.1:${address.port}/ws/vnc`, session, address.origin);
    await completeWebSocketHandshake(socket);
    socket.send(Buffer.from([7]));
    const closeCode = await new Promise<number>((resolve) => socket.once("close", resolve));
    expect(closeCode).toBe(1008);
  });

  it("keeps the handshake functional, gates input, and forwards framebuffer traffic", async () => {
    const vnc = await fakeVnc();
    const h = harness({ vncPort: vnc.port });
    const address = await start(h);
    const session = await pair(h, address);
    const socket = await openWebSocket(`ws://127.0.0.1:${address.port}/ws/vnc`, session, address.origin);
    await completeWebSocketHandshake(socket);
    await waitFor(() => Buffer.concat(vnc.received).length >= 14, "missing client init");
    const baseline = Buffer.concat(vnc.received).length;

    const update = Buffer.alloc(10); update[0] = 3;
    const key = Buffer.alloc(8); key[0] = 4; key[1] = 1; key.writeUInt32BE(0x41, 4);
    socket.send(Buffer.concat([update, key]));
    await waitFor(() => Buffer.concat(vnc.received).length >= baseline + update.length, "missing framebuffer request");
    expect(Buffer.concat(vnc.received).subarray(baseline)).toEqual(update);

    await fetch(`${address.base}/api/take-control`, { method: "POST", headers: authenticatedHeaders(session, address.origin), body: "{}" });
    socket.send(key);
    await waitFor(() => Buffer.concat(vnc.received).length >= baseline + update.length + key.length, "missing owner key");
    expect(Buffer.concat(vnc.received).subarray(-key.length)).toEqual(key);
  });

  it("synthesizes key and button releases before returning or reclaiming ownership", async () => {
    const vnc = await fakeVnc();
    const h = harness({ vncPort: vnc.port });
    const address = await start(h);
    const first = await pair(h, address);
    const second = await pair(h, address);
    const socket = await openWebSocket(`ws://127.0.0.1:${address.port}/ws/vnc`, first, address.origin);
    await completeWebSocketHandshake(socket);
    await waitFor(() => Buffer.concat(vnc.received).length >= 14, "missing client init");
    await fetch(`${address.base}/api/take-control`, { method: "POST", headers: authenticatedHeaders(first, address.origin), body: "{}" });

    const keyDown = Buffer.alloc(8); keyDown[0] = 4; keyDown[1] = 1; keyDown.writeUInt32BE(0xffe3, 4);
    const pointerDown = Buffer.from([5, 1, 0, 10, 0, 20]);
    socket.send(Buffer.concat([keyDown, pointerDown]));
    await waitFor(() => Buffer.concat(vnc.received).includes(pointerDown), "missing pressed input");

    const reclaimed = await fetch(`${address.base}/api/reclaim`, { method: "POST", headers: authenticatedHeaders(second, address.origin), body: JSON.stringify({ confirm: true }) });
    expect(reclaimed.status).toBe(200);
    const releaseTail = Buffer.concat(vnc.received).subarray(-14);
    expect(releaseTail).toEqual(Buffer.concat([Buffer.from([4, 0, 0, 0, 0, 0, 0xff, 0xe3]), Buffer.from([5, 0, 0, 10, 0, 20])]));
    expect(h.ownership("ws-1").snapshot().ownerViewerSessionId).not.toBeNull();

    const returned = await fetch(`${address.base}/api/return-to-agent`, { method: "POST", headers: authenticatedHeaders(second, address.origin), body: "{}" });
    expect(returned.status).toBe(200);
    expect(h.ownership("ws-1").snapshot()).toMatchObject({ state: "agent-ready", generation: 1, owner: null });
  });

  it("releases pressed input on disconnect without silently returning control", async () => {
    const vnc = await fakeVnc();
    const h = harness({ vncPort: vnc.port });
    const address = await start(h);
    const session = await pair(h, address);
    const socket = await openWebSocket(`ws://127.0.0.1:${address.port}/ws/vnc`, session, address.origin);
    await completeWebSocketHandshake(socket);
    await waitFor(() => Buffer.concat(vnc.received).length >= 14, "missing client init");
    await fetch(`${address.base}/api/take-control`, { method: "POST", headers: authenticatedHeaders(session, address.origin), body: "{}" });
    const keyDown = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
    socket.send(keyDown);
    await waitFor(() => Buffer.concat(vnc.received).includes(keyDown), "missing key down");
    socket.close();
    await waitFor(() => Buffer.concat(vnc.received).includes(Buffer.from([4, 0, 0, 0, 0, 0, 0, 65])), "missing disconnect release");

    expect(h.ownership("ws-1").snapshot()).toMatchObject({ state: "manual", owner: "viewer" });
  });
});

describe("production gateway adapters and composition", () => {
  it("terminates and drains a spawned process when its AbortSignal fires", async () => {
    const controller = new AbortController();
    const started = performance.now();
    const running = executeProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)"],
      controller.signal,
    );
    setTimeout(() => controller.abort(new Error("cancelled")), 30);

    await expect(running).rejects.toThrow("cancelled");
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("cancels and drains an in-flight CDP HTTP probe", async () => {
    let markRequested!: () => void;
    let markClosed!: () => void;
    const requested = new Promise<void>((resolve) => { markRequested = resolve; });
    const closed = new Promise<void>((resolve) => { markClosed = resolve; });
    const httpServer = createHttpServer((request) => {
      markRequested();
      request.once("close", markClosed);
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(() => new Promise<void>((resolve) => httpServer.close(() => resolve())));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("missing probe address");

    const controller = new AbortController();
    const probing = probeCdp(`http://127.0.0.1:${address.port}`, controller.signal);
    await requested;
    controller.abort(new Error("probe cancelled"));
    await expect(probing).rejects.toThrow("probe cancelled");
    await closed;
  });

  it("creates a private non-symlink admin directory and refuses a symlink substitute", async () => {
    const xdg = await mkdtemp(join(tmpdir(), "tg-xdg-"));
    cleanups.push(() => rm(xdg, { recursive: true, force: true }));
    await chmod(xdg, 0o700);
    const socketPath = await prepareAdminSocketPath(xdg);
    const directory = await stat(join(xdg, "tabgoblin"));
    expect(directory.mode & 0o777).toBe(0o700);
    expect(socketPath).toBe(join(xdg, "tabgoblin", "gateway.sock"));

    const hostileRoot = await mkdtemp(join(tmpdir(), "tg-xdg-hostile-"));
    const target = await mkdtemp(join(tmpdir(), "tg-xdg-target-"));
    cleanups.push(() => rm(hostileRoot, { recursive: true, force: true }));
    cleanups.push(() => rm(target, { recursive: true, force: true }));
    await chmod(hostileRoot, 0o700);
    await symlink(target, join(hostileRoot, "tabgoblin"));
    await expect(prepareAdminSocketPath(hostileRoot)).rejects.toThrow(/symlink|directory/i);
  });

  it("invalidates browser references synchronously on ownership generation changes", async () => {
    const browser = { invalidateRefs: vi.fn() };
    const runtime = {
      state: vi.fn(() => "ready" as const),
      endpoints: vi.fn(() => ({
        containerName: "runtime",
        volumeName: "profile",
        cdpUrl: "http://127.0.0.1:9222",
        vncHost: "127.0.0.1",
        vncPort: 5900,
      })),
    };
    const services = createWorkspaceServices({
      runtime: runtime as never,
      pairing: new PairingCodes(),
      viewerUrl: "http://127.0.0.1:8931",
      attachBrowser: vi.fn(async () => browser as never),
    });
    await services.browser("ws-1");
    await services.ownership("ws-1").requestTakeControl("viewer-1");
    await services.ownership("ws-1").returnToAgent();
    expect(browser.invalidateRefs).toHaveBeenCalledOnce();
  });

  it("composes loopback viewer/admin listeners and unlinks only the admin socket on shutdown", async () => {
    const xdg = await mkdtemp(join(tmpdir(), "tg-gateway-xdg-"));
    cleanups.push(() => rm(xdg, { recursive: true, force: true }));
    await chmod(xdg, 0o700);
    const podman = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const application = await runGateway({
      xdgRuntimeDir: xdg,
      viewerPort: 0,
      viewerOrigins: ["http://127.0.0.1"],
      staticRoot,
      image: "test.invalid/browser:latest",
      podman,
    });
    cleanups.push(() => application.close());

    const response = await fetch(`http://127.0.0.1:${application.viewerPort}/`);
    expect(response.status).toBe(200);
    expect((await stat(application.socketPath)).mode & 0o777).toBe(0o600);
    await application.close();
    await expect(stat(application.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(podman).not.toHaveBeenCalled();
  });
});
