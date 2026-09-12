import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayClient, createGatewayManager } from "../server/gateway-client.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((remove) => remove()));
});

describe("gateway client", () => {
  it("uses the Unix admin socket and validates its response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabgoblin-plugin-"));
    const socketPath = join(directory, "gateway.sock");
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cleanup.push(
      () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))).then(() => rm(directory, { recursive: true })),
    );

    const client = createGatewayClient(socketPath);
    await expect(client.request({ op: "start", workspaceId: "ws-1" })).resolves.toEqual({ ok: true });
    expect(received).toEqual([{ op: "start", workspaceId: "ws-1" }]);
    expect(client.notify({ op: "stop", workspaceId: "ws-1" })).toBeUndefined();
  });

  it("rejects an oversized byte response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabgoblin-plugin-"));
    const socketPath = join(directory, "gateway.sock");
    const server = createServer((_request, response) => response.end(Buffer.alloc(1024 * 1024 + 1, 0x61)));
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))).then(() => rm(directory, { recursive: true })));
    await expect(createGatewayClient(socketPath).request({ op: "status", workspaceId: "ws-1" })).resolves.toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
  });

  it("revokes through the old socket before selecting a replacement socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabgoblin-plugin-")); const oldPath = join(directory, "old.sock"); const newPath = join(directory, "new.sock"); const events: string[] = [];
    const oldServer = createServer((request, response) => { events.push(`old:${request.url}`); response.end(JSON.stringify({ ok: true, lifecycleGeneration: 1 })); });
    const newServer = createServer((request, response) => { events.push(`new:${request.url}`); response.end(JSON.stringify({ ok: true })); });
    await Promise.all([new Promise<void>((resolve) => oldServer.listen(oldPath, resolve)), new Promise<void>((resolve) => newServer.listen(newPath, resolve))]);
    cleanup.push(() => Promise.all([oldServer, newServer].map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))).then(() => rm(directory, { recursive: true })));
    const manager = createGatewayManager(() => oldPath);
    await manager.switchSocketPath(newPath, [{ op: "revoke-workspace", workspaceId: "ws-1" }]);
    await manager.request({ op: "status", workspaceId: "ws-1" });
    expect(events).toEqual(["old:/", "new:/"]);
  });

  it("keeps the old socket when a protocol-valid revoke success omits its lifecycle generation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabgoblin-plugin-")); const oldPath = join(directory, "old.sock"); const newPath = join(directory, "new.sock");
    const oldServer = createServer((_request, response) => response.end(JSON.stringify({ ok: true })));
    await new Promise<void>((resolve) => oldServer.listen(oldPath, resolve));
    cleanup.push(() => new Promise<void>((resolve, reject) => oldServer.close((error) => error ? reject(error) : resolve())).then(() => rm(directory, { recursive: true })));
    const manager = createGatewayManager(() => oldPath);
    await manager.switchSocketPath(newPath, [{ op: "revoke-workspace", workspaceId: "ws-1" }]);
    expect(manager.socketPath()).toBe(oldPath);
  });

  it("keeps the old socket and its pending work when an old-socket revoke is not acknowledged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabgoblin-plugin-")); const oldPath = join(directory, "old.sock"); const newPath = join(directory, "new.sock"); const events: string[] = []; let failFirstRevoke = true;
    const oldServer = createServer((request, response) => { const chunks: Buffer[] = []; request.on("data", (chunk: Buffer) => chunks.push(chunk)); request.on("end", () => { const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); events.push(`old:${body.op}`); response.end(JSON.stringify(body.op === "revoke-workspace" && failFirstRevoke ? (failFirstRevoke = false, { ok: false, error: { code: "runtime_unavailable", message: "down", retryable: true } }) : { ok: true, lifecycleGeneration: 4 })); }); });
    const newServer = createServer((request, response) => { const chunks: Buffer[] = []; request.on("data", (chunk: Buffer) => chunks.push(chunk)); request.on("end", () => { events.push(`new:${JSON.parse(Buffer.concat(chunks).toString("utf8")).op}`); response.end(JSON.stringify({ ok: true })); }); });
    await Promise.all([new Promise<void>((resolve) => oldServer.listen(oldPath, resolve)), new Promise<void>((resolve) => newServer.listen(newPath, resolve))]);
    cleanup.push(() => Promise.all([oldServer, newServer].map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))).then(() => rm(directory, { recursive: true })));
    const manager = createGatewayManager(() => oldPath); const revoke = [{ op: "revoke-workspace" as const, workspaceId: "ws-1" }];
    await manager.switchSocketPath(newPath, revoke);
    expect(manager.socketPath()).toBe(oldPath);
    await manager.request({ op: "status", workspaceId: "ws-1" });
    await manager.switchSocketPath(newPath, revoke);
    expect(manager.socketPath()).toBe(newPath);
    await manager.request({ op: "status", workspaceId: "ws-1" });
    expect(events).toEqual(["old:revoke-workspace", "old:status", "old:revoke-workspace", "new:status"]);
  });

  it("returns runtime_unavailable rather than throwing on transport failure", async () => {
    const client = createGatewayClient(join(tmpdir(), "missing-tabgoblin.sock"));
    await expect(client.request({ op: "status", workspaceId: "ws-1" }, 100)).resolves.toMatchObject({
      ok: false,
      error: { code: "runtime_unavailable", retryable: true },
    });
  });
});
