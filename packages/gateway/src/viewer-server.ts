import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { extname, join } from "node:path";
import type { Duplex } from "node:stream";
import {
  CSRF_HEADER,
  PairRequestSchema,
  PairResponseSchema,
  VIEWER_COOKIE,
  VIEWER_SESSION_TTL_MS,
  ViewerSessionSchema,
  ViewerStatusSchema,
  type ViewerSession,
} from "@tab-goblin/protocol";
import { WebSocket, WebSocketServer } from "ws";
import type { WorkspaceServices } from "./admin-server.js";
import type { PairingCodes } from "./pairing.js";
import { RfbClientStreamGate, RfbProtocolError } from "./rfb-framing.js";

export interface ViewerServerOptions {
  services: WorkspaceServices;
  pairing: PairingCodes;
  port: number;
  staticRoot: string;
  allowedOrigins: string[];
  now?: () => number;
  sessionTtlMs?: number;
  maxSessions?: number;
  maxViewerSocketsPerWorkspace?: number;
  handshakeTimeoutMs?: number;
}

export interface ViewerServer {
  listen(): Promise<number>;
  close(): Promise<void>;
}

interface LiveConnection {
  sessionId: string;
  workspaceId: string;
  gate: RfbClientStreamGate;
  websocket: WebSocket;
  upstream: Socket;
  handshakeTimer: ReturnType<typeof setTimeout>;
  sessionTimer: ReturnType<typeof setTimeout>;
  closing: boolean;
}

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_WEBSOCKET_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 1_024;
const DEFAULT_MAX_VIEWER_SOCKETS = 8;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;
const MAX_UPSTREAM_QUEUE_BYTES = 1024 * 1024;
const RELEASE_WRITE_TIMEOUT_MS = 2_000;
const STATIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/viewer.js", "viewer.js"],
  ["/viewer.css", "viewer.css"],
]);
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
}

function safeEqual(left: string | undefined, right: string): boolean {
  if (typeof left !== "string") return false;
  const leftDigest = Buffer.from(left);
  const rightDigest = Buffer.from(right);
  return leftDigest.length === rightDigest.length && timingSafeEqual(leftDigest, rightDigest);
}

function cookies(request: IncomingMessage): Map<string, string> | null {
  const header = request.headers.cookie;
  if (!header) return new Map();
  const result = new Map<string, string>();
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) return null;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name || !value || result.has(name)) return null;
    result.set(name, value);
  }
  return result;
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'");
  response.setHeader("X-Frame-Options", "SAMEORIGIN");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  securityHeaders(response);
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function reject(response: ServerResponse, status: number): void {
  sendJson(response, status, { ok: false });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new HttpFailure(415);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new HttpFailure(413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpFailure(400);
  }
}

class HttpFailure {
  constructor(readonly status: number) {}
}

function parseConfiguredOrigins(values: string[]): URL[] {
  if (values.length === 0) throw new RangeError("allowedOrigins must not be empty");
  return values.map((value) => {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || url.origin !== value
      || url.username
      || url.password
    ) {
      throw new TypeError("allowedOrigins entries must be exact HTTP origins");
    }
    return url;
  });
}

export function createViewerServer(options: ViewerServerOptions): ViewerServer {
  const port = options.port;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new RangeError("port is invalid");
  const origins = parseConfiguredOrigins(options.allowedOrigins);
  const now = options.now ?? Date.now;
  const sessionTtlMs = positiveSafeInteger(options.sessionTtlMs ?? VIEWER_SESSION_TTL_MS, "sessionTtlMs");
  const maxSessions = positiveSafeInteger(options.maxSessions ?? DEFAULT_MAX_SESSIONS, "maxSessions");
  const maxSockets = positiveSafeInteger(
    options.maxViewerSocketsPerWorkspace ?? DEFAULT_MAX_VIEWER_SOCKETS,
    "maxViewerSocketsPerWorkspace",
  );
  const handshakeTimeoutMs = positiveSafeInteger(
    options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    "handshakeTimeoutMs",
  );

  const sessions = new Map<string, ViewerSession>();
  const connections = new Set<LiveConnection>();
  const transitionLocks = new Map<string, Promise<unknown>>();
  const transitioning = new Set<string>();
  let server: Server | null = null;
  let listeningPort: number | null = null;
  let closing = false;

  const sweepSessions = (): void => {
    const instant = now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= instant) sessions.delete(id);
    }
  };

  const sessionFor = (request: IncomingMessage): ViewerSession | null => {
    sweepSessions();
    const parsed = cookies(request);
    if (!parsed) return null;
    return sessions.get(parsed.get(VIEWER_COOKIE) ?? "") ?? null;
  };

  const hostAllowed = (request: IncomingMessage): boolean => {
    if (typeof request.headers.host !== "string" || request.headers.host.includes(",")) return false;
    const host = request.headers.host.toLowerCase();
    if (listeningPort !== null && host === `127.0.0.1:${listeningPort}`) return true;
    return origins.some((origin) => origin.host.toLowerCase() === host);
  };

  const originAllowed = (request: IncomingMessage): boolean => {
    const value = request.headers.origin;
    if (typeof value !== "string" || value.includes(",")) return false;
    let candidate: URL;
    try {
      candidate = new URL(value);
    } catch {
      return false;
    }
    if (
      candidate.origin !== value
      || candidate.username
      || candidate.password
      || candidate.host.toLowerCase() !== request.headers.host?.toLowerCase()
    ) return false;
    return origins.some((configured) => {
      if (configured.origin === candidate.origin) return true;
      return configured.hostname === "127.0.0.1"
        && candidate.hostname === "127.0.0.1"
        && configured.protocol === candidate.protocol;
    });
  };

  const csrfAllowed = (request: IncomingMessage, session: ViewerSession): boolean => {
    const header = request.headers[CSRF_HEADER];
    return typeof header === "string" && safeEqual(header, session.csrfToken);
  };

  const statusFor = (session: ViewerSession) => {
    const ownership = options.services.ownership(session.workspaceId).snapshot();
    const state = options.services.runtime.state(session.workspaceId);
    return ViewerStatusSchema.parse({
      workspaceId: session.workspaceId,
      sessionState: state,
      ownership: {
        state: ownership.state,
        generation: ownership.generation,
        owner: ownership.owner,
      },
      startedAt: null,
      viewerUrl: state === "ready" ? options.services.viewerUrlFor(session.workspaceId) : null,
      lastError: null,
      isOwner:
        ownership.state === "manual"
        && ownership.ownerViewerSessionId === session.sessionId
        && options.services.ownership(session.workspaceId).mayViewerSendInput(session.sessionId),
    });
  };

  const writeUpstream = (connection: LiveConnection, bytes: Buffer): Promise<void> => {
    if (bytes.length === 0 || connection.upstream.destroyed) return Promise.resolve();
    return new Promise((resolve, rejectWrite) => {
      const timer = setTimeout(() => {
        connection.upstream.destroy();
        rejectWrite(new Error("VNC release write timed out"));
      }, RELEASE_WRITE_TIMEOUT_MS);
      connection.upstream.write(bytes, (error) => {
        clearTimeout(timer);
        if (error) rejectWrite(error);
        else resolve();
      });
    });
  };

  const releaseSessionInput = async (workspaceId: string, sessionId: string): Promise<void> => {
    const writes: Promise<void>[] = [];
    for (const connection of connections) {
      if (connection.workspaceId !== workspaceId || connection.sessionId !== sessionId) continue;
      writes.push(writeUpstream(connection, connection.gate.synthesizeReleases()));
    }
    await Promise.all(writes);
  };

  const transition = async <T>(workspaceId: string, operation: () => Promise<T> | T): Promise<T> => {
    const prior = transitionLocks.get(workspaceId) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(async () => {
      transitioning.add(workspaceId);
      try {
        return await operation();
      } finally {
        transitioning.delete(workspaceId);
      }
    });
    transitionLocks.set(workspaceId, run);
    try {
      return await run;
    } finally {
      if (transitionLocks.get(workspaceId) === run) transitionLocks.delete(workspaceId);
    }
  };

  const closeConnection = async (
    connection: LiveConnection,
    release: boolean,
    terminateWebsocket = false,
  ): Promise<void> => {
    if (connection.closing) {
      if (terminateWebsocket) connection.websocket.terminate();
      return;
    }
    connection.closing = true;
    clearTimeout(connection.handshakeTimer);
    clearTimeout(connection.sessionTimer);
    if (release) {
      await transition(connection.workspaceId, () => releaseSessionInput(connection.workspaceId, connection.sessionId))
        .catch(() => undefined);
    }
    connections.delete(connection);
    connection.upstream.destroy();
    if (terminateWebsocket) connection.websocket.terminate();
    else if (connection.websocket.readyState === WebSocket.OPEN) connection.websocket.close();
  };

  const handleApi = async (request: IncomingMessage, response: ServerResponse, path: string): Promise<void> => {
    if (path === "/api/pair") {
      if (request.method !== "POST") throw new HttpFailure(405);
      if (!originAllowed(request)) throw new HttpFailure(403);
      const parsed = PairRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) throw new HttpFailure(401);
      let redeemed: { workspaceId: string };
      try {
        redeemed = options.pairing.redeem(parsed.data.code);
      } catch {
        throw new HttpFailure(401);
      }
      sweepSessions();
      while (sessions.size >= maxSessions) {
        const oldest = sessions.keys().next();
        if (oldest.done) break;
        sessions.delete(oldest.value);
        await Promise.all(
          [...connections]
            .filter((connection) => connection.sessionId === oldest.value)
            .map((connection) => closeConnection(connection, true)),
        );
      }
      const session = ViewerSessionSchema.parse({
        sessionId: randomBytes(32).toString("base64url"),
        workspaceId: redeemed.workspaceId,
        csrfToken: randomBytes(32).toString("base64url"),
        expiresAt: now() + sessionTtlMs,
      });
      sessions.set(session.sessionId, session);
      response.setHeader(
        "Set-Cookie",
        `${VIEWER_COOKIE}=${session.sessionId}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionTtlMs / 1_000)}`,
      );
      sendJson(response, 200, PairResponseSchema.parse({
        workspaceId: session.workspaceId,
        csrfToken: session.csrfToken,
        viewOnly: true,
      }));
      return;
    }

    const session = sessionFor(request);
    if (!session || !csrfAllowed(request, session)) throw new HttpFailure(403);
    if (request.method === "GET" && path === "/api/status") {
      sendJson(response, 200, statusFor(session));
      return;
    }
    if (request.method !== "POST") throw new HttpFailure(405);
    if (!originAllowed(request)) throw new HttpFailure(403);
    const body = await readJson(request);

    if (path === "/api/take-control") {
      await transition(session.workspaceId, () =>
        options.services.ownership(session.workspaceId).requestTakeControl(session.sessionId));
    } else if (path === "/api/return-to-agent") {
      await transition(session.workspaceId, async () => {
        const ownership = options.services.ownership(session.workspaceId);
        if (!ownership.mayViewerSendInput(session.sessionId)) throw new HttpFailure(409);
        await releaseSessionInput(session.workspaceId, session.sessionId);
        await ownership.returnToAgent();
      });
    } else if (path === "/api/reclaim") {
      if (
        typeof body !== "object"
        || body === null
        || Object.keys(body).length !== 1
        || !("confirm" in body)
        || body.confirm !== true
      ) throw new HttpFailure(400);
      await transition(session.workspaceId, async () => {
        const ownership = options.services.ownership(session.workspaceId);
        const priorOwner = ownership.snapshot().ownerViewerSessionId;
        if (priorOwner) await releaseSessionInput(session.workspaceId, priorOwner);
        ownership.reclaim(session.sessionId);
      });
    } else if (path === "/api/sign-out") {
      await transition(session.workspaceId, async () => {
        await releaseSessionInput(session.workspaceId, session.sessionId);
        sessions.delete(session.sessionId);
        await Promise.all(
          [...connections]
            .filter((connection) => connection.sessionId === session.sessionId)
            .map((connection) => closeConnection(connection, false)),
        );
      });
      response.setHeader(
        "Set-Cookie",
        `${VIEWER_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
      );
    } else {
      throw new HttpFailure(404);
    }

    sendJson(response, 200, statusFor(session));
  };

  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!hostAllowed(request)) {
      reject(response, 403);
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "", "http://viewer.invalid");
    } catch {
      reject(response, 400);
      return;
    }
    try {
      if (url.pathname.startsWith("/api/")) {
        if (url.search) throw new HttpFailure(404);
        await handleApi(request, response, url.pathname);
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") throw new HttpFailure(405);
      const file = STATIC_FILES.get(url.pathname);
      if (!file || url.search) throw new HttpFailure(404);
      const content = await readFile(join(options.staticRoot, file));
      securityHeaders(response);
      response.statusCode = 200;
      response.setHeader("Content-Type", CONTENT_TYPES[extname(file)] ?? "application/octet-stream");
      response.setHeader("Cache-Control", file === "index.html" ? "no-store" : "public, max-age=300");
      response.end(request.method === "HEAD" ? undefined : content);
    } catch (error: unknown) {
      if (error instanceof HttpFailure) reject(response, error.status);
      else reject(response, 503);
    }
  };

  const rejectUpgrade = (socket: Duplex, status: number): void => {
    socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  const listen = async (): Promise<number> => {
    if (server) throw new Error("viewer server is already listening");
    closing = false;
    const httpServer = createServer((request, response) => void handleRequest(request, response));
    const websocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_WEBSOCKET_FRAME_BYTES,
      perMessageDeflate: false,
    });
    server = httpServer;

    httpServer.on("upgrade", (request, socket, head) => {
      if (closing || !hostAllowed(request)) return rejectUpgrade(socket, 403);
      let url: URL;
      try {
        url = new URL(request.url ?? "", "http://viewer.invalid");
      } catch {
        return rejectUpgrade(socket, 400);
      }
      if (url.pathname !== "/ws/vnc" || !originAllowed(request)) return rejectUpgrade(socket, 403);
      const session = sessionFor(request);
      if (!session) return rejectUpgrade(socket, 401);
      const requestedWorkspace = url.searchParams.get("workspaceId");
      if ([...url.searchParams.keys()].some((key) => key !== "workspaceId")) return rejectUpgrade(socket, 400);
      if (requestedWorkspace !== null && requestedWorkspace !== session.workspaceId) {
        return rejectUpgrade(socket, 403);
      }
      const active = [...connections].filter((item) => item.workspaceId === session.workspaceId).length;
      if (active >= maxSockets) return rejectUpgrade(socket, 429);
      const endpoints = options.services.runtime.endpoints(session.workspaceId);
      if (!endpoints || options.services.runtime.state(session.workspaceId) !== "ready") {
        return rejectUpgrade(socket, 503);
      }

      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        const upstream = connect({ host: endpoints.vncHost, port: endpoints.vncPort });
        const gate = new RfbClientStreamGate({ maxBufferedBytes: MAX_WEBSOCKET_FRAME_BYTES });
        const connection = {
          sessionId: session.sessionId,
          workspaceId: session.workspaceId,
          gate,
          websocket,
          upstream,
          handshakeTimer: setTimeout(() => undefined, handshakeTimeoutMs),
          sessionTimer: setTimeout(() => undefined, sessionTtlMs),
          closing: false,
        } satisfies LiveConnection;
        clearTimeout(connection.handshakeTimer);
        clearTimeout(connection.sessionTimer);
        connection.handshakeTimer = setTimeout(() => {
          if (!gate.handshakeComplete) void closeConnection(connection, true);
        }, handshakeTimeoutMs);
        connection.sessionTimer = setTimeout(() => {
          if (websocket.readyState === WebSocket.OPEN) websocket.close(1008, "Viewer session expired");
          void closeConnection(connection, true);
        }, Math.max(1, session.expiresAt - now()));
        connections.add(connection);

        const failProtocol = (): void => {
          if (websocket.readyState === WebSocket.OPEN) websocket.close(1008, "RFB protocol rejected");
          void closeConnection(connection, true);
        };
        upstream.on("data", (data) => {
          try {
            gate.observeServer(data);
            if (gate.handshakeComplete) clearTimeout(connection.handshakeTimer);
            if (websocket.readyState !== WebSocket.OPEN || websocket.bufferedAmount > MAX_UPSTREAM_QUEUE_BYTES) {
              void closeConnection(connection, true);
              return;
            }
            websocket.send(data, { binary: true });
          } catch (error: unknown) {
            if (error instanceof RfbProtocolError) failProtocol();
            else void closeConnection(connection, true);
          }
        });
        upstream.once("error", () => void closeConnection(connection, true));
        upstream.once("close", () => {
          if (websocket.readyState === WebSocket.OPEN) websocket.close(1011, "VNC unavailable");
          void closeConnection(connection, false);
        });
        websocket.on("message", (data, isBinary) => {
          try {
            if (!isBinary || connection.upstream.writableLength > MAX_UPSTREAM_QUEUE_BYTES) {
              throw new RfbProtocolError();
            }
            const ownership = options.services.ownership(session.workspaceId).snapshot();
            const result = gate.pushClient(Buffer.from(data as Buffer), {
              allowed:
                sessions.get(session.sessionId) === session
                && session.expiresAt > now()
                && !transitioning.has(session.workspaceId)
                && options.services.ownership(session.workspaceId).mayViewerSendInput(session.sessionId),
              generation: ownership.generation,
            });
            if (gate.handshakeComplete) clearTimeout(connection.handshakeTimer);
            if (result.forward.length > 0 && !upstream.write(result.forward)) {
              throw new RfbProtocolError("VNC upstream backpressure exceeded");
            }
          } catch (error: unknown) {
            if (error instanceof RfbProtocolError) failProtocol();
            else void closeConnection(connection, true);
          }
        });
        websocket.once("error", () => void closeConnection(connection, true));
        websocket.once("close", () => void closeConnection(connection, true));
      });
    });

    await new Promise<void>((resolve, rejectListen) => {
      httpServer.once("error", rejectListen);
      httpServer.listen(port, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("viewer server address is unavailable");
    listeningPort = address.port;
    return address.port;
  };

  const close = async (): Promise<void> => {
    const current = server;
    if (!current) return;
    closing = true;
    server = null;
    await Promise.all([...connections].map((connection) => closeConnection(connection, true, true)));
    await new Promise<void>((resolve) => {
      current.close(() => resolve());
      current.closeAllConnections();
    });
    sessions.clear();
    listeningPort = null;
  };

  return { listen, close };
}
