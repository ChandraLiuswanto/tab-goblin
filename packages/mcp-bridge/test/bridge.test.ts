import { createServer } from "node:http";
import { chmod, cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOOL_NAMES, type AdminResponse } from "@tab-goblin/protocol";
import { buildToolDefinitions, createBridge } from "../src/index.js";

const binding = async () => ({ agentId: "agent-1", workspaceId: "ws-1" });
const bridgePackage = fileURLToPath(new URL("..", import.meta.url));
const protocolPackage = fileURLToPath(new URL("../../protocol", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed: ${code}`)));
  });
}

async function prepareIsolatedBridgeRuntime(): Promise<{ entry: string; directory: string }> {
  const directory = await mkdtemp(join(bridgePackage, ".mcp-runtime-"));
  const protocolTarget = join(directory, "node_modules", "@tab-goblin", "protocol");
  await cp(join(bridgePackage, "dist"), join(directory, "bridge"), { recursive: true });
  await cp(join(protocolPackage, "package.json"), join(protocolTarget, "package.json"));
  await run(process.execPath, [
    join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
    "-p", join(protocolPackage, "tsconfig.json"),
    "--outDir", join(protocolTarget, "dist"),
    "--tsBuildInfoFile", join(protocolTarget, ".tsbuildinfo"),
  ]);
  return { entry: join(directory, "bridge", "index.js"), directory };
}

describe("tool definitions", () => {
  it("exposes exactly the TabGoblin namespace, including bounded network diagnostics", () => {
    const definitions = buildToolDefinitions();
    expect(definitions.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    expect(definitions.every((tool) => tool.name.startsWith("tabgoblin_"))).toBe(true);

    const network = definitions.find((tool) => tool.name === "tabgoblin_network")!;
    expect(network.description).toMatch(/method.*url.*status/i);
    expect(network.description).toMatch(/redact/i);
    expect(network.description).toMatch(/no.*bodies/i);
    expect(JSON.stringify(network.inputSchema)).not.toMatch(/requestBody|responseBody|cookie|header/i);
  });
});

describe("callTool", () => {
  it("resolves the socket binding and rejects a spoofed workspace without ever forwarding it", async () => {
    const call = vi.fn(async () => ({ ok: true, tabs: [] }) satisfies AdminResponse);
    const bridge = createBridge({ call, enrollment: "enrollment", resolveBinding: binding });

    await bridge.callTool("tabgoblin_list_tabs", { workspaceId: "someone-elses" });

    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ op: "tool", workspaceId: "ws-1", input: {} }),
    );
    expect(JSON.stringify(call.mock.calls)).not.toContain("someone-elses");
  });

  it("validates before calling the gateway and gives safe recovery instructions", async () => {
    const call = vi.fn();
    const bridge = createBridge({ call, enrollment: "enrollment", resolveBinding: binding });

    const result = await bridge.callTool("tabgoblin_navigate", { tabId: "t1", url: "file:///secret" });

    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("invalid_input");
    expect(call).not.toHaveBeenCalled();
  });

  it("maps structured errors without leaking the enrollment nonce", async () => {
    const bridge = createBridge({
      call: vi.fn(async () => ({
        ok: false,
        error: { code: "timeout_uncertain", message: "secret backend detail", retryable: false },
      })),
      enrollment: "super-secret-enrollment",
      resolveBinding: binding,
    });

    const result = await bridge.callTool("tabgoblin_status", {});
    const text = JSON.stringify(result);

    expect(result).toMatchObject({ isError: true });
    expect(text).toContain("timeout_uncertain");
    expect(text).toMatch(/inspect state.*do not retry/i);
    expect(text).not.toContain("super-secret-enrollment");
    expect(text).not.toContain("secret backend detail");
  });

  it("renders actual status, tab, and snapshot response fields rather than an arbitrary result", async () => {
    const status = {
      workspaceId: "ws-1",
      sessionState: "ready" as const,
      ownership: { state: "agent-ready" as const, generation: 1, owner: "agent" as const },
      startedAt: "2026-09-12T00:00:00.000Z",
      viewerUrl: "http://viewer.test",
      lastError: null,
    };
    const tab = { tabId: "t1", title: "Example", url: "https://example.test", active: true };
    const snapshot = { tabId: "t1", revision: 1, url: "https://example.test", title: "Example", nodes: [{ ref: "r1-e0", role: "button", name: "Go", depth: 0 }] };
    const call = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status })
      .mockResolvedValueOnce({ ok: true, tabs: [tab] })
      .mockResolvedValueOnce({ ok: true, snapshot })
      .mockResolvedValueOnce({ ok: true, result: tab });
    const bridge = createBridge({ call, enrollment: "enrollment", resolveBinding: binding });

    await expect(bridge.callTool("tabgoblin_status", {})).resolves.toEqual({ content: [{ type: "text", text: JSON.stringify(status) }] });
    await expect(bridge.callTool("tabgoblin_list_tabs", {})).resolves.toEqual({ content: [{ type: "text", text: JSON.stringify([tab]) }] });
    await expect(bridge.callTool("tabgoblin_snapshot", { tabId: "t1" })).resolves.toEqual({ content: [{ type: "text", text: JSON.stringify(snapshot) }] });
    await expect(bridge.callTool("tabgoblin_navigate", { tabId: "t1", url: "https://example.test" })).resolves.toEqual({ content: [{ type: "text", text: JSON.stringify(tab) }] });
  });

  it("rejects malformed success fields instead of rendering upstream result data", async () => {
    const bridge = createBridge({
      call: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, result: { backendSecret: "do-not-disclose" } })
        .mockResolvedValueOnce({ ok: true, result: "do-not-disclose" }),
      enrollment: "enrollment",
      resolveBinding: binding,
    });

    for (const [name, input] of [
      ["tabgoblin_status", {}],
      ["tabgoblin_close_tab", { tabId: "t1" }],
    ] as const) {
      const result = await bridge.callTool(name, input);
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toContain("runtime_unavailable");
      expect(JSON.stringify(result)).not.toContain("do-not-disclose");
    }
  });

  it("accepts actual bounded text, log, evaluation, and no-result success fields", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: "visible page text" })
      .mockResolvedValueOnce({ ok: true, result: ["log: one"] })
      .mockResolvedValueOnce({ ok: true, result: "{\"allowed\":true}" })
      .mockResolvedValueOnce({ ok: true });
    const bridge = createBridge({ call, enrollment: "enrollment", resolveBinding: binding });

    await expect(bridge.callTool("tabgoblin_text", { tabId: "t1", maxChars: 100 })).resolves.toEqual({ content: [{ type: "text", text: JSON.stringify("visible page text") }] });
    await expect(bridge.callTool("tabgoblin_logs", { tabId: "t1", maxEntries: 1 })).resolves.toEqual({ content: [{ type: "text", text: JSON.stringify(["log: one"]) }] });
    await expect(bridge.callTool("tabgoblin_evaluate", { tabId: "t1", expression: "({ allowed: true })", maxChars: 100 })).resolves.toEqual({ content: [{ type: "text", text: JSON.stringify("{\"allowed\":true}") }] });
    await expect(bridge.callTool("tabgoblin_close_tab", { tabId: "t1" })).resolves.toEqual({ content: [{ type: "text", text: "null" }] });
  });

  it("rejects text, log, and evaluation results that exceed their requested bounds", async () => {
    const bridge = createBridge({
      call: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, result: "x".repeat(101) })
        .mockResolvedValueOnce({ ok: true, result: ["one", "two"] })
        .mockResolvedValueOnce({ ok: true, result: "x".repeat(101) }),
      enrollment: "enrollment",
      resolveBinding: binding,
    });

    for (const [name, input] of [
      ["tabgoblin_text", { tabId: "t1", maxChars: 100 }],
      ["tabgoblin_logs", { tabId: "t1", maxEntries: 1 }],
      ["tabgoblin_evaluate", { tabId: "t1", expression: "null", maxChars: 100 }],
    ] as const) {
      const result = await bridge.callTool(name, input);
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toContain("runtime_unavailable");
    }
  });

  it("converts only canonical bounded screenshots and network entries within the requested limit", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: { mimeType: "image/png", base64: "cGl4ZWxz" } })
      .mockResolvedValueOnce({
        ok: true,
        result: [
          { method: "GET", url: "https://example.test/path?secret=discarded", status: 200 },
          { method: "POST", url: "https://example.test/second", status: 201 },
        ],
      })
      .mockResolvedValueOnce({ ok: true, result: { mimeType: "image/png", base64: "A" } });
    const bridge = createBridge({ call, enrollment: "enrollment", resolveBinding: binding });

    await expect(bridge.callTool("tabgoblin_screenshot", { tabId: "t1" })).resolves.toEqual({
      content: [{ type: "image", data: "cGl4ZWxz", mimeType: "image/png" }],
    });
    const network = await bridge.callTool("tabgoblin_network", { tabId: "t1", maxEntries: 1 });
    expect(network).toMatchObject({ isError: true });
    expect(JSON.stringify(network)).toContain("runtime_unavailable");

    const invalidImage = await bridge.callTool("tabgoblin_screenshot", { tabId: "t1" });
    expect(invalidImage).toMatchObject({ isError: true });
    expect(JSON.stringify(invalidImage)).toContain("runtime_unavailable");
  });
});

interface RunningBridge {
  socketPath: string;
  requests: Array<Record<string, unknown>>;
  stop(): Promise<void>;
}

async function startAdminSocket(): Promise<RunningBridge> {
  const directory = await mkdtemp(join(tmpdir(), "tabgoblin-bridge-"));
  const socketPath = join(directory, "gateway.sock");
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requests.push(body);
      const result = body.op === "resolve-enrollment"
        ? { ok: true, binding: { agentId: "agent-1", workspaceId: "ws-1" } }
        : body.name === "tabgoblin_screenshot"
          ? { ok: true, result: { mimeType: "image/png", base64: "cGl4ZWxz" } }
          : { ok: true, result: [{ method: "GET", url: "https://example.test/path?private=yes", status: 200 }] };
      const encoded = JSON.stringify(result);
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) });
      response.end(encoded);
    });
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
  await chmod(socketPath, 0o600);
  return {
    socketPath,
    requests,
    async stop() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function waitForMessage(
  child: ReturnType<typeof spawn>,
  id: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("error", onError);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const value = JSON.parse(line) as Record<string, unknown>;
        if (value.id === id) {
          cleanup();
          resolve(value);
          return;
        }
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for MCP response ${id}; child exit code: ${child.exitCode}`));
    }, 5_000);
    child.stdout.on("data", onData);
    child.once("error", onError);
  });
}

describe("stdio MCP process", () => {
  let admin: RunningBridge;

  beforeEach(async () => {
    admin = await startAdminSocket();
  });

  afterEach(async () => {
    await admin.stop();
  });

  it("registers every actual tool and sends scoped calls through the unix admin socket", async () => {
    for (const workspace of ["@tab-goblin/protocol", "@tab-goblin/mcp-bridge"]) {
      const build = spawn("npm", ["run", "build", "-w", workspace], { stdio: "inherit" });
      await new Promise<void>((resolve, reject) => build.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${workspace} build failed: ${code}`))));
    }

    const runtime = await prepareIsolatedBridgeRuntime();
    const child = spawn(process.execPath, [runtime.entry], {
      env: {
        PATH: process.env.PATH ?? "",
        TABGOBLIN_SOCKET: admin.socketPath,
        TABGOBLIN_ENROLLMENT: "ephemeral-enrollment",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    try {
      const initialized = waitForMessage(child, 1);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } })}\n`);
    await initialized;
    const listedResponse = waitForMessage(child, 2);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    const listed = await listedResponse;
    const tools = ((listed.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
    expect(tools).toEqual([...TOOL_NAMES]);

    const screenshotResponse = waitForMessage(child, 3);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tabgoblin_screenshot", arguments: { tabId: "t1" } } })}\n`);
    const screenshot = await screenshotResponse;
    expect(screenshot).toMatchObject({ result: { content: [{ type: "image", mimeType: "image/png", data: "cGl4ZWxz" }] } });
    expect(admin.requests).toEqual([
      { op: "resolve-enrollment", enrollment: "ephemeral-enrollment" },
      expect.objectContaining({
        op: "tool",
        enrollment: "ephemeral-enrollment",
        workspaceId: "ws-1",
        name: "tabgoblin_screenshot",
      }),
    ]);
      expect(Buffer.concat(stderr).toString("utf8")).not.toContain("ephemeral-enrollment");
    } finally {
      child.kill();
      await rm(runtime.directory, { recursive: true, force: true });
    }
  });
});
