import RFB from "@novnc/novnc";
import { CSRF_HEADER, PairResponseSchema, type OwnershipState } from "@tab-goblin/protocol";
import { nextUi, scaleToFit, type ViewerUi } from "./ui-state.js";

const OWNERSHIP_STATES: readonly OwnershipState[] = [
  "agent-ready",
  "taking-control",
  "manual",
  "returning-control",
  "needs-attention",
];
const STATUS_POLL_MS = 3_000;
const RECONNECT_GRACE_MS = 5_000;

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing #${id}`);
  return element as T;
}

const pairing = requiredElement<HTMLElement>("pairing");
const pairingCode = requiredElement<HTMLInputElement>("pairing-code");
const pairingError = requiredElement<HTMLElement>("pairing-error");
const pairButton = requiredElement<HTMLButtonElement>("pair-button");
const banner = requiredElement<HTMLElement>("banner");
const viewer = requiredElement<HTMLElement>("viewer");
const screen = requiredElement<HTMLElement>("screen");
const controls = requiredElement<HTMLElement>("controls");
const takeControl = requiredElement<HTMLButtonElement>("take-control");
const returnToAgent = requiredElement<HTMLButtonElement>("return-to-agent");
const reclaimControl = requiredElement<HTMLButtonElement>("reclaim-control");
const keyboardToggle = requiredElement<HTMLButtonElement>("keyboard-toggle");
const keyboardInput = requiredElement<HTMLInputElement>("keyboard-input");
const signOut = requiredElement<HTMLButtonElement>("sign-out");

let csrfToken: string | null = null;
let rfb: RFB | null = null;
let ui: ViewerUi = { kind: "pairing", error: null };
let pollTimer: number | null = null;
let reconnectTimer: number | null = null;
let remoteSize = { width: 1, height: 1 };
let pinchScale = 1;
const pointers = new Map<number, { x: number; y: number }>();
let pinchDistance: number | null = null;

function statusText(current: ViewerUi): string {
  switch (current.kind) {
    case "pairing":
      return "needs attention";
    case "connecting":
      return "reconnecting";
    case "view-only":
      return current.ownership === "taking-control" ? "taking control…" : "view only";
    case "controlling":
      return "you have control";
    case "reconnecting":
      return "reconnecting";
    case "connection-lost":
      return "connection lost";
  }
}

function setUi(next: ViewerUi): void {
  ui = next;
  banner.textContent = statusText(next);
  pairing.classList.toggle("hidden", next.kind !== "pairing");
  screen.classList.toggle("hidden", next.kind === "pairing");
  controls.classList.toggle("hidden", next.kind === "pairing");
  pairingError.textContent = next.kind === "pairing" ? next.error ?? "" : "";

  // Input remains blocked unless the server has explicitly identified this session as owner.
  if (rfb) rfb.viewOnly = next.kind !== "controlling";
  takeControl.disabled = next.kind === "controlling" || next.kind === "reconnecting";
  returnToAgent.disabled = next.kind !== "controlling";
  reclaimControl.disabled = next.kind === "controlling" || next.kind === "reconnecting";
}

function websocketUrl(): string {
  const url = new URL("/ws/vnc", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

function applyScale(): void {
  const canvas = screen.querySelector("canvas");
  if (canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0) {
    remoteSize = { width: canvas.width, height: canvas.height };
  }
  const fit = scaleToFit(remoteSize, { width: viewer.clientWidth, height: viewer.clientHeight });
  const scale = fit.scale * pinchScale;
  screen.style.transform = `translate(${fit.offsetX}px, ${fit.offsetY}px) scale(${scale})`;
  screen.style.width = `${remoteSize.width}px`;
  screen.style.height = `${remoteSize.height}px`;
}

function clearReconnectTimer(): void {
  if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function connectVnc(): void {
  clearReconnectTimer();
  rfb?.disconnect();
  rfb = new RFB(screen, websocketUrl());
  rfb.viewOnly = true;
  rfb.addEventListener("connect", () => {
    clearReconnectTimer();
    setUi(nextUi(ui, { type: "socket-open" }));
    applyScale();
    void refreshStatus();
  });
  rfb.addEventListener("disconnect", () => {
    setUi(nextUi(ui, { type: "socket-closed" }));
    clearReconnectTimer();
    reconnectTimer = window.setTimeout(() => {
      if (ui.kind === "reconnecting") setUi({ kind: "connection-lost" });
    }, RECONNECT_GRACE_MS);
  });
}

function ownershipEvent(payload: unknown): { state: OwnershipState; isOwner: boolean } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const ownership = (payload as { ownership?: unknown }).ownership;
  if (typeof ownership !== "object" || ownership === null) return null;
  const { state, isOwner } = ownership as { state?: unknown; isOwner?: unknown };
  if (typeof state !== "string" || !OWNERSHIP_STATES.includes(state as OwnershipState)) return null;

  // `owner: "viewer"` is deliberately insufficient: another paired device may own input.
  // The gateway must provide this session-specific boolean, otherwise this UI stays view-only.
  return { state: state as OwnershipState, isOwner: isOwner === true };
}

async function request(path: string, body?: unknown): Promise<Response> {
  if (!csrfToken) throw new Error("Pair this device first");
  return fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      [CSRF_HEADER]: csrfToken,
    },
    body: JSON.stringify(body ?? {}),
  });
}

async function refreshStatus(): Promise<void> {
  if (!csrfToken || document.visibilityState !== "visible") return;
  try {
    const response = await fetch("/api/status", {
      credentials: "same-origin",
      headers: { [CSRF_HEADER]: csrfToken },
    });
    if (!response.ok) return;
    const ownership = ownershipEvent(await response.json());
    if (ownership) setUi(nextUi(ui, { type: "ownership", ...ownership }));
  } catch {
    // A transient status failure never enables input; the VNC connection remains view-only.
  }
}

function startPolling(): void {
  if (pollTimer !== null || document.visibilityState !== "visible") return;
  pollTimer = window.setInterval(() => void refreshStatus(), STATUS_POLL_MS);
  void refreshStatus();
}

function stopPolling(): void {
  if (pollTimer !== null) window.clearInterval(pollTimer);
  pollTimer = null;
}

async function pair(): Promise<void> {
  const code = pairingCode.value.trim();
  if (!code) {
    setUi({ kind: "pairing", error: "Enter a pairing code" });
    return;
  }

  pairButton.disabled = true;
  try {
    const response = await fetch("/api/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!response.ok) throw new Error("Pairing failed");
    const paired = PairResponseSchema.parse(await response.json());
    csrfToken = paired.csrfToken;
    pairingCode.value = "";
    setUi(nextUi(ui, { type: "paired" }));
    connectVnc();
    startPolling();
  } catch {
    setUi(nextUi(ui, { type: "pair-failed", message: "Pairing failed. Check the code and try again." }));
  } finally {
    pairButton.disabled = false;
  }
}

async function postAndRefresh(path: string, body?: unknown): Promise<void> {
  try {
    const response = await request(path, body);
    if (!response.ok) throw new Error("request rejected");
    // Do not optimistically grant or restore control. Polling mirrors the server decision.
    await refreshStatus();
  } catch {
    // Fail closed: rfb.viewOnly is set below even when a request or network operation fails.
    if (rfb) rfb.viewOnly = true;
    void refreshStatus();
  }
}

function pointerDistance(): number | null {
  const active = [...pointers.values()];
  if (active.length !== 2) return null;
  return Math.hypot(active[0].x - active[1].x, active[0].y - active[1].y);
}

function updatePinch(event: PointerEvent): void {
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  const distance = pointerDistance();
  if (distance !== null && pinchDistance !== null && pinchDistance > 0) {
    pinchScale = Math.min(3, Math.max(0.5, pinchScale * (distance / pinchDistance)));
    applyScale();
  }
  pinchDistance = distance;
}

pairButton.addEventListener("click", () => void pair());
pairingCode.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void pair();
});
takeControl.addEventListener("click", () => void postAndRefresh("/api/take-control"));
returnToAgent.addEventListener("click", () => {
  if (rfb) rfb.viewOnly = true;
  void postAndRefresh("/api/return-to-agent");
});
reclaimControl.addEventListener("click", () => {
  if (window.confirm("Reclaiming control revokes control from the other device. Continue?")) {
    void postAndRefresh("/api/reclaim", { confirm: true });
  }
});
keyboardToggle.addEventListener("click", () => keyboardInput.focus());
function forwardMobileKey(event: KeyboardEvent): void {
  if (ui.kind !== "controlling") return;
  const canvas = screen.querySelector("canvas");
  if (!(canvas instanceof HTMLCanvasElement)) return;
  canvas.dispatchEvent(
    new KeyboardEvent(event.type, {
      bubbles: true,
      cancelable: true,
      key: event.key,
      code: event.code,
      location: event.location,
      repeat: event.repeat,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    }),
  );
  event.preventDefault();
}
keyboardInput.addEventListener("keydown", forwardMobileKey);
keyboardInput.addEventListener("keyup", forwardMobileKey);
keyboardInput.addEventListener("input", () => {
  // Do not retain typed remote input in this page's DOM after invoking the mobile keyboard.
  keyboardInput.value = "";
});
signOut.addEventListener("click", () => void (async () => {
  try {
    await request("/api/sign-out");
  } catch {
    // Local cleanup still removes the in-memory CSRF token and blocks input.
  }
  stopPolling();
  clearReconnectTimer();
  rfb?.disconnect();
  rfb = null;
  csrfToken = null;
  setUi({ kind: "pairing", error: null });
})());

viewer.addEventListener("pointerdown", updatePinch);
viewer.addEventListener("pointermove", updatePinch);
viewer.addEventListener("pointerup", (event) => {
  pointers.delete(event.pointerId);
  pinchDistance = pointerDistance();
});
viewer.addEventListener("pointercancel", (event) => {
  pointers.delete(event.pointerId);
  pinchDistance = pointerDistance();
});
window.addEventListener("resize", applyScale);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") startPolling();
  else stopPolling();
});
window.addEventListener("pagehide", stopPolling);

setUi(ui);
