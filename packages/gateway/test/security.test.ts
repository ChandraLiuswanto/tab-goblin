import { execFileSync } from "node:child_process";
import { mkdir, readFile, mkdtemp, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createConnection, createServer as createTcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { CSRF_HEADER } from "@tab-goblin/protocol";
import { createBridge } from "../../mcp-bridge/src/index.js";
import { ActivityFeed } from "../src/activity-feed.js";
import { createAdminServer } from "../src/admin-server.js";
import { EnrollmentRegistry } from "../src/enrollment.js";
import { OwnershipController } from "../src/ownership.js";
import { PairingCodes } from "../src/pairing.js";
import { RfbClientStreamGate, RfbProtocolError } from "../src/rfb-framing.js";
import { createViewerServer } from "../src/viewer-server.js";

const NONCE_A = "11111111-1111-4111-8111-111111111111";
const NONCE_B = "22222222-2222-4222-8222-222222222222";
const SECRET = "test-only-sensitive-input-never-log";
const cleanups: Array<() => Promise<void>> = [];

function keyEvent(keysym: number, down = true): Buffer {
  const frame = Buffer.alloc(8);
  frame[0] = 4;
  frame[1] = down ? 1 : 0;
  frame.writeUInt32BE(keysym, 4);
  return frame;
}

function pointerEvent(mask: number, x = 10, y = 20): Buffer {
  const frame = Buffer.alloc(mask > 0x7f ? 7 : 6);
  frame[0] = 5;
  frame[1] = (mask & 0x7f) | (mask > 0x7f ? 0x80 : 0);
  frame.writeUInt16BE(x, 2);
  frame.writeUInt16BE(y, 4);
  if (frame.length === 7) frame[6] = (mask >> 7) & 0x03;
  return frame;
}

function updateRequest(): Buffer {
  const frame = Buffer.alloc(10);
  frame[0] = 3;
  return frame;
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function staticRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tabgoblin-security-static-"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>security fixture</title>");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function fakeVnc(): Promise<{ port: number; received: Buffer[]; sockets: Socket[] }> {
  const received: Buffer[] = [];
  const sockets: Socket[] = [];
  const server = createTcpServer((socket) => {
    sockets.push(socket);
    socket.write("RFB 003.008\n");
    let phase = 0;
    socket.on("data", (data) => {
      received.push(Buffer.from(data));
      const all = Buffer.concat(received);
      if (phase === 0 && all.includes(Buffer.from("RFB 003.008\n"))) {
        phase = 1;
        socket.write(Buffer.from([1, 1]));
      } else if (phase === 1 && data.includes(1)) {
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
  if (!address || typeof address === "string") throw new Error("missing fixture VNC port");
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: address.port, received, sockets };
}

function viewerHarness(vncPort: number) {
  const pairing = new PairingCodes();
  const ownerships = new Map<string, OwnershipController>();
  const ownership = (workspaceId: string) => {
    let controller = ownerships.get(workspaceId);
    if (!controller) {
      controller = new OwnershipController();
      ownerships.set(workspaceId, controller);
    }
    return controller;
  };
  return staticRoot().then((root) => {
    const server = createViewerServer({
      services: {
        runtime: {
          state: () => "ready",
          endpoints: () => ({
            containerName: "fixture",
            volumeName: "fixture",
            cdpUrl: "http://127.0.0.1:9222",
            vncHost: "127.0.0.1",
            vncPort,
          }),
        },
        ownership,
        activity: () => new ActivityFeed(),
        browser: async () => { throw new Error("browser is not used by the viewer proxy"); },
        issuePairingCode: () => { throw new Error("not used"); },
        viewerUrlFor: () => "http://127.0.0.1",
      } as never,
      pairing,
      port: 0,
      staticRoot: root,
      allowedOrigins: ["http://127.0.0.1"],
    });
    cleanups.push(() => server.close());
    return { server, pairing, ownership };
  });
}

async function pairedSession(
  harness: Awaited<ReturnType<typeof viewerHarness>>,
  base: string,
  workspaceId: string,
): Promise<{ cookie: string; csrf: string }> {
  const issued = harness.pairing.issue(workspaceId);
  const response = await fetch(`${base}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ code: issued.code }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { csrfToken: string };
  return { cookie: response.headers.get("set-cookie")!.split(";", 1)[0]!, csrf: body.csrfToken };
}

async function openSocket(url: string, cookie: string, origin: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie, origin } });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function completeHandshake(socket: WebSocket): Promise<void> {
  const messages: Buffer[] = [];
  socket.on("message", (data) => messages.push(Buffer.from(data as Buffer)));
  await waitFor(() => Buffer.concat(messages).includes(Buffer.from("RFB 003.008\n")), "missing RFB version");
  socket.send(Buffer.from("RFB 003.008\n"));
  await waitFor(() => Buffer.concat(messages).includes(Buffer.from([1, 1])), "missing RFB security types");
  socket.send(Buffer.from([1]));
  await waitFor(() => Buffer.concat(messages).length >= 18, "missing RFB security result");
  socket.send(Buffer.from([1]));
}

function bindInteractive(registry: EnrollmentRegistry, enrollment: string, cwd: string, agent: string, workspace: string): void {
  registry.record(enrollment, cwd, workspace);
  registry.bind(cwd, agent, workspace);
  registry.noteSessionOpen(agent, workspace, "interactive");
}

function toolRequest(name: string, input: Record<string, unknown> = {}) {
  return { op: "tool", enrollment: NONCE_A, workspaceId: "ws-a", source: "agent:security", name, input };
}

async function postUnix(socketPath: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, path: "/", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
});

describe("viewer authentication and transport input gating", () => {
  it("drops forged input, permits it only for the manual owner, and stops on return without closing the viewer", async () => {
    const vnc = await fakeVnc();
    const h = await viewerHarness(vnc.port);
    const port = await h.server.listen();
    const base = `http://127.0.0.1:${port}`;
    const viewer = await pairedSession(h, base, "ws-a");
    const socket = await openSocket(`${base.replace("http", "ws")}/ws/vnc`, viewer.cookie, base);
    cleanups.push(async () => socket.close());
    await completeHandshake(socket);

    socket.send(Buffer.concat([updateRequest(), keyEvent(0x41), pointerEvent(1)]));
    await waitFor(() => Buffer.concat(vnc.received).includes(updateRequest()), "framebuffer request was not proxied");
    expect(Buffer.concat(vnc.received).includes(keyEvent(0x41))).toBe(false);
    expect(Buffer.concat(vnc.received).includes(pointerEvent(1))).toBe(false);

    const headers = { cookie: viewer.cookie, [CSRF_HEADER]: viewer.csrf, origin: base, "content-type": "application/json" };
    expect((await fetch(`${base}/api/take-control`, { method: "POST", headers, body: "{}" })).status).toBe(200);
    socket.send(keyEvent(0x42));
    await waitFor(() => Buffer.concat(vnc.received).includes(keyEvent(0x42)), "manual key was not proxied");
    expect((await fetch(`${base}/api/return-to-agent`, { method: "POST", headers, body: "{}" })).status).toBe(200);
    const afterReturn = Buffer.concat(vnc.received).length;
    socket.send(keyEvent(0x43));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(Buffer.concat(vnc.received).subarray(afterReturn).includes(keyEvent(0x43))).toBe(false);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects missing/foreign workspace cookies and foreign WebSocket Origin; a second device must reclaim", async () => {
    const vnc = await fakeVnc();
    const h = await viewerHarness(vnc.port);
    const port = await h.server.listen();
    const base = `http://127.0.0.1:${port}`;
    const first = await pairedSession(h, base, "ws-a");
    const second = await pairedSession(h, base, "ws-a");
    const foreign = await pairedSession(h, base, "ws-b");
    for (const headers of [{}, { cookie: foreign.cookie }, { cookie: first.cookie, origin: "https://evil.invalid" }]) {
      await expect(new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(`${base.replace("http", "ws")}/ws/vnc`, { headers });
        socket.once("open", () => resolve(socket));
        socket.once("error", reject);
      })).rejects.toBeDefined();
    }
    const takeHeaders = { cookie: first.cookie, [CSRF_HEADER]: first.csrf, origin: base, "content-type": "application/json" };
    expect((await fetch(`${base}/api/take-control`, { method: "POST", headers: takeHeaders, body: "{}" })).status).toBe(200);
    const secondStatus = await fetch(`${base}/api/status`, { headers: { cookie: second.cookie, [CSRF_HEADER]: second.csrf, origin: base } });
    expect((await secondStatus.json() as { isOwner: boolean }).isOwner).toBe(false);
    expect((await fetch(`${base}/api/reclaim`, { method: "POST", headers: { cookie: second.cookie, [CSRF_HEADER]: second.csrf, origin: base, "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) })).status).toBe(200);
  });

  it("enforces one-use/expired and rate-limited pairing, CSRF on every state change, and sign-out invalidation", async () => {
    let now = 0;
    const codes = new PairingCodes({ now: () => now, ttlMs: 10, maxFailuresPerMinute: 2 });
    const expired = codes.issue("ws-a");
    now = 10;
    expect(() => codes.redeem(expired.code)).toThrowError(expect.objectContaining({ code: "auth_failed" }));
    const fresh = codes.issue("ws-a");
    expect(codes.redeem(fresh.code)).toEqual({ workspaceId: "ws-a" });
    expect(() => codes.redeem(fresh.code)).toThrowError(expect.objectContaining({ code: "auth_failed" }));
    expect(() => codes.redeem("wrong-a")).toThrow();
    expect(() => codes.redeem("wrong-b")).toThrowError(expect.objectContaining({ code: "auth_failed" }));

    const vnc = await fakeVnc();
    const h = await viewerHarness(vnc.port);
    const port = await h.server.listen();
    const base = `http://127.0.0.1:${port}`;
    const session = await pairedSession(h, base, "ws-a");
    for (const path of ["/api/take-control", "/api/return-to-agent", "/api/reclaim", "/api/sign-out"]) {
      expect((await fetch(`${base}${path}`, { method: "POST", headers: { cookie: session.cookie, origin: base, "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    }
    const headers = { cookie: session.cookie, [CSRF_HEADER]: session.csrf, origin: base, "content-type": "application/json" };
    expect((await fetch(`${base}/api/sign-out`, { method: "POST", headers, body: "{}" })).status).toBe(200);
    expect((await fetch(`${base}/api/status`, { headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrf, origin: base } })).status).toBe(403);
  });
});

describe("agent scope and bounded local control plane", () => {
  it("fails closed for unbound, history, revoked, stale-generation, and same-cwd cross-workspace enrollments", async () => {
    const registry = new EnrollmentRegistry();
    await expect(registry.authorize(NONCE_A)).rejects.toMatchObject({ code: "not_enrolled" });
    bindInteractive(registry, NONCE_A, "/same/cwd", "agent-a", "ws-a");
    bindInteractive(registry, NONCE_B, "/same/cwd", "agent-b", "ws-b");
    await expect(registry.authorize(NONCE_A)).resolves.toMatchObject({ cwd: "/same/cwd", workspaceId: "ws-a" });
    await expect(registry.authorize(NONCE_B)).resolves.toMatchObject({ cwd: "/same/cwd", workspaceId: "ws-b" });
    registry.noteSessionOpen("agent-a", "ws-a", "history");
    await expect(registry.authorize(NONCE_A)).rejects.toMatchObject({ code: "not_enrolled" });
    registry.noteSessionOpen("agent-a", "ws-a", "interactive");
    registry.revokeAgent("agent-a");
    await expect(registry.authorize(NONCE_A)).rejects.toMatchObject({ code: "not_enrolled" });
    registry.resetAgent("agent-a");
    await expect(registry.authorize(NONCE_A)).rejects.toMatchObject({ code: "not_enrolled" });
    registry.revokeWorkspace("ws-b");
    await expect(registry.authorize(NONCE_B)).rejects.toMatchObject({ code: "not_enrolled" });
  });

  it("forces the bridge to its enrollment workspace and redacts sensitive runtime details from tool results", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const bridge = createBridge({
      enrollment: NONCE_A,
      resolveBinding: async () => ({ workspaceId: "ws-a", agentId: "agent-a" }) as never,
      call: async (body) => {
        calls.push(body as Record<string, unknown>);
        return { ok: true };
      },
    });
    const result = await bridge.callTool("tabgoblin_start", {});
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ workspaceId: "ws-a", enrollment: NONCE_A });
    expect(JSON.stringify(result)).not.toMatch(/9222|cdp|profile|socket|11111111/i);
  });

  it("bounds Unix-socket request bytes and deadlines without reflecting sensitive malformed input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabgoblin-security-admin-"));
    const socketPath = join(directory, "admin.sock");
    const server = createAdminServer({ services: {} as never, enrollment: new EnrollmentRegistry(), socketPath, handlerTimeoutMs: 25 });
    await server.listen();
    cleanups.push(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    const tooLarge = await postUnix(socketPath, JSON.stringify({ padding: "x".repeat(65_536), secret: SECRET }));
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body).not.toContain(SECRET);
    const timedOut = await new Promise<boolean>((resolve) => {
      const socket = createConnection(socketPath);
      const chunks: Buffer[] = [];
      let drip: ReturnType<typeof setInterval> | undefined;
      const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 500);
      socket.once("connect", () => {
        socket.write("POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4096\r\n\r\n{");
        drip = setInterval(() => socket.writable && socket.write(" "), 5);
      });
      socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      socket.once("close", () => {
        clearTimeout(timer);
        if (drip) clearInterval(drip);
        resolve(Buffer.concat(chunks).toString().includes("timeout_uncertain"));
      });
      socket.once("error", () => { clearTimeout(timer); if (drip) clearInterval(drip); resolve(chunks.length > 0); });
    });
    expect(timedOut).toBe(true);
  });
});

describe("RFB adversarial framing", () => {
  it("handles fragmented/coalesced pre-handshake data but rejects malformed, clipboard, file transfer, and stale-generation held input", () => {
    const gate = new RfbClientStreamGate({ maxBufferedBytes: 64 });
    gate.observeServer(Buffer.from("RFB 003.008\n"));
    expect(gate.pushClient(Buffer.from("RFB 003."), { allowed: false, generation: 0 }).forward).toHaveLength(0);
    expect(gate.pushClient(Buffer.from("008\n"), { allowed: false, generation: 0 }).forward.toString()).toBe("RFB 003.008\n");
    gate.observeServer(Buffer.from([1, 1]));
    expect(gate.pushClient(Buffer.from([1]), { allowed: false, generation: 0 }).forward).toEqual(Buffer.from([1]));
    gate.observeServer(Buffer.alloc(4));
    expect(gate.pushClient(Buffer.from([1]), { allowed: false, generation: 0 }).forward).toEqual(Buffer.from([1]));

    const held = keyEvent(0xffe3);
    expect(gate.pushClient(held.subarray(0, 4), { allowed: true, generation: 1 }).forward).toHaveLength(0);
    expect(gate.pushClient(held.subarray(4), { allowed: false, generation: 2 }).forward).toHaveLength(0);
    expect(gate.synthesizeReleases()).toHaveLength(0);
    expect(gate.pushClient(Buffer.concat([keyEvent(0x41), pointerEvent(1)]), { allowed: true, generation: 2 }).forward).toEqual(Buffer.concat([keyEvent(0x41), pointerEvent(1)]));
    expect(gate.synthesizeReleases()).toEqual(Buffer.concat([keyEvent(0x41, false), pointerEvent(0)]));

    for (const frame of [Buffer.from([6, 0, 0, 0, 0, 0, 0, 1, 1]), Buffer.from([7]), Buffer.from([251]), Buffer.from([199])]) {
      expect(() => gate.pushClient(frame, { allowed: false, generation: 2 })).toThrow(RfbProtocolError);
    }
    const invalid = new RfbClientStreamGate({ maxBufferedBytes: 16 });
    expect(() => invalid.observeServer(Buffer.from("NOT RFB DATA"))).toThrow(RfbProtocolError);
    expect(() => invalid.pushClient(Buffer.alloc(17), { allowed: false, generation: 0 })).toThrow(RfbProtocolError);
  });
});

describe("secret hygiene and deployment boundaries", () => {
  it("does not persist sensitive fill/screenshot data in bounded redacted activity or emit it to process output", async () => {
    const activity = new ActivityFeed(1);
    activity.begin({ operationId: "first", source: "agent:a", tabId: "t", action: "navigate" });
    activity.finish("first", { status: "ok", url: `https://user:${SECRET}@example.test/a?q=${SECRET}#${SECRET}`, title: "private page" });
    activity.begin({ operationId: "second", source: "agent:a", tabId: "t", action: "screenshot" });
    activity.finish("second", { status: "ok" });
    const records = activity.list();
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain(SECRET);
    expect(records[0]).toMatchObject({ action: "screenshot", url: null, title: null });

    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write");
    const codes = new PairingCodes();
    const code = codes.issue("ws-a").code;
    codes.redeem(code);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it("stages uploads from a private regular-file snapshot despite a symlink swap", async () => {
    const root = await mkdtemp(join(tmpdir(), "tabgoblin-security-upload-"));
    const workspace = join(root, "workspace");
    const documents = join(workspace, "documents");
    const movedDocuments = join(workspace, "documents-original");
    const outside = join(root, "outside");
    await mkdir(documents, { recursive: true });
    await mkdir(outside);
    await Promise.all([writeFile(join(documents, "report.txt"), "inside"), writeFile(join(outside, "report.txt"), SECRET)]);
    const registry = new EnrollmentRegistry();
    bindInteractive(registry, NONCE_A, workspace, "agent-a", "ws-a");
    const ownership = new OwnershipController();
    const activity = new ActivityFeed();
    let stagedContents = "";
    const server = createAdminServer({
      enrollment: registry,
      socketPath: join(root, "admin.sock"),
      services: {
        ownership: () => ownership,
        activity: () => activity,
        browser: async () => ({ upload: async () => undefined }),
        runtime: { state: () => "ready", stageFile: async (_workspaceId: string, path: string) => {
          await rename(documents, movedDocuments);
          await symlink(outside, documents, "dir");
          stagedContents = await readFile(path, "utf8");
          return "/staging/upload.txt";
        } },
      },
    } as never);
    const response = await server.handle(toolRequest("tabgoblin_upload", { tabId: "tab", ref: "r1-e1", path: "documents/report.txt" }) as never);
    expect(response).toMatchObject({ ok: true });
    expect(stagedContents).toBe("inside");
    expect(JSON.stringify(activity.list())).not.toContain(SECRET);
    await rm(root, { recursive: true, force: true });
  });

  it("keeps deployment unprivileged and loopback-only, with no tracked world-readable credential files", async () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const [containerfile, entrypoint] = await Promise.all([
      readFile(join(root, "deploy/Containerfile"), "utf8"),
      readFile(join(root, "deploy/runtime-entrypoint.sh"), "utf8"),
    ]);
    expect(`${containerfile}\n${entrypoint}`).not.toMatch(/--no-sandbox|--privileged|--network=host|\bsetenforce\b/i);
    expect(await readFile(join(root, "packages/gateway/src/runtime.ts"), "utf8")).toMatch(/"127\.0\.0\.1::9222"[\s\S]*"127\.0\.0\.1::5900"/);
    const tracked = execFileSync("git", ["ls-files", "-s"], { encoding: "utf8" }).trim().split("\n");
    const credentialPaths = tracked.filter((line) => /\s(?:[^\s]+\.(?:pem|key|p12)|.*(?:secret|credential|token|password)[^/]*)(?:\s|$)/i.test(line));
    expect(credentialPaths.filter((line) => /^100[46]44\s/.test(line))).toEqual([]);
  });
});
