import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfigStore } from "../server/config-store.js";
import { createGatewayManager } from "../server/gateway-client.js";
import { createLifecycleCoordinator } from "../server/lifecycle-coordinator.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function unixServer(socketPath: string, events: string[]) {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      events.push(body.op);
      response.setHeader("content-type", "application/json");
      if (body.op === "health") response.end(JSON.stringify({ ok: true, protocolVersion: 1 }));
      else if (body.op === "revoke-workspace" || body.op === "revoke-agent") response.end(JSON.stringify({ ok: true, lifecycleGeneration: 4 }));
      else response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return server;
}

describe("transactional socket reconfiguration", () => {
  it("keeps the old client usable and config unchanged when the candidate Unix socket is unreachable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabgoblin-socket-transaction-"));
    const oldPath = join(directory, "old.sock");
    const missingPath = join(directory, "missing.sock");
    const oldEvents: string[] = [];
    const oldServer = await unixServer(oldPath, oldEvents);
    const settings = createConfigStore(join(directory, "config"));
    await settings.update((current) => ({ ...current, socketPath: oldPath, viewerUrl: "https://old-viewer.test/", workspaceGenerations: { ws: 3 } }));
    const manager = createGatewayManager(() => oldPath);
    const coordinator = createLifecycleCoordinator(settings, manager);
    cleanups.push(async () => { manager.close(); await closeServer(oldServer); await rm(directory, { recursive: true, force: true }); });

    await expect(coordinator.updateConnection({ socketPath: missingPath, viewerUrl: "https://new-viewer.test/" })).resolves.toEqual({ ok: false });
    expect(manager.socketPath()).toBe(oldPath);
    expect(settings.read()).toMatchObject({ socketPath: oldPath, viewerUrl: "https://old-viewer.test/", pendingRevocations: [] });
    await expect(manager.request({ op: "status", workspaceId: "ws" })).resolves.toEqual({ ok: true });
    expect(oldEvents).toEqual(["status"]);
  });

  it("probes a compatible candidate, checks old revocations, then commits config and handover", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabgoblin-socket-transaction-"));
    const oldPath = join(directory, "old.sock");
    const newPath = join(directory, "new.sock");
    const oldEvents: string[] = [];
    const newEvents: string[] = [];
    const oldServer = await unixServer(oldPath, oldEvents);
    const newServer = await unixServer(newPath, newEvents);
    const settings = createConfigStore(join(directory, "config"));
    await settings.update((current) => ({ ...current, socketPath: oldPath, viewerUrl: "https://old-viewer.test/", workspaceGenerations: { ws: 3 } }));
    const manager = createGatewayManager(() => oldPath);
    const coordinator = createLifecycleCoordinator(settings, manager);
    cleanups.push(async () => { manager.close(); await Promise.all([closeServer(oldServer), closeServer(newServer)]); await rm(directory, { recursive: true, force: true }); });

    await expect(coordinator.updateConnection({ socketPath: newPath, viewerUrl: "https://new-viewer.test/" })).resolves.toEqual({ ok: true });
    expect(newEvents).toEqual(["health"]);
    expect(oldEvents).toEqual(["revoke-workspace"]);
    expect(manager.socketPath()).toBe(newPath);
    expect(settings.read()).toMatchObject({ socketPath: newPath, viewerUrl: "https://new-viewer.test/", pendingRevocations: [] });
    await expect(manager.request({ op: "status", workspaceId: "ws" })).resolves.toEqual({ ok: true });
    expect(newEvents).toEqual(["health", "status"]);
  });
});
