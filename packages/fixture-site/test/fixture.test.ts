import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureSite } from "../src/server.js";

let site: Awaited<ReturnType<typeof startFixtureSite>>;
const MAX_FIXTURE_BODY_BYTES = 1024 * 1024;

function postChunkedWithDelayedTail(
  url: string,
  body: Buffer,
): Promise<{ status: number; connection: string; delayedWriteAttempted: boolean }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    let responseStarted = false;
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=fixture",
          "transfer-encoding": "chunked",
        },
      },
      (response) => {
        responseStarted = true;
        response.resume();
        response.on("end", () => {
          setTimeout(() => {
            try {
              request.write("delayed-tail");
              request.end();
            } catch {
              // A 413 closes this connection deliberately before a malicious sender can continue.
            }
            resolve({
              status: response.statusCode ?? 0,
              connection: String(response.headers.connection ?? ""),
              delayedWriteAttempted: true,
            });
          }, 25);
        });
      },
    );
    request.on("error", (error) => {
      if (!responseStarted) reject(error);
    });
    request.write(body);
  });
}

beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(async () => {
  await site.close();
});

describe("fixture site", () => {
  it("serves a login form", async () => {
    const body = await (await fetch(site.url + "/login")).text();
    expect(body).toContain('id="username"');
    expect(body).toContain('id="submit"');
  });

  it("refuses the account page without a session", async () => {
    expect((await fetch(site.url + "/account")).status).toBe(401);
  });

  it("issues an HttpOnly session cookie and then serves the account page", async () => {
    const login = await fetch(site.url + "/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=ada&password=lovelace",
      redirect: "manual",
    });
    const cookie = login.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("tg_fixture_session=");
    expect(cookie.toLowerCase()).toContain("httponly");

    const account = await fetch(site.url + "/account", {
      headers: { cookie: cookie.split(";")[0] },
    });
    expect(await account.text()).toContain("Signed in as ada");
  });

  it("delays /slow by the requested amount", async () => {
    const started = Date.now();
    await fetch(site.url + "/slow?ms=300");
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it("rejects oversized declared and chunked POST bodies while accepting valid requests", async () => {
    const upload = await fetch(site.url + "/upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=fixture" },
      body: '--fixture\r\nContent-Disposition: form-data; name="file"; filename="sample.txt"\r\n\r\nabc\r\n--fixture--\r\n',
    });
    expect(upload.status).toBe(200);
    expect(await upload.text()).toContain("sample.txt");

    const oversized = Buffer.alloc(MAX_FIXTURE_BODY_BYTES + 1, "x");
    const declared = await fetch(site.url + "/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": oversized.byteLength.toString(),
      },
      body: oversized,
      redirect: "manual",
    });
    expect(declared.status).toBe(413);

    const chunked = await postChunkedWithDelayedTail(site.url + "/upload", oversized);
    expect(chunked.status).toBe(413);
    expect(chunked.connection.toLowerCase()).toBe("close");
    expect(chunked.delayedWriteAttempted).toBe(true);

    const login = await fetch(site.url + "/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=after-limit&password=fixture-only",
      redirect: "manual",
    });
    expect(login.status).toBe(302);
  });

  it("isolates sessions per fixture instance and clears them on close", async () => {
    const first = await startFixtureSite();
    const second = await startFixtureSite();
    let cookie = "";
    try {
      const login = await fetch(first.url + "/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "username=isolated&password=fixture-only",
        redirect: "manual",
      });
      cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
      expect((await fetch(first.url + "/account", { headers: { cookie } })).status).toBe(200);
      expect((await fetch(second.url + "/account", { headers: { cookie } })).status).toBe(401);
    } finally {
      await second.close();
      await first.close();
    }

    const replacement = await startFixtureSite();
    try {
      expect((await fetch(replacement.url + "/account", { headers: { cookie } })).status).toBe(401);
    } finally {
      await replacement.close();
    }
  });
});
