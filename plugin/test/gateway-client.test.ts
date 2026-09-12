import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayClient } from "../server/gateway-client.js";

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

  it("returns runtime_unavailable rather than throwing on transport failure", async () => {
    const client = createGatewayClient(join(tmpdir(), "missing-tabgoblin.sock"));
    await expect(client.request({ op: "status", workspaceId: "ws-1" }, 100)).resolves.toMatchObject({
      ok: false,
      error: { code: "runtime_unavailable", retryable: true },
    });
  });
});
