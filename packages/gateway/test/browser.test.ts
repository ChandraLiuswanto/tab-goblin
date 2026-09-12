import { describe, expect, it, vi } from "vitest";
import { errors, type Browser, type BrowserContext, type Page } from "playwright-core";
import { BrowserSession, type RawSnapshot } from "../src/browser.js";

class FakeLocator {
  count = vi.fn(async () => 1);
  click = vi.fn(async () => undefined);
  fill = vi.fn(async () => undefined);
  pressSequentially = vi.fn(async () => undefined);
  selectOption = vi.fn(async () => []);
  hover = vi.fn(async () => undefined);
  dragTo = vi.fn(async () => undefined);
  setInputFiles = vi.fn(async () => undefined);
  first = vi.fn(() => this);
  waitFor = vi.fn(async () => undefined);
}

class FakePage {
  private readonly handlers = new Map<string, Array<(value: unknown) => void>>();
  readonly locatorObject = new FakeLocator();
  readonly locator = vi.fn(() => this.locatorObject);
  readonly getByText = vi.fn(() => this.locatorObject);
  readonly keyboard = { press: vi.fn(async () => undefined) };
  readonly mouse = { wheel: vi.fn(async () => undefined) };
  readonly goto = vi.fn(async (url: string) => {
    this.currentUrl = url;
    return null;
  });
  readonly goBack = vi.fn(async () => null);
  readonly goForward = vi.fn(async () => null);
  readonly reload = vi.fn(async () => null);
  readonly waitForLoadState = vi.fn(async () => undefined);
  readonly innerText = vi.fn(async () => this.bodyText);
  readonly screenshot = vi.fn(async () => Buffer.from("png"));
  readonly bringToFront = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => {
    this.closed = true;
    this.emit("close", undefined);
  });
  readonly evaluate = vi.fn(async () => {
    const next = this.evaluateResults.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  readonly evaluateResults: unknown[] = [];
  readonly mainFrameObject = {};
  bodyText = "";
  currentTitle = "Fixture";
  currentUrl = "https://example.test/";
  closed = false;

  on(event: string, handler: (value: unknown) => void): this {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  emit(event: string, value: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(value);
  }

  mainFrame(): object {
    return this.mainFrameObject;
  }

  title(): Promise<string> {
    return Promise.resolve(this.currentTitle);
  }

  url(): string {
    return this.currentUrl;
  }

  isClosed(): boolean {
    return this.closed;
  }
}

class FakeContext {
  private readonly handlers = new Map<string, Array<(page: Page) => void>>();

  constructor(readonly pageList: FakePage[]) {}

  pages(): Page[] {
    return this.pageList as unknown as Page[];
  }

  on(event: string, handler: (page: Page) => void): this {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  async newPage(): Promise<Page> {
    const page = new FakePage();
    this.pageList.push(page);
    for (const handler of this.handlers.get("page") ?? []) handler(page as unknown as Page);
    return page as unknown as Page;
  }
}

function raw(revision: number, name = "Go"): RawSnapshot {
  return {
    revision,
    url: "https://example.test/?token=secret",
    title: "Fixture",
    nodes: [{ index: 0, role: "button", name, depth: 0 }],
  };
}

function sessionWith(...pages: FakePage[]): {
  session: BrowserSession;
  browser: Browser;
  context: FakeContext;
} {
  const context = new FakeContext(pages);
  const browser = { close: vi.fn(async () => undefined) } as unknown as Browser;
  return {
    session: new BrowserSession(browser, context as unknown as BrowserContext),
    browser,
    context,
  };
}

describe("BrowserSession at the Playwright boundary", () => {
  it("keeps bounded console and body-free, redacted network diagnostic rings", async () => {
    const page = new FakePage();
    const { session } = sessionWith(page);
    const [{ tabId: tab }] = await session.listTabs();

    for (let index = 0; index < 101; index += 1) {
      page.emit("console", {
        type: () => "log",
        text: () => `${index}:` + "x".repeat(500),
      });
    }
    const body = vi.fn(() => Buffer.from("secret body"));
    for (let index = 0; index < 105; index += 1) {
      page.emit("response", {
        request: () => ({ method: () => "GET", headers: () => ({ authorization: "secret" }) }),
        url: () => `https://user:pw@example.test/${index}?token=secret#fragment`,
        status: () => 200,
        body,
      });
    }

    await expect(session.logs(tab, 100)).resolves.toHaveLength(100);
    await expect(session.logs(tab, 1)).resolves.toEqual([
      "log: 100:" + "x".repeat(195) + "…",
    ]);
    expect(session.network(tab, 2)).toEqual([
      { method: "GET", url: "https://example.test/103", status: 200 },
      { method: "GET", url: "https://example.test/104", status: 200 },
    ]);
    expect(Object.keys(session.network(tab, 1)[0])).toEqual(["method", "url", "status"]);
    expect(JSON.stringify(session.network(tab, 100))).not.toContain("secret");
    expect(body).not.toHaveBeenCalled();
  });

  it("enforces both snapshot generation and owning tab before touching a locator", async () => {
    const first = new FakePage();
    const second = new FakePage();
    first.evaluateResults.push(raw(1));
    second.evaluateResults.push(raw(3));
    const { session } = sessionWith(first, second);
    const [firstTab, secondTab] = (await session.listTabs()).map(({ tabId }) => tabId);

    const firstSnapshot = await session.snapshot(firstTab);
    await expect(
      session.act(secondTab, { kind: "click", ref: firstSnapshot.nodes[0].ref, timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "stale_ref" });
    expect(second.locator).not.toHaveBeenCalled();

    first.emit("framenavigated", first.mainFrame());
    await expect(
      session.act(firstTab, { kind: "click", ref: firstSnapshot.nodes[0].ref, timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "stale_ref" });

    await session.snapshot(secondTab);
    await expect(
      session.act(firstTab, { kind: "click", ref: firstSnapshot.nodes[0].ref, timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "stale_ref" });
    expect(first.locator).not.toHaveBeenCalled();
  });

  it("executes guarded actions with opaque, revision-scoped selectors", async () => {
    const page = new FakePage();
    page.evaluateResults.push(raw(1));
    const { session } = sessionWith(page);
    const [{ tabId: tab }] = await session.listTabs();
    const ref = (await session.snapshot(tab)).nodes[0].ref;

    await session.act(tab, { kind: "fill", ref, value: "ada", timeoutMs: 1000 });
    await session.act(tab, { kind: "type", ref, text: " lovelace", timeoutMs: 1000 });
    await session.act(tab, { kind: "select", ref, values: ["one"], timeoutMs: 1000 });
    await session.act(tab, { kind: "hover", ref, timeoutMs: 1000 });
    await session.act(tab, { kind: "keypress", key: "Enter", timeoutMs: 1000 });
    await session.act(tab, { kind: "scroll", dx: 1, dy: -2 });
    await session.act(tab, { kind: "drag", fromRef: ref, toRef: ref, timeoutMs: 1000 });
    await session.act(tab, { kind: "wait", condition: "text", text: "Done", timeoutMs: 1000 });

    expect(page.locator).toHaveBeenCalledWith('[data-tg-ref="r1-e0"]');
    expect(page.locatorObject.fill).toHaveBeenCalledWith(
      "ada",
      expect.objectContaining({ timeout: expect.closeTo(999, 1) }),
    );
    expect(page.locatorObject.pressSequentially).toHaveBeenCalledWith(" lovelace");
    expect(page.keyboard.press).toHaveBeenCalledWith("Enter");
    expect(page.mouse.wheel).toHaveBeenCalledWith(1, -2);
    expect(page.getByText).toHaveBeenCalledWith("Done", { exact: false });
  });

  it("rejects invalid action, evaluation, navigation and staging arguments early", async () => {
    const page = new FakePage();
    const { session } = sessionWith(page);
    const [{ tabId: tab }] = await session.listTabs();

    await expect(session.navigate(tab, "file:///etc/passwd", 1000)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      session.act(tab, { kind: "keypress", key: "", timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      session.act(tab, { kind: "wait", condition: "text", timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(session.evaluate(tab, "x".repeat(2001), 2000)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(session.upload(tab, "r1-e0", "/staging/../etc/passwd")).rejects.toMatchObject({
      code: "invalid_input",
    });

    expect(page.goto).not.toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(page.locator).not.toHaveBeenCalled();
  });

  it("bounds text and evaluation results, screenshots, and accepts only controlled uploads", async () => {
    const page = new FakePage();
    page.bodyText = "a".repeat(200);
    page.evaluateResults.push(raw(1), JSON.stringify({ value: "x".repeat(300) }));
    const { session } = sessionWith(page);
    const [{ tabId: tab }] = await session.listTabs();
    const ref = (await session.snapshot(tab)).nodes[0].ref;

    expect(await session.text(tab, 100)).toBe("a".repeat(99) + "…");
    expect(await session.evaluate(tab, "({ ok: true })", 100)).toHaveLength(100);
    expect(await session.screenshot(tab, false)).toEqual({
      mimeType: "image/png",
      base64: Buffer.from("png").toString("base64"),
    });
    await session.upload(tab, ref, "/staging/report.txt");
    expect(page.locatorObject.setInputFiles).toHaveBeenCalledWith("/staging/report.txt");
  });

  it("maps Playwright timeouts once without retrying or exposing raw errors", async () => {
    const page = new FakePage();
    page.goto.mockRejectedValueOnce(new errors.TimeoutError("secret upstream details"));
    const { session } = sessionWith(page);
    const [{ tabId: tab }] = await session.listTabs();

    await expect(
      session.navigate(tab, "https://example.test/slow", 1000),
    ).rejects.toMatchObject({ code: "timeout_uncertain", retryable: false });
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  it("honors AbortSignal before and during a mutating monotonic deadline", async () => {
    const page = new FakePage();
    const { session } = sessionWith(page);
    const [{ tabId: tab }] = await session.listTabs();
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();

    await expect(
      session.navigate(tab, "https://example.test/never", 1000, alreadyAborted.signal),
    ).rejects.toMatchObject({ code: "timeout_uncertain", retryable: false });
    expect(page.goto).not.toHaveBeenCalled();

    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    page.goto.mockImplementationOnce(async () => {
      started();
      return new Promise<never>(() => undefined);
    });
    const controller = new AbortController();
    const navigation = session.navigate(
      tab,
      "https://example.test/pending",
      30_000,
      controller.signal,
    );
    await startedPromise;
    controller.abort();

    await expect(navigation).rejects.toMatchObject({ code: "timeout_uncertain", retryable: false });
    expect(page.goto).toHaveBeenCalledTimes(1);
  });
});
