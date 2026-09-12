import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { errors, type Browser, type BrowserContext, type Page } from "playwright-core";
import { BrowserSession, type RawSnapshot } from "../src/browser.js";
import {
  RuntimeSupervisor,
  volumeNameFor,
  type PodmanExec,
} from "../src/runtime.js";

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

class FakeCDPSession {
  private readonly handlers = new Map<string, Array<(value: any) => void>>();
  currentIndex = 2;
  navigationEvent: "Page.frameNavigated" | "Page.navigatedWithinDocument" | null =
    "Page.frameNavigated";
  readonly entries = [
    { id: 10, url: "https://example.test/first", title: "First" },
    { id: 11, url: "https://example.test/second", title: "Second" },
    { id: 12, url: "https://example.test/third", title: "Third" },
  ];
  readonly send = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "Page.enable") return {};
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.getNavigationHistory") {
      return { currentIndex: this.currentIndex, entries: this.entries };
    }
    if (method === "Page.navigateToHistoryEntry") {
      const index = this.entries.findIndex((entry) => entry.id === params?.entryId);
      if (index >= 0) this.currentIndex = index;
      if (this.navigationEvent === "Page.frameNavigated") {
        this.emit(this.navigationEvent, {
          frame: { id: "main", url: this.entries[this.currentIndex].url },
          type: "BackForwardCacheRestore",
        });
      } else if (this.navigationEvent === "Page.navigatedWithinDocument") {
        this.emit(this.navigationEvent, {
          frameId: "main",
          url: this.entries[this.currentIndex].url,
          navigationType: "historyApi",
        });
      }
      return {};
    }
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelector") return { nodeId: 2 };
    if (method === "DOM.describeNode") {
      return { node: { nodeName: "INPUT", attributes: ["id", "file", "type", "file"] } };
    }
    if (method === "DOM.setFileInputFiles") return {};
    throw new Error(`Unexpected CDP method ${method}`);
  });
  readonly detach = vi.fn(async () => undefined);

  on(event: string, handler: (value: any) => void): this {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  off(event: string, handler: (value: any) => void): this {
    const handlers = this.handlers.get(event) ?? [];
    this.handlers.set(event, handlers.filter((candidate) => candidate !== handler));
    return this;
  }

  emit(event: string, value: any): void {
    for (const handler of this.handlers.get(event) ?? []) handler(value);
  }

  listenerCount(): number {
    return [...this.handlers.values()].reduce((count, handlers) => count + handlers.length, 0);
  }
}

class FakeContext {
  private readonly handlers = new Map<string, Array<(page: Page) => void>>();
  readonly cdp = new FakeCDPSession();
  readonly newCDPSession = vi.fn(async () => this.cdp);

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

  it("preserves newer refs when an older snapshot finishes out of order", async () => {
    const first = new FakePage();
    const second = new FakePage();
    let resolveFirst!: (snapshot: RawSnapshot) => void;
    const delayedFirst = new Promise<RawSnapshot>((resolve) => {
      resolveFirst = resolve;
    });
    first.evaluate.mockImplementationOnce(async () => delayedFirst);
    second.evaluateResults.push(raw(2, "Second"));
    const { session } = sessionWith(first, second);
    const [firstTab, secondTab] = (await session.listTabs()).map(({ tabId }) => tabId);

    const firstSnapshot = session.snapshot(firstTab);
    const secondSnapshot = await session.snapshot(secondTab);
    resolveFirst(raw(1, "First"));

    await expect(firstSnapshot).rejects.toMatchObject({ code: "stale_ref" });
    await expect(
      session.act(secondTab, {
        kind: "click",
        ref: secondSnapshot.nodes[0].ref,
        timeoutMs: 1000,
      }),
    ).resolves.toBeUndefined();
    await expect(
      session.act(firstTab, { kind: "click", ref: "r1-e0", timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "stale_ref" });
    expect(second.locator).toHaveBeenCalledWith('[data-tg-ref="r2-e0"]');
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

  it("bounds text and evaluation results, screenshots, and sends only controlled uploads to Chromium", async () => {
    const page = new FakePage();
    page.bodyText = "a".repeat(200);
    page.evaluateResults.push(raw(1), JSON.stringify({ value: "x".repeat(300) }));
    const { context, session } = sessionWith(page);
    const [{ tabId: tab }] = await session.listTabs();
    const ref = (await session.snapshot(tab)).nodes[0].ref;

    expect(await session.text(tab, 100)).toBe("a".repeat(99) + "…");
    expect(await session.evaluate(tab, "({ ok: true })", 100)).toHaveLength(100);
    expect(await session.screenshot(tab, false)).toEqual({
      mimeType: "image/png",
      base64: Buffer.from("png").toString("base64"),
    });
    await session.upload(tab, ref, "/staging/report.txt");
    expect(context.cdp.send).toHaveBeenCalledWith("DOM.setFileInputFiles", {
      files: ["/staging/report.txt"],
      nodeId: 2,
    });
    expect(page.locatorObject.setInputFiles).not.toHaveBeenCalled();
    expect(context.cdp.detach).toHaveBeenCalledOnce();
  });

  it("requires a fresh ref resolving to an actual file input before CDP upload", async () => {
    const page = new FakePage();
    page.evaluateResults.push(raw(1), raw(2));
    const { context, session } = sessionWith(page);
    const [{ tabId: tab }] = await session.listTabs();
    const ref = (await session.snapshot(tab)).nodes[0].ref;
    context.cdp.send.mockImplementation(async (method: string) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 2 };
      if (method === "DOM.describeNode") return { node: { nodeName: "DIV", attributes: [] } };
      if (method === "DOM.setFileInputFiles") return {};
      throw new Error(`Unexpected CDP method ${method}`);
    });

    await expect(session.upload(tab, ref, "/staging/report.txt")).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(context.cdp.send).not.toHaveBeenCalledWith("DOM.setFileInputFiles", expect.anything());

    await session.snapshot(tab);
    await expect(session.upload(tab, ref, "/staging/report.txt")).rejects.toMatchObject({
      code: "stale_ref",
    });
  });

  it.each(["Page.frameNavigated", "Page.navigatedWithinDocument"] as const)(
    "handles synchronous %s history completion with exactly one CDP mutation",
    async (navigationEvent) => {
      const page = new FakePage();
      const { context, session } = sessionWith(page);
      context.cdp.navigationEvent = navigationEvent;
      const [{ tabId: tab }] = await session.listTabs();

      await expect(session.back(tab, 1000)).resolves.toMatchObject({ tabId: tab });
      expect(context.cdp.send).toHaveBeenCalledWith("Page.navigateToHistoryEntry", {
        entryId: 11,
      });
      expect(
        context.cdp.send.mock.calls.filter(([method]) => method === "Page.navigateToHistoryEntry"),
      ).toHaveLength(1);
      expect(page.goBack).not.toHaveBeenCalled();
      expect(context.cdp.listenerCount()).toBe(0);
      expect(context.cdp.detach).toHaveBeenCalledOnce();
    },
  );

  it("returns a history-boundary no-op without issuing a CDP mutation", async () => {
    const page = new FakePage();
    const { context, session } = sessionWith(page);
    context.cdp.currentIndex = 0;
    const [{ tabId: tab }] = await session.listTabs();

    await expect(session.back(tab, 1000)).resolves.toMatchObject({ tabId: tab });
    expect(context.cdp.send).not.toHaveBeenCalledWith(
      "Page.navigateToHistoryEntry",
      expect.anything(),
    );
    expect(context.cdp.listenerCount()).toBe(0);
  });

  it("cleans CDP history listeners at the deadline without replaying the uncertain mutation", async () => {
    const page = new FakePage();
    const { context, session } = sessionWith(page);
    context.cdp.navigationEvent = null;
    const [{ tabId: tab }] = await session.listTabs();

    await expect(session.back(tab, 1000)).rejects.toMatchObject({
      code: "timeout_uncertain",
      retryable: false,
    });
    expect(context.cdp.listenerCount()).toBe(0);
    expect(context.cdp.detach).toHaveBeenCalledOnce();
    expect(
      context.cdp.send.mock.calls.filter(([method]) => method === "Page.navigateToHistoryEntry"),
    ).toHaveLength(1);
  });

  it("cleans CDP history listeners on abort without replaying the uncertain mutation", async () => {
    const page = new FakePage();
    const { context, session } = sessionWith(page);
    context.cdp.navigationEvent = null;
    const [{ tabId: tab }] = await session.listTabs();
    const controller = new AbortController();
    const navigation = session.back(tab, 30_000, controller.signal);
    await vi.waitFor(() => {
      expect(context.cdp.send).toHaveBeenCalledWith("Page.navigateToHistoryEntry", {
        entryId: 11,
      });
    });
    controller.abort();

    await expect(navigation).rejects.toMatchObject({ code: "timeout_uncertain", retryable: false });
    await vi.waitFor(() => expect(context.cdp.listenerCount()).toBe(0));
    expect(
      context.cdp.send.mock.calls.filter(([method]) => method === "Page.navigateToHistoryEntry"),
    ).toHaveLength(1);
  });

  it("uses bounded session-scoped tab IDs that cannot alias on fresh attachment", async () => {
    const first = sessionWith(new FakePage()).session;
    const second = sessionWith(new FakePage()).session;
    const [firstId] = (await first.listTabs()).map(({ tabId }) => tabId);
    const [secondId] = (await second.listTabs()).map(({ tabId }) => tabId);

    expect(firstId).not.toBe(secondId);
    expect(firstId).toMatch(/^t[0-9a-f-]+-1$/);
    expect(secondId).toMatch(/^t[0-9a-f-]+-1$/);
    expect(firstId.length).toBeLessThanOrEqual(64);
    expect(secondId.length).toBeLessThanOrEqual(64);
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

  it("sanitizes plain Playwright errors thrown by an action", async () => {
    const page = new FakePage();
    page.evaluateResults.push(raw(1));
    page.locatorObject.click.mockRejectedValueOnce(
      new Error("Execution context destroyed with secret=action-token"),
    );
    const { session } = sessionWith(page);
    const [{ tabId: tab }] = await session.listTabs();
    const ref = (await session.snapshot(tab)).nodes[0].ref;

    const failure = await session
      .act(tab, { kind: "click", ref, timeoutMs: 1000 })
      .catch((error: unknown) => error);

    expect(failure).toEqual({
      code: "runtime_unavailable",
      message: "The browser operation failed",
      retryable: false,
    });
    expect(JSON.stringify(failure)).not.toContain("action-token");
  });

  it("sanitizes plain Playwright errors while reading tab metadata", async () => {
    const page = new FakePage();
    page.title = vi.fn(async () => {
      throw new Error("Target closed at ws://secret-cdp-endpoint");
    });
    const { session } = sessionWith(page);

    const failure = await session.listTabs().catch((error: unknown) => error);

    expect(failure).toEqual({
      code: "runtime_unavailable",
      message: "The browser operation failed",
      retryable: false,
    });
    expect(JSON.stringify(failure)).not.toContain("secret-cdp-endpoint");
  });

  it("sanitizes a plain Playwright error while closing the browser", async () => {
    const page = new FakePage();
    const { browser, session } = sessionWith(page);
    browser.close.mockRejectedValueOnce(new Error("close failed for /profile/private"));

    const failure = await session.close().catch((error: unknown) => error);

    expect(failure).toEqual({
      code: "runtime_unavailable",
      message: "The browser operation failed",
      retryable: false,
    });
    expect(JSON.stringify(failure)).not.toContain("/profile/private");
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

interface PodmanResult {
  code: number;
  stdout: string;
  stderr: string;
}

const LIVE_IMAGE = process.env.TABGOBLIN_IMAGE;
const describeLive = LIVE_IMAGE ? describe : describe.skip;
const LIVE_FIXTURE_PORT = 18_080;
const MAX_PODMAN_OUTPUT = 1024 * 1024;

const realPodman: PodmanExec = (args, signal) =>
  new Promise<PodmanResult>((resolve, reject) => {
    const child = spawn("podman", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let spawnError: Error | null = null;
    const append = (current: string, chunk: Buffer): string =>
      (current + chunk.toString("utf8")).slice(-MAX_PODMAN_OUTPUT);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    const abort = () => child.kill("SIGTERM");
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("Podman command aborted"));
      } else if (spawnError) {
        reject(spawnError);
      } else {
        resolve({ code: code ?? 1, stdout, stderr });
      }
    });
  });

async function requirePodman(args: string[]): Promise<PodmanResult> {
  const result = await realPodman(args);
  if (result.code !== 0) {
    throw new Error(`podman ${args[0]} failed: ${result.stderr.slice(-1000)}`);
  }
  return result;
}

async function installFixtureInRuntime(containerName: string, temporaryDirectory: string): Promise<void> {
  const fixtureSourcePath = fileURLToPath(
    new URL("../../fixture-site/src/server.ts", import.meta.url),
  );
  const fixtureSource = await readFile(fixtureSourcePath, "utf8");
  const fixtureJavaScript = transpileModule(fixtureSource, {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2023 },
    fileName: fixtureSourcePath,
  }).outputText;
  const fixturePath = join(temporaryDirectory, "fixture-server.mjs");
  const runnerPath = join(temporaryDirectory, "fixture-runner.mjs");
  await Promise.all([
    writeFile(fixturePath, fixtureJavaScript),
    writeFile(
      runnerPath,
      `import { startFixtureSite } from "/tmp/tabgoblin-fixture-server.mjs";\n` +
        `await startFixtureSite(${LIVE_FIXTURE_PORT});\n`,
    ),
  ]);

  await requirePodman(["cp", process.execPath, `${containerName}:/tmp/tabgoblin-live-node`]);
  const libatomic = /^\s*libatomic\.so\.1\s+=>\s+(\S+)/m.exec(
    execFileSync("ldd", [process.execPath], { encoding: "utf8" }),
  )?.[1];
  if (libatomic) {
    await requirePodman([
      "cp",
      realpathSync(libatomic),
      `${containerName}:/tmp/libatomic.so.1`,
    ]);
  }
  await requirePodman(["cp", fixturePath, `${containerName}:/tmp/tabgoblin-fixture-server.mjs`]);
  await requirePodman(["cp", runnerPath, `${containerName}:/tmp/tabgoblin-fixture-runner.mjs`]);
  await requirePodman([
    "exec",
    "-d",
    containerName,
    "sh",
    "-c",
    "LD_LIBRARY_PATH=/tmp /tmp/tabgoblin-live-node /tmp/tabgoblin-fixture-runner.mjs >/tmp/tabgoblin-fixture.log 2>&1",
  ]);

  const fixtureUrl = `http://127.0.0.1:${LIVE_FIXTURE_PORT}/`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const probe = await realPodman([
      "exec",
      "--env",
      "LD_LIBRARY_PATH=/tmp",
      containerName,
      "/tmp/tabgoblin-live-node",
      "-e",
      `fetch(${JSON.stringify(fixtureUrl)}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))`,
    ]);
    if (probe.code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const diagnostics = await realPodman([
    "exec",
    containerName,
    "sh",
    "-c",
    "tail -c 2000 /tmp/tabgoblin-fixture.log 2>/dev/null || true",
  ]);
  throw new Error(
    `The isolated fixture server did not become ready: ${diagnostics.stdout.trim() || "no diagnostics"}`,
  );
}

describeLive(
  `BrowserSession live runtime${LIVE_IMAGE ? "" : " (skipped: set TABGOBLIN_IMAGE)"}`,
  () => {
    let supervisor: RuntimeSupervisor | undefined;
    let session: BrowserSession | undefined;
    let containerName: string | undefined;
    let temporaryDirectory: string | undefined;
    const workspaceId = `t6-live-${randomUUID()}`;
    const profileVolume = volumeNameFor(workspaceId);
    const fixtureUrl = `http://127.0.0.1:${LIVE_FIXTURE_PORT}`;

    beforeAll(async () => {
      temporaryDirectory = await mkdtemp(join(tmpdir(), "tabgoblin-t6-live-"));
      supervisor = new RuntimeSupervisor({
        image: LIVE_IMAGE!,
        podman: realPodman,
        probe: async (cdpUrl, signal) => {
          try {
            return (await fetch(`${cdpUrl}/json/version`, { signal })).ok;
          } catch {
            return false;
          }
        },
      });
      const endpoints = await supervisor.start(workspaceId);
      containerName = endpoints.containerName;
      expect(endpoints.volumeName).toBe(profileVolume);
      await installFixtureInRuntime(containerName, temporaryDirectory);
      session = await BrowserSession.attach(endpoints.cdpUrl);
    }, 120_000);

    afterAll(async () => {
      const cleanupErrors: unknown[] = [];
      await session?.close().catch((error: unknown) => cleanupErrors.push(error));
      await supervisor?.stop(workspaceId).catch((error: unknown) => cleanupErrors.push(error));
      const volumes = await realPodman([
        "volume",
        "rm",
        "--force",
        profileVolume,
        `${profileVolume}-staging`,
      ]).catch((error: unknown) => {
        cleanupErrors.push(error);
        return null;
      });
      if (volumes && volumes.code !== 0) cleanupErrors.push(new Error("volume cleanup failed"));
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch((error: unknown) =>
          cleanupErrors.push(error),
        );
      }
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Live cleanup failed");
    }, 120_000);

    it("opens the isolated fixture, uses real DOM refs, and submits login", async () => {
      const tab = await session!.newTab(`${fixtureUrl}/login`);
      const snapshot = await session!.snapshot(tab.tabId);
      const username = snapshot.nodes.find((node) => node.name.toLowerCase() === "username")!;
      const submit = snapshot.nodes.find(
        (node) => node.name === "Sign in" && node.role === "button",
      )!;

      expect(username).toBeTruthy();
      expect(submit).toBeTruthy();
      await session!.act(tab.tabId, {
        kind: "fill",
        ref: username.ref,
        value: "ada",
        timeoutMs: 5000,
      });
      await session!.act(tab.tabId, {
        kind: "click",
        ref: submit.ref,
        timeoutMs: 5000,
      });
      expect(await session!.text(tab.tabId, 1000)).toContain("Signed in as ada");
    });

    it("rejects a real ref from an earlier snapshot revision", async () => {
      const tab = await session!.newTab(`${fixtureUrl}/login`);
      const first = await session!.snapshot(tab.tabId);
      await session!.snapshot(tab.tabId);

      await expect(
        session!.act(tab.tabId, {
          kind: "click",
          ref: first.nodes[0].ref,
          timeoutMs: 2000,
        }),
      ).rejects.toMatchObject({ code: "stale_ref" });
    });

    it("returns validated redacted network metadata from the real fixture", async () => {
      const tab = await session!.newTab(`${fixtureUrl}/login?token=secret#fragment`);
      const login = session!
        .network(tab.tabId, 100)
        .find((entry) => entry.method === "GET" && entry.url === `${fixtureUrl}/login`);

      expect(login).toEqual({ method: "GET", url: `${fixtureUrl}/login`, status: 200 });
      expect(JSON.stringify(session!.network(tab.tabId, 100))).not.toContain("secret");
    });

    it("rejects non-http navigation before reaching Chromium", async () => {
      const tab = await session!.newTab(`${fixtureUrl}/`);
      await expect(
        session!.navigate(tab.tabId, "file:///etc/passwd", 5000),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });

    it("reports a real slow navigation as timeout_uncertain without retrying", async () => {
      const tab = await session!.newTab(`${fixtureUrl}/`);
      await expect(
        session!.navigate(tab.tabId, `${fixtureUrl}/slow?ms=5000`, 1000),
      ).rejects.toMatchObject({ code: "timeout_uncertain", retryable: false });
    });

    it("retains fixture login cookies after closing and reopening tabs", async () => {
      const first = await session!.newTab(`${fixtureUrl}/login`);
      const snapshot = await session!.snapshot(first.tabId);
      await session!.act(first.tabId, {
        kind: "fill",
        ref: snapshot.nodes.find((node) => node.name.toLowerCase() === "username")!.ref,
        value: "grace",
        timeoutMs: 5000,
      });
      await session!.act(first.tabId, {
        kind: "click",
        ref: snapshot.nodes.find((node) => node.role === "button")!.ref,
        timeoutMs: 5000,
      });
      await session!.closeTab(first.tabId);

      const second = await session!.newTab(`${fixtureUrl}/account`);
      expect(await session!.text(second.tabId, 1000)).toContain("Signed in as grace");
    });

    it("completes meaningful static history back and forward in the real runtime", async () => {
      const tab = await session!.newTab(`${fixtureUrl}/`);
      await session!.navigate(tab.tabId, `${fixtureUrl}/login`, 5000);
      await session!.navigate(tab.tabId, `${fixtureUrl}/upload`, 5000);

      await expect(session!.back(tab.tabId, 5000)).resolves.toMatchObject({
        title: "Sign in",
        url: `${fixtureUrl}/login`,
      });
      await expect(session!.forward(tab.tabId, 5000)).resolves.toMatchObject({
        title: "Upload",
        url: `${fixtureUrl}/upload`,
      });
    });

    it("uploads a file staged inside the real rootless container", async () => {
      const hostPath = join(temporaryDirectory!, "meaningful-upload.txt");
      await writeFile(hostPath, "rootless container upload\n");
      await requirePodman([
        "cp",
        hostPath,
        `${containerName}:/staging/meaningful-upload.txt`,
      ]);
      const tab = await session!.newTab(`${fixtureUrl}/upload`);
      const snapshot = await session!.snapshot(tab.tabId);
      const file = snapshot.nodes.find((node) => node.name === "file")!;
      const send = snapshot.nodes.find((node) => node.name === "Send")!;

      expect(file).toBeTruthy();
      expect(send).toBeTruthy();
      await session!.upload(tab.tabId, file.ref, "/staging/meaningful-upload.txt");
      await session!.act(tab.tabId, {
        kind: "click",
        ref: send.ref,
        timeoutMs: 5000,
      });
      expect(await session!.text(tab.tabId, 1000)).toContain("meaningful-upload.txt");
    });

    it("never aliases tab IDs after a fresh attachment to the real runtime", async () => {
      const oldIds = new Set((await session!.listTabs()).map(({ tabId }) => tabId));
      const fresh = await BrowserSession.attach((await supervisor!.start(workspaceId)).cdpUrl);
      const freshIds = (await fresh.listTabs()).map(({ tabId }) => tabId);

      expect(freshIds.length).toBeGreaterThan(0);
      expect(freshIds.every((tabId) => !oldIds.has(tabId))).toBe(true);
      await session!.close();
      session = fresh;
    });
  },
);
