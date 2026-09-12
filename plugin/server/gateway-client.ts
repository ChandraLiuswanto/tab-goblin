import { request as httpRequest } from "node:http";
import { performance } from "node:perf_hooks";
import { AdminResponseSchema, PROTOCOL_VERSION, tabGoblinError, type AdminRequest, type AdminResponse } from "@tab-goblin/protocol";

const DEFAULT_TIMEOUT_MS = 10_000;
const NOTIFY_TIMEOUT_MS = 2_000;
const CANDIDATE_PROBE_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function unavailable(): AdminResponse {
  return { ok: false, error: tabGoblinError("runtime_unavailable", "TabGoblin runtime is unavailable") };
}

function isRevokeAcknowledged(response: AdminResponse): response is AdminResponse & { ok: true; lifecycleGeneration: number } {
  if (!response.ok) return false;
  const generation = response.lifecycleGeneration;
  return generation !== undefined && Number.isSafeInteger(generation) && generation >= 0;
}

export interface GatewayClient {
  request(body: AdminRequest, timeoutMs?: number): Promise<AdminResponse>;
  notify(body: AdminRequest): void;
  close(): void;
}

export interface GatewaySwitchHooks {
  /** Persist old-socket revocation intents after candidate health succeeds and before old I/O. */
  beforeRevocations?(): Promise<void>;
  /** Persist acknowledged generations and desired config before the old client is closed. */
  commit?(responses: readonly AdminResponse[]): Promise<void>;
}
export interface GatewaySwitchResult {
  ok: boolean;
  responses: AdminResponse[];
}
export interface GatewayManager extends GatewayClient {
  socketPath(): string;
  /** Probe the candidate, revoke through the old socket, commit, then atomically select it. */
  switchSocketPath(socketPath: string, revocations: readonly AdminRequest[], hooks?: GatewaySwitchHooks, timeoutMs?: number): Promise<GatewaySwitchResult>;
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

/** The active socket changes only after candidate health, old revocation, and durable commit. */
export function createGatewayManager(readSocketPath: () => string): GatewayManager {
  let currentPath = readSocketPath();
  let current = createGatewayClient(currentPath);
  return {
    request: (body, timeout) => current.request(body, timeout),
    notify: (body) => current.notify(body),
    close: () => current.close(),
    socketPath: () => currentPath,
    async switchSocketPath(socketPath, revocations, hooks = {}, timeoutMs) {
      if (socketPath === currentPath) return { ok: true, responses: [] };
      const candidate = createGatewayClient(socketPath);
      const probeTimeout = Math.min(timeoutMs ?? CANDIDATE_PROBE_TIMEOUT_MS, CANDIDATE_PROBE_TIMEOUT_MS);
      const health = await candidate.request({ op: "health" }, probeTimeout);
      if (!health.ok || health.protocolVersion !== PROTOCOL_VERSION || !health.gatewayInstanceId) {
        candidate.close();
        return { ok: false, responses: [] };
      }
      try { await hooks.beforeRevocations?.(); }
      catch {
        candidate.close();
        return { ok: false, responses: [] };
      }
      const responses: AdminResponse[] = [];
      for (const revocation of revocations) responses.push(await current.request(revocation, timeoutMs));
      // A failed old-socket revoke keeps the old client selected and the callback's
      // durable intents anchored to that origin. They are never replayed at the candidate.
      if (responses.some((response) => !isRevokeAcknowledged(response))) {
        candidate.close();
        return { ok: false, responses };
      }
      try { await hooks.commit?.(responses); }
      catch {
        candidate.close();
        return { ok: false, responses };
      }
      const previous = current;
      current = candidate;
      currentPath = socketPath;
      previous.close();
      return { ok: true, responses };
    },
  };
}
