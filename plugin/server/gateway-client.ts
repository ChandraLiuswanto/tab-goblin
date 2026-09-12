import { request as httpRequest } from "node:http";
import { AdminResponseSchema, tabGoblinError, type AdminRequest, type AdminResponse } from "@tab-goblin/protocol";

const DEFAULT_TIMEOUT_MS = 10_000;
const NOTIFY_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function unavailable(): AdminResponse {
  return {
    ok: false,
    error: tabGoblinError("runtime_unavailable", "TabGoblin runtime is unavailable"),
  };
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
      let done = false;
      const finish = (response: AdminResponse) => {
        if (done) return;
        done = true;
        pending.delete(req);
        resolve(response);
      };
      const payload = JSON.stringify(body);
      const req = httpRequest(
        {
          socketPath,
          method: "POST",
          path: "/",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          },
        },
        (response) => {
          let raw = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            raw += chunk;
            if (raw.length > MAX_RESPONSE_BYTES) {
              req.destroy(new Error("gateway response too large"));
            }
          });
          response.on("end", () => {
            try {
              const parsed = AdminResponseSchema.safeParse(JSON.parse(raw));
              finish(parsed.success ? parsed.data : unavailable());
            } catch {
              finish(unavailable());
            }
          });
          response.on("error", () => finish(unavailable()));
        },
      );
      pending.add(req);
      req.setTimeout(timeoutMs, () => req.destroy(new Error("gateway request timed out")));
      req.on("error", () => finish(unavailable()));
      req.write(payload);
      req.end();
    });
  }

  return {
    request,
    notify(body) {
      void request(body, NOTIFY_TIMEOUT_MS).catch(() => undefined);
    },
    close() {
      for (const request of pending) request.destroy();
      pending.clear();
    },
  };
}
