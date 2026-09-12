#!/usr/bin/env node
import { request as httpRequest } from "node:http";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  ADMIN_SOCKET_ENV,
  AdminRequestSchema,
  AdminResponseSchema,
  ENROLLMENT_ENV,
  MCP_SERVER_NAME,
  NetworkDiagnosticSchema,
  SessionStatusSchema,
  SnapshotSchema,
  TabSchema,
  tabGoblinError,
  ToolInputSchemas,
  gatewayTransportTimeoutMs,
  type AdminResponse,
  type ErrorCode,
  type ToolName,
} from "@tab-goblin/protocol";
import { z } from "zod";
import { buildToolDefinitions } from "./tools.js";

export { buildToolDefinitions } from "./tools.js";

const SOCKET_REQUEST_MAX_BYTES = 64 * 1024;
const SOCKET_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const TOOL_RESULT_MAX_BYTES = 8 * 1024 * 1024;

const BindingSchema = z.object({ agentId: z.string().min(1).max(128), workspaceId: z.string().min(1).max(128) }).strict();
type Binding = z.infer<typeof BindingSchema>;

export type BridgeResult = CallToolResult;
type ToolRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface BridgeDependencies {
  call: (request: unknown, signal?: AbortSignal) => Promise<AdminResponse>;
  enrollment: string;
  resolveBinding: () => Promise<Binding>;
}

const recovery: Record<ErrorCode, string> = {
  session_not_ready: "Run tabgoblin_start before continuing.",
  tab_not_found: "Run tabgoblin_list_tabs and use a current tab identifier.",
  stale_ref: "Take a fresh tabgoblin_snapshot and use its current reference.",
  manual_control: "The user has manual control; continue other work or ask for a handoff.",
  busy: "Another command is running; retry after it finishes.",
  timeout_uncertain: "The result is unknown; inspect state with a snapshot before deciding, and do not retry.",
  auth_failed: "The workspace binding is no longer valid; ask the user to re-enable TabGoblin.",
  runtime_unavailable: "TabGoblin is unavailable; verify the workspace session and try again later.",
  invalid_input: "Check the tool arguments and try again.",
  not_enrolled: "TabGoblin is not enabled for this agent's workspace. Enable it in the Paseo panel.",
};

function errorResult(code: ErrorCode): BridgeResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ code, message: recovery[code], retryable: code === "busy" || code === "runtime_unavailable" }) }],
    isError: true,
  };
}

function codeFrom(error: unknown, fallback: ErrorCode): ErrorCode {
  const parsed = z.object({ code: z.enum([
    "session_not_ready", "tab_not_found", "stale_ref", "manual_control", "busy",
    "timeout_uncertain", "auth_failed", "runtime_unavailable", "invalid_input", "not_enrolled",
  ]) }).safeParse(error);
  return parsed.success ? parsed.data.code : fallback;
}

function withoutWorkspaceId(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const { workspaceId: _untrustedScope, ...rest } = input as Record<string, unknown>;
  return rest;
}

function textResult(value: unknown): BridgeResult {
  const text = JSON.stringify(value);
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > TOOL_RESULT_MAX_BYTES) {
    return errorResult("runtime_unavailable");
  }
  return { content: [{ type: "text", text }] };
}

const tabResultTools = new Set<ToolName>([
  "tabgoblin_new_tab",
  "tabgoblin_navigate",
  "tabgoblin_back",
  "tabgoblin_forward",
  "tabgoblin_reload",
]);

const noResultTools = new Set<ToolName>([
  "tabgoblin_close_tab",
  "tabgoblin_click",
  "tabgoblin_fill",
  "tabgoblin_type",
  "tabgoblin_keypress",
  "tabgoblin_select",
  "tabgoblin_hover",
  "tabgoblin_scroll",
  "tabgoblin_drag",
  "tabgoblin_wait",
  "tabgoblin_upload",
]);

function canonicalImage(result: unknown): { mimeType: "image/png" | "image/jpeg" | "image/webp"; base64: string } | null {
  const parsed = z.object({
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    base64: z.string().min(4).max(Math.floor(SOCKET_RESPONSE_MAX_BYTES * 0.75)),
  }).strict().safeParse(result);
  if (!parsed.success || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(parsed.data.base64)) {
    return null;
  }
  const decoded = Buffer.from(parsed.data.base64, "base64");
  if (decoded.byteLength === 0 || decoded.byteLength > Math.floor(SOCKET_RESPONSE_MAX_BYTES * 0.75)) return null;
  return decoded.toString("base64") === parsed.data.base64 ? parsed.data : null;
}

function inputLimit(input: unknown, key: "maxChars" | "maxEntries"): number | null {
  const value = typeof input === "object" && input !== null ? (input as Record<string, unknown>)[key] : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function renderResult(name: ToolName, response: AdminResponse, input: unknown): BridgeResult {
  if (!response.ok) return errorResult(response.error.code);

  if (name === "tabgoblin_status" || name === "tabgoblin_start") {
    const status = SessionStatusSchema.safeParse(response.status);
    return status.success ? textResult(status.data) : errorResult("runtime_unavailable");
  }
  if (name === "tabgoblin_list_tabs") {
    const tabs = TabSchema.array().max(100).safeParse(response.tabs);
    return tabs.success ? textResult(tabs.data) : errorResult("runtime_unavailable");
  }
  if (name === "tabgoblin_snapshot") {
    const snapshot = SnapshotSchema.safeParse(response.snapshot);
    return snapshot.success ? textResult(snapshot.data) : errorResult("runtime_unavailable");
  }
  if (tabResultTools.has(name)) {
    const tab = TabSchema.safeParse(response.result);
    return tab.success ? textResult(tab.data) : errorResult("runtime_unavailable");
  }
  if (name === "tabgoblin_screenshot") {
    const image = canonicalImage(response.result);
    return image ? { content: [{ type: "image", data: image.base64, mimeType: image.mimeType }] } : errorResult("runtime_unavailable");
  }
  if (name === "tabgoblin_network") {
    const maxEntries = inputLimit(input, "maxEntries");
    const parsed = maxEntries === null ? null : NetworkDiagnosticSchema.array().max(maxEntries).safeParse(response.result);
    return parsed?.success ? textResult(parsed.data) : errorResult("runtime_unavailable");
  }
  if (name === "tabgoblin_text" || name === "tabgoblin_evaluate") {
    const maxChars = inputLimit(input, "maxChars");
    const text = maxChars === null ? null : z.string().max(maxChars).safeParse(response.result);
    return text?.success ? textResult(text.data) : errorResult("runtime_unavailable");
  }
  if (name === "tabgoblin_logs") {
    const maxEntries = inputLimit(input, "maxEntries");
    const logs = maxEntries === null ? null : z.array(z.string().max(242)).max(maxEntries).safeParse(response.result);
    return logs?.success ? textResult(logs.data) : errorResult("runtime_unavailable");
  }
  if (noResultTools.has(name) && response.result === undefined) return textResult(null);
  return errorResult("runtime_unavailable");
}

export function createBridge(deps: BridgeDependencies): {
  callTool(name: ToolName, input: unknown, signal?: AbortSignal): Promise<BridgeResult>;
} {
  return {
    async callTool(name, input, signal) {
      const schema = ToolInputSchemas[name];
      const parsedInput = schema.safeParse(withoutWorkspaceId(input));
      if (!parsedInput.success) return errorResult("invalid_input");

      let binding: Binding;
      try {
        binding = await deps.resolveBinding();
      } catch (error: unknown) {
        return errorResult(codeFrom(error, "not_enrolled"));
      }

      try {
        const request = {
          op: "tool" as const,
          enrollment: deps.enrollment,
          workspaceId: binding.workspaceId,
          name,
          input: parsedInput.data,
          source: "mcp-bridge",
        };
        const response = await (signal ? deps.call(request, signal) : deps.call(request));
        return renderResult(name, AdminResponseSchema.parse(response), parsedInput.data);
      } catch (error: unknown) {
        return errorResult(codeFrom(error, signal?.aborted ? "timeout_uncertain" : "runtime_unavailable"));
      }
    },
  };
}

function socketFailure(code: ErrorCode): never {
  throw tabGoblinError(code, recovery[code], code === "runtime_unavailable");
}

export function createSocketCaller(socketPath: string): BridgeDependencies["call"] {
  return async (payload, signal) => {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    if (body.byteLength > SOCKET_REQUEST_MAX_BYTES) socketFailure("invalid_input");
    // Nothing reached the transport, so an already-cancelled caller has a known outcome.
    if (signal?.aborted) socketFailure("runtime_unavailable");
    const request = AdminRequestSchema.safeParse(payload);
    const socketDeadlineMs = gatewayTransportTimeoutMs(
      request.success ? request.data : { op: "health" },
    );

    return new Promise<AdminResponse>((resolve, reject) => {
      const deadlineAt = performance.now() + socketDeadlineMs;
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const fail = (code: ErrorCode): void => finish(() => reject(tabGoblinError(code, recovery[code], false)));
      const onAbort = (): void => {
        req.destroy();
        fail("timeout_uncertain");
      };
      const timer = setTimeout(() => {
        req.destroy();
        fail("timeout_uncertain");
      }, Math.max(1, deadlineAt - performance.now()));
      const req = httpRequest({
        socketPath,
        path: "/",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": body.byteLength,
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          received += bytes.byteLength;
          if (received > SOCKET_RESPONSE_MAX_BYTES) {
            req.destroy();
            fail("runtime_unavailable");
            return;
          }
          chunks.push(bytes);
        });
        response.once("error", () => fail("runtime_unavailable"));
        response.once("end", () => {
          try {
            const parsed = AdminResponseSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            if (response.statusCode !== 200 && parsed.ok) return fail("runtime_unavailable");
            finish(() => resolve(parsed));
          } catch {
            fail("runtime_unavailable");
          }
        });
      });
      req.once("error", () => fail(signal?.aborted ? "timeout_uncertain" : "runtime_unavailable"));
      signal?.addEventListener("abort", onAbort, { once: true });
      req.end(body);
    });
  };
}

function createProcessBridge(): ReturnType<typeof createBridge> {
  const socketPath = process.env[ADMIN_SOCKET_ENV];
  const enrollment = process.env[ENROLLMENT_ENV];
  if (!socketPath || !enrollment) {
    return createBridge({
      enrollment: "",
      call: async () => socketFailure("not_enrolled"),
      resolveBinding: async () => socketFailure("not_enrolled"),
    });
  }

  const call = createSocketCaller(socketPath);
  let resolvedBinding: Promise<Binding> | undefined;
  const resolveBinding = (): Promise<Binding> => {
    resolvedBinding ??= call({ op: "resolve-enrollment", enrollment }).then((response) => {
      if (!response.ok || !response.binding) socketFailure(response.ok ? "auth_failed" : response.error.code);
      return BindingSchema.parse(response.binding);
    });
    return resolvedBinding;
  };
  return createBridge({ call, enrollment, resolveBinding });
}

export async function runStdioBridge(): Promise<void> {
  const bridge = createProcessBridge();
  const server = new McpServer({ name: MCP_SERVER_NAME, version: "0.1.0" });
  for (const definition of buildToolDefinitions()) {
    const name = definition.name;
    server.registerTool(name, {
      description: definition.description,
      inputSchema: ToolInputSchemas[name],
    }, async (input: unknown, extra: ToolRequestExtra): Promise<CallToolResult> =>
      bridge.callTool(name, input, extra.signal));
  }
  await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: SOCKET_REQUEST_MAX_BYTES }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runStdioBridge().catch(() => {
    process.exitCode = 1;
  });
}
