import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureSite } from "../src/server.js";

let site: Awaited<ReturnType<typeof startFixtureSite>>;

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
});
