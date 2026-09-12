import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const noVnc = vi.hoisted(() => {
  class MockRfb extends EventTarget {
    viewOnly = false;
    scaleViewport = false;
    clipViewport = false;
    disconnected = false;
    readonly sentKeys: Array<[number, string | null | undefined, boolean | undefined]> = [];
    readonly rawTouchEvents: string[] = [];
    readonly activeTouchIds = new Set<number>();
    unknownTouchEnds = 0;

    constructor(
      readonly target: unknown,
      readonly url: string,
    ) {
      super();
      const canvas = (target as { querySelector?: (selector: string) => FakeElement | null }).querySelector?.("canvas");
      canvas?.addEventListener("touchstart", (event) => {
        const touch = (event as TouchEvent).changedTouches[0];
        this.rawTouchEvents.push(`start-${touch.identifier}`);
        this.activeTouchIds.add(touch.identifier);
      });
      canvas?.addEventListener("touchmove", (event) => {
        const touch = (event as TouchEvent).changedTouches[0];
        this.rawTouchEvents.push(`move-${touch.identifier}`);
      });
      canvas?.addEventListener("touchend", (event) => {
        const touch = (event as TouchEvent).changedTouches[0];
        this.rawTouchEvents.push(`end-${touch.identifier}`);
        if (!this.activeTouchIds.delete(touch.identifier)) this.unknownTouchEnds += 1;
      });
      instances.push(this);
    }

    disconnect(): void {
      this.disconnected = true;
    }

    sendKey(keysym: number, code?: string | null, down?: boolean): void {
      this.sentKeys.push([keysym, code, down]);
    }
  }
  const instances: MockRfb[] = [];
  return { MockRfb, instances };
});

vi.mock("@novnc/novnc", () => ({ default: noVnc.MockRfb }));

class FakeClassList {
  readonly values = new Set<string>();
  toggle(name: string, force?: boolean): boolean {
    const enabled = force ?? !this.values.has(name);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }
}

class FakeElement {
  readonly classList = new FakeClassList();
  private readonly listeners = new Map<string, Array<{ listener: EventListenerOrEventListenerObject; capture: boolean }>>();
  readonly style: Record<string, string> = {};
  textContent = "";
  value = "";
  disabled = false;
  clientWidth = 390;
  clientHeight = 844;
  focused = false;
  canvas: FakeElement | null = null;

  constructor(readonly id = "") {}

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    if (!listener) return;
    const capture = typeof options === "boolean" ? options : options?.capture === true;
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ listener, capture });
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
    const capture = typeof options === "boolean" ? options : options?.capture === true;
    const listeners = this.listeners.get(type);
    if (!listeners || !listener) return;
    this.listeners.set(type, listeners.filter((entry) => entry.listener !== listener || entry.capture !== capture));
  }

  dispatchEvent(event: Event): boolean {
    const listeners = [...(this.listeners.get(event.type) ?? [])].sort((a, b) => Number(b.capture) - Number(a.capture));
    let stopped = false;
    const stopImmediately = event.stopImmediatePropagation.bind(event);
    Object.defineProperty(event, "stopImmediatePropagation", {
      configurable: true,
      value: () => {
        stopped = true;
        stopImmediately();
      },
    });
    for (const { listener } of listeners) {
      if (stopped) break;
      if (typeof listener === "function") listener.call(this, event);
      else listener.handleEvent(event);
    }
    return !event.defaultPrevented;
  }

  focus(): void {
    this.focused = true;
  }

  querySelector(selector: string): FakeElement | null {
    return selector === "canvas" ? this.canvas : null;
  }
}

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  constructor(readonly elements: Map<string, FakeElement>) {
    super();
  }
  getElementById(id: string): FakeElement | null {
    return this.elements.get(id) ?? null;
  }
}

type FetchMock = ReturnType<typeof vi.fn>;

function response(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

function status(
  generation: number,
  state: "agent-ready" | "taking-control" | "manual" | "returning-control" | "needs-attention" = "agent-ready",
  owner: "agent" | "viewer" | null = "agent",
  isOwner?: boolean,
): object {
  return {
    workspaceId: "workspace-a",
    sessionState: "ready",
    ownership: { generation, state, owner },
    startedAt: null,
    viewerUrl: null,
    lastError: null,
    ...(isOwner === undefined ? {} : { isOwner }),
  };
}

function eventWithData(type: string, values: Record<string, unknown>): Event {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(event, key, { value });
  }
  return event;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function boot(fetchMock: FetchMock): Promise<{
  elements: Map<string, FakeElement>;
  timers: Array<() => void>;
}> {
  const elements = new Map<string, FakeElement>();
  for (const id of [
    "pairing",
    "pairing-code",
    "pairing-error",
    "pair-button",
    "banner",
    "viewer",
    "screen",
    "controls",
    "take-control",
    "return-to-agent",
    "reclaim-control",
    "keyboard-toggle",
    "keyboard-input",
    "sign-out",
  ]) {
    elements.set(id, new FakeElement(id));
  }
  elements.get("screen")!.canvas = new FakeElement("canvas");
  const document = new FakeDocument(elements);
  const timers: Array<() => void> = [];
  const window = new EventTarget() as EventTarget & {
    location: { href: string };
    confirm: () => boolean;
    setInterval: () => number;
    clearInterval: () => void;
    setTimeout: (callback: () => void) => number;
    clearTimeout: () => void;
  };
  window.location = { href: "https://viewer.example/workspaces/a/viewer" };
  window.confirm = () => true;
  window.setInterval = () => 1;
  window.clearInterval = () => undefined;
  window.setTimeout = (callback) => {
    timers.push(callback);
    return timers.length;
  };
  window.clearTimeout = () => undefined;

  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("HTMLInputElement", FakeElement);
  vi.stubGlobal("HTMLButtonElement", FakeElement);
  vi.stubGlobal("HTMLCanvasElement", FakeElement);
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  await import("../src/viewer.js");
  return { elements, timers };
}

async function pairAndConnect(
  elements: Map<string, FakeElement>,
  code = "12345678",
): Promise<InstanceType<typeof noVnc.MockRfb>> {
  elements.get("pairing-code")!.value = code;
  elements.get("pair-button")!.dispatchEvent(new Event("click"));
  await flush();
  const rfb = noVnc.instances.at(-1)!;
  rfb.dispatchEvent(new Event("connect"));
  await flush();
  return rfb;
}

describe("viewer DOM and transport behavior", () => {
  beforeEach(() => {
    noVnc.instances.splice(0);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("gives the noVNC target real viewport dimensions before enabling coordinate-aware scaling", async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path === "/api/pair") return response({ workspaceId: "workspace-a", csrfToken: "csrf-token", viewOnly: true });
      return response(status(1));
    });
    const { elements } = await boot(fetchMock);
    const rfb = await pairAndConnect(elements);

    expect(rfb.scaleViewport).toBe(true);
    expect(rfb.clipViewport).toBe(false);
    expect(elements.get("screen")!.style.width).toBe("390px");
    expect(elements.get("screen")!.style.height).toBe("844px");
    expect(elements.get("screen")!.style.transform).toBeUndefined();
  });

  it("keeps staggered raw touches intact while locally handling generated pinch gestures", async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path === "/api/pair") return response({ workspaceId: "workspace-a", csrfToken: "csrf-token", viewOnly: true });
      return response(status(1));
    });
    const { elements } = await boot(fetchMock);
    const rfb = await pairAndConnect(elements);
    const canvas = elements.get("screen")!.canvas!;
    let remotePinchConversions = 0;
    canvas.addEventListener("gesturemove", (event) => {
      if ((event as CustomEvent<{ type: string }>).detail.type === "pinch") {
        remotePinchConversions += 1;
        rfb.sentKeys.push([0xffe3, "ControlLeft", true]);
      }
    });
    const touch = (identifier: number, clientX: number, clientY: number) => ({ identifier, clientX, clientY });
    const rawTouch = (type: "touchstart" | "touchmove" | "touchend", touches: object[], changedTouches: object[]) =>
      canvas.dispatchEvent(eventWithData(type, { touches, changedTouches }));

    // This is the real GestureHandler ordering: finger A, then B, lift A, then B.
    const fingerA = touch(1, 20, 20);
    const fingerB = touch(2, 80, 20);
    rawTouch("touchstart", [fingerA], [fingerA]);
    rawTouch("touchstart", [fingerA, fingerB], [fingerB]);
    const movedA = touch(1, 10, 20);
    const movedB = touch(2, 110, 20);
    rawTouch("touchmove", [movedA, fingerB], [movedA]);
    rawTouch("touchmove", [movedA, movedB], [movedB]);
    canvas.dispatchEvent(eventWithData("gesturestart", { detail: { type: "pinch", magnitudeX: 60, magnitudeY: 0 } }));
    const move = eventWithData("gesturemove", { detail: { type: "pinch", magnitudeX: 100, magnitudeY: 0 } });
    canvas.dispatchEvent(move);
    rawTouch("touchend", [fingerB], [fingerA]);
    canvas.dispatchEvent(eventWithData("gestureend", { detail: { type: "pinch", magnitudeX: 100, magnitudeY: 0 } }));
    rawTouch("touchend", [], [fingerB]);

    // A later single touch must still reach noVNC after the completed pinch sequence.
    const fingerC = touch(3, 40, 40);
    rawTouch("touchstart", [fingerC], [fingerC]);
    rawTouch("touchend", [], [fingerC]);

    expect(rfb.rawTouchEvents).toEqual(["start-1", "start-2", "move-1", "move-2", "end-1", "end-2", "start-3", "end-3"]);
    expect(rfb.unknownTouchEnds).toBe(0);
    expect(rfb.activeTouchIds).toEqual(new Set());
    expect(move.defaultPrevented).toBe(true);
    expect(remotePinchConversions).toBe(0);
    expect(rfb.sentKeys).toEqual([]);
    expect(elements.get("screen")!.style.width).toBe("650px");
  });

  it("sends committed IME, emoji, dictation, and physical-key events once after server-authorized control", async () => {
    let controlsRequested = false;
    const fetchMock = vi.fn(async (path: string) => {
      if (path === "/api/pair") return response({ workspaceId: "workspace-a", csrfToken: "csrf-token", viewOnly: true });
      if (path === "/api/take-control") {
        controlsRequested = true;
        return response({});
      }
      return response(controlsRequested ? status(2, "manual", "viewer", true) : status(1));
    });
    const { elements } = await boot(fetchMock);
    const rfb = await pairAndConnect(elements);
    elements.get("take-control")!.dispatchEvent(new Event("click"));
    await flush();
    expect(rfb.viewOnly).toBe(false);

    const input = elements.get("keyboard-input")!;
    input.dispatchEvent(new Event("compositionstart"));
    input.value = "n";
    input.dispatchEvent(eventWithData("beforeinput", { inputType: "insertCompositionText", data: "n" }));
    input.dispatchEvent(eventWithData("input", { inputType: "insertCompositionText", data: "n" }));
    expect(input.value).toBe("n");
    input.value = "ni";
    input.dispatchEvent(eventWithData("beforeinput", { inputType: "insertCompositionText", data: "ni" }));
    input.dispatchEvent(eventWithData("input", { inputType: "insertCompositionText", data: "ni" }));
    input.dispatchEvent(eventWithData("compositionend", { data: "你" }));
    input.dispatchEvent(eventWithData("beforeinput", { inputType: "insertFromComposition", data: "你" }));
    input.dispatchEvent(eventWithData("input", { inputType: "insertFromComposition", data: "你" }));
    input.dispatchEvent(new Event("compositionstart"));
    input.dispatchEvent(eventWithData("input", { inputType: "insertCompositionText", data: "z" }));
    input.dispatchEvent(eventWithData("compositionend", { data: "字" }));
    input.dispatchEvent(eventWithData("input", { inputType: "insertCompositionText", data: "字" }));
    await flush();
    input.dispatchEvent(eventWithData("beforeinput", { inputType: "insertText", data: "🙂" }));
    input.dispatchEvent(eventWithData("input", { data: "🙂" }));
    input.dispatchEvent(eventWithData("beforeinput", { inputType: "insertText", data: "ok" }));
    input.dispatchEvent(eventWithData("input", { data: "ok" }));
    input.dispatchEvent(eventWithData("keydown", { key: "Enter", code: "Enter", isComposing: false }));
    input.dispatchEvent(eventWithData("keyup", { key: "Enter", code: "Enter", isComposing: false }));

    expect(rfb.sentKeys).toEqual([
      [0x01000000 | 0x4f60, null, undefined],
      [0x01000000 | 0x5b57, null, undefined],
      [0x01000000 | 0x1f642, null, undefined],
      [0x6f, null, undefined],
      [0x6b, null, undefined],
      [0xff0d, "Enter", true],
      [0xff0d, "Enter", false],
    ]);
  });

  it("reconnects only through bounded view-only attempts and disables ownership actions while disconnected", async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path === "/api/pair") return response({ workspaceId: "workspace-a", csrfToken: "csrf-token", viewOnly: true });
      return response(status(1));
    });
    const { elements, timers } = await boot(fetchMock);
    const first = await pairAndConnect(elements);
    first.dispatchEvent(new Event("disconnect"));
    await flush();

    expect(elements.get("take-control")!.disabled).toBe(true);
    expect(elements.get("reclaim-control")!.disabled).toBe(true);
    expect(first.viewOnly).toBe(true);
    expect(timers).toHaveLength(1);
    timers[0]!();
    expect(noVnc.instances).toHaveLength(2);
    expect(noVnc.instances[1]!.viewOnly).toBe(true);
    noVnc.instances[1]!.dispatchEvent(new Event("disconnect"));
    timers[1]!();
    noVnc.instances[2]!.dispatchEvent(new Event("disconnect"));
    timers[2]!();
    noVnc.instances[3]!.dispatchEvent(new Event("disconnect"));
    expect(noVnc.instances).toHaveLength(4);
    expect(timers).toHaveLength(3);
    expect(elements.get("banner")!.textContent).toBe("connection lost");
  });

  it("requires the session-specific isOwner status flag, not generic viewer ownership, before enabling input", async () => {
    let controlsRequested = false;
    const fetchMock = vi.fn(async (path: string) => {
      if (path === "/api/pair") return response({ workspaceId: "workspace-a", csrfToken: "csrf-token", viewOnly: true });
      if (path === "/api/take-control") {
        controlsRequested = true;
        return response({});
      }
      return response(controlsRequested ? status(2, "manual", "viewer") : status(1));
    });
    const { elements } = await boot(fetchMock);
    const rfb = await pairAndConnect(elements);
    elements.get("take-control")!.dispatchEvent(new Event("click"));
    await flush();

    expect(rfb.viewOnly).toBe(true);
    expect(elements.get("banner")!.textContent).toBe("view only");
  });

  it("rejects stale and invalidated status results so they cannot restore control", async () => {
    let resolveOld!: (value: Response) => void;
    const oldStatus = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    let controlsRequested = false;
    const fetchMock = vi.fn((path: string) => {
      if (path === "/api/pair") return Promise.resolve(response({ workspaceId: "workspace-a", csrfToken: "csrf-token", viewOnly: true }));
      if (path === "/api/take-control") {
        controlsRequested = true;
        return Promise.resolve(response({}));
      }
      if (!controlsRequested) return oldStatus;
      return Promise.resolve(response(status(6, "manual", "viewer", true)));
    });
    const { elements } = await boot(fetchMock);
    const rfb = await pairAndConnect(elements);
    elements.get("take-control")!.dispatchEvent(new Event("click"));
    await flush();
    expect(rfb.viewOnly).toBe(false);

    resolveOld(response(status(5, "manual", "viewer", true)));
    await flush();
    expect(rfb.viewOnly).toBe(false);
  });

  it("shows pairing, connecting, and needs-attention states distinctly", async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path === "/api/pair") return response({ workspaceId: "workspace-a", csrfToken: "csrf-token", viewOnly: true });
      return response(status(1, "needs-attention", null));
    });
    const { elements } = await boot(fetchMock);
    expect(elements.get("banner")!.textContent).toBe("pair this device");
    elements.get("pairing-code")!.value = "12345678";
    elements.get("pair-button")!.dispatchEvent(new Event("click"));
    await flush();
    expect(elements.get("banner")!.textContent).toBe("connecting");
    noVnc.instances.at(-1)!.dispatchEvent(new Event("connect"));
    await flush();
    expect(elements.get("banner")!.textContent).toBe("needs attention");
  });

  it("blocks input immediately and exposes bounded sign-out retry when revocation is unconfirmed", async () => {
    let signOutAttempts = 0;
    const fetchMock = vi.fn(async (path: string) => {
      if (path === "/api/pair") return response({ workspaceId: "workspace-a", csrfToken: "csrf-token", viewOnly: true });
      if (path === "/api/sign-out") {
        signOutAttempts += 1;
        return response({}, false);
      }
      return response(status(1));
    });
    const { elements } = await boot(fetchMock);
    const rfb = await pairAndConnect(elements);
    const signOut = elements.get("sign-out")!;
    signOut.dispatchEvent(new Event("click"));
    expect(rfb.viewOnly).toBe(true);
    await flush();
    expect(elements.get("banner")!.textContent).toContain("not confirmed");
    expect(signOut.textContent).toBe("Retry sign out");
    expect(signOut.disabled).toBe(false);
    signOut.dispatchEvent(new Event("click"));
    await flush();
    expect(signOutAttempts).toBe(2);
    signOut.dispatchEvent(new Event("click"));
    await flush();
    expect(signOutAttempts).toBe(3);
    expect(signOut.disabled).toBe(true);
  });
});
