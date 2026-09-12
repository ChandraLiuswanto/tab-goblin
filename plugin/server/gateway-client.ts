import { request as httpRequest } from "node:http";
import { performance } from "node:perf_hooks";
import { AdminResponseSchema, tabGoblinError, type AdminRequest, type AdminResponse } from "@tab-goblin/protocol";

const DEFAULT_TIMEOUT_MS = 10_000;
const NOTIFY_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function unavailable(): AdminResponse {
  return { ok: false, error: tabGoblinError("runtime_unavailable", "TabGoblin runtime is unavailable") };
}

export interface GatewayClient {
  request(body: AdminRequest, timeoutMs?: number): Promise<AdminResponse>;
  notify(body: AdminRequest): void;
  close(): void;
}

export function createGatewayClient(socketPath: string): GatewayClient {
  const pending = new Set<{ destroy(error?: Error): void }>();
  function request(body: AdminRequest, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<AdminResponse> {
    return new Promise((resolve) => {
      const payload = JSON.stringify(body);
      const deadlineAt = performance.now() + timeoutMs;
      let done = false;
      let req: ReturnType<typeof httpRequest>;
      const finish = (response: AdminResponse) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pending.delete(req);
        resolve(response);
      };
      const timer = setTimeout(() => req.destroy(new Error("gateway request timed out")), Math.max(1, deadlineAt - performance.now()));
      req = httpRequest({ socketPath, method: "POST", path: "/", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
          bytes += buffer.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) req.destroy(new Error("gateway response too large"));
          else chunks.push(buffer);
        });
        response.on("end", () => {
          try {
            const parsed = AdminResponseSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            finish(parsed.success ? parsed.data : unavailable());
          } catch { finish(unavailable()); }
        });
        response.on("error", () => finish(unavailable()));
      });
      pending.add(req);
      req.on("error", () => finish(unavailable()));
      req.write(payload);
      req.end();
    });
  }
  return { request, notify(body) { void request(body, NOTIFY_TIMEOUT_MS); }, close() { for (const request of pending) request.destroy(); pending.clear(); } };
}

/** Replaces the socket client lazily after an atomic configuration update. */
export function createGatewayManager(readSocketPath: () => string): GatewayClient {
  let currentPath = "";
  let current: GatewayClient | undefined;
  const client = () => {
    const path = readSocketPath();
    if (!current || path !== currentPath) { current?.close(); currentPath = path; current = createGatewayClient(path); }
    return current;
  };
  return { request: (body, timeout) => client().request(body, timeout), notify: (body) => client().notify(body), close: () => current?.close() };
}
