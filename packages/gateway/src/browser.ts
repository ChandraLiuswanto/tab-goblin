import { posix as path } from "node:path";
import { performance } from "node:perf_hooks";
import {
  NETWORK_DIAGNOSTIC_LIMIT,
  NetworkDiagnosticSchema,
  SnapshotSchema,
  TabGoblinErrorSchema,
  TabSchema,
  boundedText,
  formatRef,
  isNavigableUrl,
  parseRef,
  redactUrl,
  tabGoblinError,
  type NetworkDiagnostic,
  type Snapshot,
  type Tab,
  type TabGoblinError,
} from "@tab-goblin/protocol";
import {
  chromium,
  errors,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright-core";
import { SNAPSHOT_SCRIPT, type RawSnapshot, type RawSnapshotNode } from "./snapshot-script.js";

export type { RawSnapshot, RawSnapshotNode } from "./snapshot-script.js";

export type BrowserAction =
  | { kind: "click"; ref: string; timeoutMs: number }
  | { kind: "fill"; ref: string; value: string; timeoutMs: number }
  | { kind: "type"; ref: string; text: string; timeoutMs: number }
  | { kind: "keypress"; key: string; timeoutMs: number }
  | { kind: "select"; ref: string; values: string[]; timeoutMs: number }
  | { kind: "hover"; ref: string; timeoutMs: number }
  | { kind: "scroll"; dx: number; dy: number }
  | { kind: "drag"; fromRef: string; toRef: string; timeoutMs: number }
  | { kind: "wait"; condition: "load" | "text"; text?: string; timeoutMs: number };

interface TabState {
  readonly id: string;
  readonly page: Page;
  readonly logs: string[];
  readonly network: NetworkDiagnostic[];
}

const DEFAULT_TIMEOUT_MS = 10_000;
const RAW_FIELD_LIMIT = 4096;
const MAX_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1000;
const MAX_SCROLL_DELTA = 100_000;
const TAB_ID_LIMIT = 64;

function invalid(message: string): TabGoblinError {
  return tabGoblinError("invalid_input", message, false);
}

function uncertain(): TabGoblinError {
  return tabGoblinError(
    "timeout_uncertain",
    "The browser operation timed out; inspect current state before retrying",
    false,
  );
}

function isStructuredError(value: unknown): value is TabGoblinError {
  return TabGoblinErrorSchema.safeParse(value).success;
}

function requireString(value: unknown, name: string, max: number, allowEmpty = true): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > max) {
    throw invalid(`${name} is invalid`);
  }
  return value;
}

function requireInteger(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw invalid(`${name} is invalid`);
  }
  return value as number;
}

function requireTimeout(value: unknown): number {
  return requireInteger(value, "timeoutMs", MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
}

function requireMaxEntries(value: unknown): number {
  return requireInteger(value, "maxEntries", 1, NETWORK_DIAGNOSTIC_LIMIT);
}

function requireRef(value: unknown, name = "ref"): string {
  const ref = requireString(value, name, 64, false);
  if (!parseRef(ref)) throw invalid(`${name} is invalid`);
  return ref;
}

function requireNavigableUrl(value: unknown): string {
  const url = requireString(value, "url", 2048, false);
  if (!isNavigableUrl(url)) throw invalid("Only http: and https: URLs are allowed");
  return url;
}

function requireExactKeys(value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw invalid("The browser action contains unexpected or missing fields");
  }
}

function validateRawSnapshot(raw: RawSnapshot): void {
  if (!raw || typeof raw !== "object") throw invalid("The page returned an invalid snapshot");
  if (!Number.isSafeInteger(raw.revision) || raw.revision <= 0) {
    throw invalid("The page returned an invalid snapshot revision");
  }
  if (
    typeof raw.url !== "string" ||
    raw.url.length > RAW_FIELD_LIMIT ||
    typeof raw.title !== "string" ||
    raw.title.length > RAW_FIELD_LIMIT ||
    !Array.isArray(raw.nodes) ||
    raw.nodes.length > 2000
  ) {
    throw invalid("The page returned an invalid or oversized snapshot");
  }

  raw.nodes.forEach((node, position) => {
    if (
      !node ||
      typeof node !== "object" ||
      node.index !== position ||
      typeof node.role !== "string" ||
      node.role.length > RAW_FIELD_LIMIT ||
      typeof node.name !== "string" ||
      node.name.length > RAW_FIELD_LIMIT ||
      (node.value !== undefined &&
        (typeof node.value !== "string" || node.value.length > RAW_FIELD_LIMIT)) ||
      !Number.isSafeInteger(node.depth) ||
      node.depth < 0
    ) {
      throw invalid("The page returned an invalid snapshot node");
    }
  });
}

export function buildSnapshot(raw: RawSnapshot, tabId: string): Snapshot {
  validateRawSnapshot(raw);
  return SnapshotSchema.parse({
    tabId,
    revision: raw.revision,
    url: boundedText(redactUrl(raw.url), 2048),
    title: boundedText(raw.title, 200),
    nodes: raw.nodes.map((node) => ({
      ref: formatRef(raw.revision, node.index),
      role: boundedText(node.role, 40),
      name: boundedText(node.name, 200),
      ...(node.value === undefined ? {} : { value: boundedText(node.value, 200) }),
      depth: Math.min(node.depth, 60),
    })),
  });
}

export class BrowserSession {
  private readonly tabs = new Map<string, TabState>();
  private readonly pageIds = new WeakMap<Page, string>();
  private tabCounter = 0;
  private revision = 0;
  private activeTabId: string | null = null;
  private refTabId: string | null = null;
  private currentRefs = new Set<string>();
  private closed = false;

  static async attach(cdpUrl: string, signal?: AbortSignal): Promise<BrowserSession> {
    requireString(cdpUrl, "cdpUrl", 2048, false);
    if (signal?.aborted) throw uncertain();
    try {
      const connecting = chromium.connectOverCDP(cdpUrl, { timeout: DEFAULT_TIMEOUT_MS });
      let onAbort: (() => void) | undefined;
      const browser = signal
        ? await Promise.race([
            connecting,
            new Promise<never>((_resolve, reject) => {
              onAbort = () => {
                void connecting.then((lateBrowser) => lateBrowser.close()).catch(() => undefined);
                reject(uncertain());
              };
              signal.addEventListener("abort", onAbort, { once: true });
            }),
          ]).finally(() => {
            if (onAbort) signal.removeEventListener("abort", onAbort);
          })
        : await connecting;
      if (signal?.aborted) {
        await browser.close().catch(() => undefined);
        throw uncertain();
      }
      const context = browser.contexts()[0];
      if (!context) {
        await browser.close().catch(() => undefined);
        throw tabGoblinError("runtime_unavailable", "Chromium has no browser context");
      }
      return new BrowserSession(browser, context);
    } catch (error: unknown) {
      if (isStructuredError(error)) throw error;
      if (error instanceof errors.TimeoutError || signal?.aborted) throw uncertain();
      throw tabGoblinError("runtime_unavailable", "Could not attach to the browser runtime");
    }
  }

  constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
  ) {
    for (const page of context.pages()) this.registerPage(page);
    context.on("page", (page) => this.registerPage(page));
  }

  async listTabs(signal?: AbortSignal): Promise<Tab[]> {
    return this.withDeadline(DEFAULT_TIMEOUT_MS, signal, async () => {
      const tabs: Tab[] = [];
      for (const [tabId, state] of this.tabs) {
        if (state.page.isClosed()) {
          this.removeTab(tabId);
          continue;
        }
        tabs.push(await this.describeTab(state));
      }
      return tabs;
    });
  }

  async newTab(url: string, signal?: AbortSignal): Promise<Tab> {
    const safeUrl = requireNavigableUrl(url);
    return this.withDeadline(DEFAULT_TIMEOUT_MS, signal, async (deadline) => {
      this.requireOpen();
      const page = await this.context.newPage();
      const state = this.registerPage(page);
      this.activate(state.id);
      try {
        await page.goto(safeUrl, { waitUntil: "load", timeout: this.remaining(deadline) });
      } catch (error: unknown) {
        throw this.mapBrowserError(error);
      }
      return this.describeTab(state);
    });
  }

  network(tabId: string, maxEntries: number): NetworkDiagnostic[] {
    const state = this.getTab(tabId);
    const limit = requireMaxEntries(maxEntries);
    return state.network.slice(-limit).map((entry) => ({ ...entry }));
  }

  async closeTab(tabId: string, signal?: AbortSignal): Promise<void> {
    return this.withDeadline(DEFAULT_TIMEOUT_MS, signal, async () => {
      const state = this.getTab(tabId);
      this.invalidateTabRefs(tabId);
      await state.page.close();
      this.removeTab(tabId);
    });
  }

  async navigate(tabId: string, url: string, timeoutMs: number, signal?: AbortSignal): Promise<Tab> {
    const safeUrl = requireNavigableUrl(url);
    const timeout = requireTimeout(timeoutMs);
    return this.navigateOperation(tabId, timeout, signal, (page, deadline) =>
      page.goto(safeUrl, { waitUntil: "load", timeout: this.remaining(deadline) }),
    );
  }

  async back(tabId: string, timeoutMs: number, signal?: AbortSignal): Promise<Tab> {
    const timeout = requireTimeout(timeoutMs);
    return this.navigateOperation(tabId, timeout, signal, (page, deadline) =>
      page.goBack({ waitUntil: "load", timeout: this.remaining(deadline) }),
    );
  }

  async forward(tabId: string, timeoutMs: number, signal?: AbortSignal): Promise<Tab> {
    const timeout = requireTimeout(timeoutMs);
    return this.navigateOperation(tabId, timeout, signal, (page, deadline) =>
      page.goForward({ waitUntil: "load", timeout: this.remaining(deadline) }),
    );
  }

  async reload(tabId: string, timeoutMs: number, signal?: AbortSignal): Promise<Tab> {
    const timeout = requireTimeout(timeoutMs);
    return this.navigateOperation(tabId, timeout, signal, (page, deadline) =>
      page.reload({ waitUntil: "load", timeout: this.remaining(deadline) }),
    );
  }

  async snapshot(tabId: string, signal?: AbortSignal): Promise<Snapshot> {
    return this.withDeadline(DEFAULT_TIMEOUT_MS, signal, async () => {
      const state = this.getTab(tabId);
      const revision = this.bumpRevision();
      this.activate(tabId);
      const raw = (await state.page.evaluate(
        `(${SNAPSHOT_SCRIPT})(${JSON.stringify(revision)})`,
      )) as RawSnapshot;
      if (!raw || raw.revision !== revision) throw invalid("The page returned the wrong revision");
      const snapshot = buildSnapshot(raw, tabId);
      this.refTabId = tabId;
      this.currentRefs = new Set(snapshot.nodes.map((node) => node.ref));
      return snapshot;
    });
  }

  async act(tabId: string, action: BrowserAction, signal?: AbortSignal): Promise<void> {
    const validated = this.validateAction(action);
    const timeout = "timeoutMs" in validated ? validated.timeoutMs : DEFAULT_TIMEOUT_MS;
    return this.withDeadline(timeout, signal, async (deadline) => {
      const state = this.getTab(tabId);
      this.activate(tabId);
      try {
        switch (validated.kind) {
          case "click":
            await (await this.resolveRef(state, validated.ref)).click({
              timeout: this.remaining(deadline),
            });
            return;
          case "fill":
            await (await this.resolveRef(state, validated.ref)).fill(validated.value, {
              timeout: this.remaining(deadline),
            });
            return;
          case "type":
            await (await this.resolveRef(state, validated.ref)).pressSequentially(validated.text);
            return;
          case "keypress":
            await state.page.keyboard.press(validated.key);
            return;
          case "select":
            await (await this.resolveRef(state, validated.ref)).selectOption(validated.values, {
              timeout: this.remaining(deadline),
            });
            return;
          case "hover":
            await (await this.resolveRef(state, validated.ref)).hover({
              timeout: this.remaining(deadline),
            });
            return;
          case "scroll":
            await state.page.mouse.wheel(validated.dx, validated.dy);
            return;
          case "drag": {
            const from = await this.resolveRef(state, validated.fromRef);
            const to = await this.resolveRef(state, validated.toRef);
            await from.dragTo(to, { timeout: this.remaining(deadline) });
            return;
          }
          case "wait":
            if (validated.condition === "load") {
              await state.page.waitForLoadState("load", { timeout: this.remaining(deadline) });
            } else {
              await state.page
                .getByText(validated.text!, { exact: false })
                .first()
                .waitFor({ state: "visible", timeout: this.remaining(deadline) });
            }
            return;
        }
      } catch (error: unknown) {
        throw this.mapBrowserError(error);
      }
    });
  }

  async text(tabId: string, maxChars: number, signal?: AbortSignal): Promise<string> {
    const max = requireInteger(maxChars, "maxChars", 100, 50_000);
    return this.withDeadline(DEFAULT_TIMEOUT_MS, signal, async () => {
      const page = this.getTab(tabId).page;
      return boundedText(await page.innerText("body"), max);
    });
  }

  async screenshot(
    tabId: string,
    fullPage: boolean,
    signal?: AbortSignal,
  ): Promise<{ mimeType: "image/png"; base64: string }> {
    if (typeof fullPage !== "boolean") throw invalid("fullPage is invalid");
    return this.withDeadline(DEFAULT_TIMEOUT_MS, signal, async () => {
      const bytes = await this.getTab(tabId).page.screenshot({ type: "png", fullPage });
      return { mimeType: "image/png", base64: Buffer.from(bytes).toString("base64") };
    });
  }

  async logs(tabId: string, maxEntries: number): Promise<string[]> {
    const state = this.getTab(tabId);
    const limit = requireMaxEntries(maxEntries);
    return state.logs.slice(-limit);
  }

  async upload(tabId: string, ref: string, containerPath: string, signal?: AbortSignal): Promise<void> {
    const safeRef = requireRef(ref);
    const safePath = this.requireStagingPath(containerPath);
    return this.withDeadline(DEFAULT_TIMEOUT_MS, signal, async () => {
      const state = this.getTab(tabId);
      this.activate(tabId);
      try {
        await (await this.resolveRef(state, safeRef)).setInputFiles(safePath);
      } catch (error: unknown) {
        throw this.mapBrowserError(error);
      }
    });
  }

  async evaluate(
    tabId: string,
    expression: string,
    maxChars: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const source = requireString(expression, "expression", 2000);
    const max = requireInteger(maxChars, "maxChars", 100, 10_000);
    return this.withDeadline(DEFAULT_TIMEOUT_MS, signal, async () => {
      const state = this.getTab(tabId);
      this.activate(tabId);
      try {
        // Stringify and cap inside the page realm so an evaluation cannot send an
        // unbounded object graph over CDP before the gateway applies its wire bound.
        const encoded = await state.page.evaluate(
          `(() => { const value = (${source}); const json = JSON.stringify(value); ` +
            `return (json === undefined ? "null" : json).slice(0, ${max + 1}); })()`,
        );
        if (typeof encoded !== "string") throw invalid("The evaluation result is invalid");
        return boundedText(encoded, max);
      } catch (error: unknown) {
        if (isStructuredError(error)) throw error;
        if (error instanceof errors.TimeoutError) throw uncertain();
        throw invalid("The evaluation failed");
      }
    });
  }

  invalidateRefs(): void {
    this.bumpRevision();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.invalidateRefs();
    this.tabs.clear();
    this.activeTabId = null;
    await this.browser.close();
  }

  private registerPage(page: Page): TabState {
    const existingId = this.pageIds.get(page);
    if (existingId) return this.tabs.get(existingId)!;

    this.tabCounter += 1;
    const id = `t${this.tabCounter}`;
    if (id.length > TAB_ID_LIMIT) throw tabGoblinError("runtime_unavailable", "Too many browser tabs");
    const state: TabState = { id, page, logs: [], network: [] };
    this.tabs.set(id, state);
    this.pageIds.set(page, id);
    this.activeTabId ??= id;

    page.on("console", (message) => {
      try {
        const type = boundedText(String(message.type()).slice(0, RAW_FIELD_LIMIT), 40);
        const text = boundedText(String(message.text()).slice(0, RAW_FIELD_LIMIT), 200);
        this.pushRing(state.logs, `${type}: ${text}`, 100);
      } catch {
        // Console diagnostics are best effort and must never break browser control.
      }
    });
    page.on("response", (response) => {
      try {
        const rawUrl = response.url();
        if (rawUrl.length > RAW_FIELD_LIMIT) return;
        const diagnostic = NetworkDiagnosticSchema.parse({
          method: response.request().method(),
          url: redactUrl(rawUrl),
          status: response.status(),
        });
        this.pushRing(state.network, diagnostic, NETWORK_DIAGNOSTIC_LIMIT);
      } catch {
        // Invalid diagnostics are dropped; arbitrary browser errors never enter this surface.
      }
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.invalidateTabRefs(id);
    });
    page.on("close", () => this.removeTab(id));
    return state;
  }

  private removeTab(tabId: string): void {
    if (!this.tabs.delete(tabId)) return;
    this.invalidateTabRefs(tabId);
    if (this.activeTabId === tabId) this.activeTabId = [...this.tabs.keys()].at(-1) ?? null;
  }

  private async describeTab(state: TabState): Promise<Tab> {
    return TabSchema.parse({
      tabId: state.id,
      title: boundedText(await state.page.title(), 200),
      url: boundedText(redactUrl(state.page.url()), 2048),
      active: state.id === this.activeTabId,
    });
  }

  private getTab(tabId: string): TabState {
    this.requireOpen();
    if (typeof tabId !== "string" || tabId.length === 0 || tabId.length > TAB_ID_LIMIT) {
      throw tabGoblinError("tab_not_found", "The browser tab was not found", false);
    }
    const state = this.tabs.get(tabId);
    if (!state || state.page.isClosed()) {
      if (state) this.removeTab(tabId);
      throw tabGoblinError("tab_not_found", "The browser tab was not found", false);
    }
    return state;
  }

  private activate(tabId: string): void {
    this.activeTabId = tabId;
  }

  private invalidateTabRefs(tabId: string): void {
    if (this.refTabId === tabId) this.bumpRevision();
  }

  private bumpRevision(): number {
    if (this.revision >= Number.MAX_SAFE_INTEGER) {
      throw tabGoblinError("runtime_unavailable", "The browser reference generation is exhausted");
    }
    this.revision += 1;
    this.refTabId = null;
    this.currentRefs.clear();
    return this.revision;
  }

  private async resolveRef(state: TabState, refValue: string): Promise<Locator> {
    const ref = parseRef(refValue);
    if (
      !ref ||
      ref.revision !== this.revision ||
      this.refTabId !== state.id ||
      !this.currentRefs.has(refValue)
    ) {
      throw tabGoblinError("stale_ref", "The element reference is stale", false);
    }

    const locator = state.page.locator(`[data-tg-ref="${refValue}"]`);
    const count = await locator.count();
    if (count !== 1) {
      if (state.page.isClosed() || !this.tabs.has(state.id)) {
        throw tabGoblinError("tab_not_found", "The browser tab was not found", false);
      }
      throw tabGoblinError("stale_ref", "The element reference no longer resolves", false);
    }
    return locator;
  }

  private validateAction(action: BrowserAction): BrowserAction {
    if (!action || typeof action !== "object" || typeof action.kind !== "string") {
      throw invalid("The browser action is invalid");
    }

    switch (action.kind) {
      case "click":
      case "hover":
        requireExactKeys(action, ["kind", "ref", "timeoutMs"]);
        requireRef(action.ref);
        requireTimeout(action.timeoutMs);
        return action;
      case "fill":
        requireExactKeys(action, ["kind", "ref", "value", "timeoutMs"]);
        requireRef(action.ref);
        requireString(action.value, "value", 4096);
        requireTimeout(action.timeoutMs);
        return action;
      case "type":
        requireExactKeys(action, ["kind", "ref", "text", "timeoutMs"]);
        requireRef(action.ref);
        requireString(action.text, "text", 4096);
        requireTimeout(action.timeoutMs);
        return action;
      case "keypress":
        requireExactKeys(action, ["kind", "key", "timeoutMs"]);
        requireString(action.key, "key", 40, false);
        requireTimeout(action.timeoutMs);
        return action;
      case "select":
        requireExactKeys(action, ["kind", "ref", "values", "timeoutMs"]);
        requireRef(action.ref);
        if (
          !Array.isArray(action.values) ||
          action.values.length > 20 ||
          action.values.some((value) => typeof value !== "string" || value.length > 200)
        ) {
          throw invalid("values is invalid");
        }
        requireTimeout(action.timeoutMs);
        return action;
      case "scroll":
        requireExactKeys(action, ["kind", "dx", "dy"]);
        requireInteger(action.dx, "dx", -MAX_SCROLL_DELTA, MAX_SCROLL_DELTA);
        requireInteger(action.dy, "dy", -MAX_SCROLL_DELTA, MAX_SCROLL_DELTA);
        return action;
      case "drag":
        requireExactKeys(action, ["kind", "fromRef", "toRef", "timeoutMs"]);
        requireRef(action.fromRef, "fromRef");
        requireRef(action.toRef, "toRef");
        requireTimeout(action.timeoutMs);
        return action;
      case "wait": {
        const keys = action.text === undefined
          ? ["kind", "condition", "timeoutMs"]
          : ["kind", "condition", "text", "timeoutMs"];
        requireExactKeys(action, keys);
        if (action.condition !== "load" && action.condition !== "text") {
          throw invalid("condition is invalid");
        }
        if (action.condition === "text") requireString(action.text, "text", 200);
        else if (action.text !== undefined) requireString(action.text, "text", 200);
        requireTimeout(action.timeoutMs);
        return action;
      }
      default:
        throw invalid("The browser action is invalid");
    }
  }

  private requireStagingPath(value: unknown): string {
    const candidate = requireString(value, "containerPath", 4096, false);
    if (
      candidate.includes("\0") ||
      candidate.includes("\\") ||
      path.normalize(candidate) !== candidate ||
      path.dirname(candidate) !== "/staging" ||
      path.basename(candidate) === "." ||
      path.basename(candidate) === ".."
    ) {
      throw invalid("Uploads must use a controlled staging path");
    }
    return candidate;
  }

  private async navigateOperation(
    tabId: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    operation: (page: Page, deadline: number) => Promise<unknown>,
  ): Promise<Tab> {
    return this.withDeadline(timeoutMs, signal, async (deadline) => {
      const state = this.getTab(tabId);
      this.activate(tabId);
      this.invalidateRefs();
      try {
        await operation(state.page, deadline);
      } catch (error: unknown) {
        throw this.mapBrowserError(error);
      }
      return this.describeTab(state);
    });
  }

  private mapBrowserError(error: unknown): unknown {
    if (isStructuredError(error)) return error;
    if (error instanceof errors.TimeoutError) return uncertain();
    return error;
  }

  private remaining(deadline: number): number {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw uncertain();
    return remaining;
  }

  private async withDeadline<T>(
    timeoutMs: number,
    signal: AbortSignal | undefined,
    operation: (deadline: number) => Promise<T>,
  ): Promise<T> {
    const deadline = performance.now() + timeoutMs;
    if (signal?.aborted) throw uncertain();

    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(uncertain()), Math.max(1, deadline - performance.now()));
      if (signal) {
        abort = () => reject(uncertain());
        signal.addEventListener("abort", abort, { once: true });
      }
    });

    try {
      return await Promise.race([operation(deadline), interrupted]);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && abort) signal.removeEventListener("abort", abort);
    }
  }

  private pushRing<T>(ring: T[], value: T, limit: number): void {
    ring.push(value);
    if (ring.length > limit) ring.splice(0, ring.length - limit);
  }

  private requireOpen(): void {
    if (this.closed) throw tabGoblinError("runtime_unavailable", "The browser session is closed");
  }
}
