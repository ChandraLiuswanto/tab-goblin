import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";

const sessions = new Map<string, string>();

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function cookieOf(request: IncomingMessage, name: string): string | null {
  const raw = request.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [key, value] = part.trim().split("=");
    if (key === name) return value ?? null;
  }
  return null;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function slowDelay(value: string | null): number {
  const requested = Number(value ?? "0");
  if (!Number.isFinite(requested)) return 0;
  return Math.min(Math.max(0, Math.floor(requested)), 10_000);
}

export async function startFixtureSite(
  port = 0,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      response.writeHead(500).end("error");
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: bound } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${bound}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const send = (status: number, html: string, headers: Record<string, string> = {}): void => {
    response.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers }).end(html);
  };

  if (url.pathname === "/" && request.method === "GET") {
    return send(200, page("Home", '<h1>Fixture</h1><a id="to-login" href="/login">Sign in</a>'));
  }
  if (url.pathname === "/login" && request.method === "GET") {
    return send(
      200,
      page(
        "Sign in",
        '<form method="post" action="/login">' +
          '<label for="username">Username</label><input id="username" name="username">' +
          '<label for="password">Password</label><input id="password" name="password" type="password">' +
          '<button id="submit" type="submit">Sign in</button></form>',
      ),
    );
  }
  if (url.pathname === "/login" && request.method === "POST") {
    const form = new URLSearchParams((await readBody(request)).toString("utf8"));
    const username = form.get("username") ?? "anonymous";
    const sessionId = randomUUID();
    sessions.set(sessionId, username);
    return send(302, "", {
      "set-cookie": `tg_fixture_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax`,
      location: "/account",
    });
  }
  if (url.pathname === "/account" && request.method === "GET") {
    const sessionId = cookieOf(request, "tg_fixture_session");
    const username = sessionId ? sessions.get(sessionId) : undefined;
    if (!username) return send(401, page("Denied", "<h1>Not signed in</h1>"));
    return send(200, page("Account", `<h1 id="who">Signed in as ${escapeHtml(username)}</h1>`));
  }
  if (url.pathname === "/logout" && request.method === "POST") {
    const sessionId = cookieOf(request, "tg_fixture_session");
    if (sessionId) sessions.delete(sessionId);
    return send(302, "", { location: "/" });
  }
  if (url.pathname === "/slow" && request.method === "GET") {
    const ms = slowDelay(url.searchParams.get("ms"));
    await new Promise((resolve) => setTimeout(resolve, ms));
    return send(200, page("Slow", `<p id="slow">waited ${ms}</p>`));
  }
  if (url.pathname === "/upload" && request.method === "GET") {
    return send(
      200,
      page(
        "Upload",
        '<form method="post" action="/upload" enctype="multipart/form-data">' +
          '<input id="file" name="file" type="file">' +
          '<button id="send" type="submit">Send</button></form>',
      ),
    );
  }
  if (url.pathname === "/upload" && request.method === "POST") {
    const body = await readBody(request);
    const name = /filename="([^"]*)"/.exec(body.toString("latin1"))?.[1] ?? "";
    return send(200, page("Uploaded", `<p id="uploaded">${escapeHtml(name)} ${body.length}</p>`));
  }
  return send(404, page("Missing", "<h1>404</h1>"));
}
