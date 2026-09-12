import RFB from "@novnc/novnc";
import { CSRF_HEADER, PairResponseSchema, SessionStatusSchema } from "@tab-goblin/protocol";
import { nextUi, type ViewerUi } from "./ui-state.js";

const STATUS_POLL_MS = 3_000;
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 500;
const MAX_SIGN_OUT_ATTEMPTS = 3;

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
let statusAbort: AbortController | null = null;
let transportEpoch = 0;
let statusSequence = 0;
let lastOwnershipGeneration = -1;
let reconnectAttempts = 0;
let transportConnected = false;
let controlExplicitlyRequested = false;
let ownershipActionPending = false;
let signOutPending = false;
let signOutAttempts = 0;
let signOutFailure: string | null = null;
let composing = false;
let suppressInputText: string | null = null;
const pressedKeys = new Map<string, number>();
const PHYSICAL_KEYSYMS: Readonly<Record<string, number>> = {
  Alt: 0xffe9,
  ArrowDown: 0xff54,
  ArrowLeft: 0xff51,
  ArrowRight: 0xff53,
  ArrowUp: 0xff52,
  Backspace: 0xff08,
  CapsLock: 0xffe5,
  Control: 0xffe3,
  Delete: 0xffff,
  End: 0xff57,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Home: 0xff50,
  Insert: 0xff63,
  Meta: 0xffe7,
  PageDown: 0xff56,
  PageUp: 0xff55,
  Shift: 0xffe1,
  Tab: 0xff09,
};

function statusText(current: ViewerUi): string {
  if (signOutFailure) return signOutFailure;
  switch (current.kind) {
    case "pairing":
      return "pair this device";
    case "connecting":
      return "connecting";
    case "view-only":
      return current.ownership === "taking-control" ? "taking control…" : "view only";
    case "controlling":
      return "you have control";
    case "needs-attention":
      return "needs attention";
    case "reconnecting":
      return "reconnecting";
    case "connection-lost":
      return "connection lost";
  }
}

function canSendInput(): boolean {
  return transportConnected && !signOutPending && !signOutFailure && ui.kind === "controlling";
}

function setUi(next: ViewerUi): void {
  ui = next;
  const inputAllowed = canSendInput();
  banner.textContent = statusText(next);
  pairing.classList.toggle("hidden", next.kind !== "pairing");
  screen.classList.toggle("hidden", next.kind === "pairing");
  controls.classList.toggle("hidden", next.kind === "pairing");
  pairingError.textContent = next.kind === "pairing" ? next.error ?? "" : "";

  if (rfb) rfb.viewOnly = !inputAllowed;
  const canRequestOwnership = transportConnected && !ownershipActionPending && !signOutPending && !signOutFailure;
  takeControl.disabled = !canRequestOwnership || inputAllowed;
  returnToAgent.disabled = !inputAllowed;
  reclaimControl.disabled = !canRequestOwnership || inputAllowed;
  signOut.disabled = !csrfToken || signOutPending || signOutAttempts >= MAX_SIGN_OUT_ATTEMPTS;
  signOut.textContent = signOutFailure ? "Retry sign out" : "Sign out";
}

function websocketUrl(): string {
  const url = new URL("/ws/vnc", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

function applyViewportScaling(): void {
  if (!rfb) return;
  // noVNC owns both its display scale and inverse pointer coordinate mapping.
  rfb.clipViewport = false;
  rfb.scaleViewport = true;
}

function clearReconnectTimer(): void {
  if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function invalidateStatusRequests(): void {
  statusSequence += 1;
  statusAbort?.abort();
  statusAbort = null;
}

function scheduleReconnect(): void {
  if (!csrfToken || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    setUi({ kind: "connection-lost" });
    return;
  }
  const delay = RECONNECT_DELAY_MS * 2 ** reconnectAttempts;
  reconnectAttempts += 1;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    if (!csrfToken || transportConnected) return;
    connectVnc();
  }, delay);
}

function connectVnc(): void {
  clearReconnectTimer();
  const connectionEpoch = ++transportEpoch;
  transportConnected = false;
  controlExplicitlyRequested = false;
  invalidateStatusRequests();
  rfb?.disconnect();
  rfb = new RFB(screen, websocketUrl());
  rfb.viewOnly = true;
  applyViewportScaling();
  rfb.addEventListener("connect", () => {
    if (connectionEpoch !== transportEpoch || !csrfToken) return;
    transportConnected = true;
    reconnectAttempts = 0;
    setUi(nextUi(ui, { type: "socket-open" }));
    applyViewportScaling();
    startPolling();
    void refreshStatus();
  });
  rfb.addEventListener("disconnect", () => {
    if (connectionEpoch !== transportEpoch || !csrfToken) return;
    transportConnected = false;
    controlExplicitlyRequested = false;
    pressedKeys.clear();
    invalidateStatusRequests();
    setUi(nextUi(ui, { type: "socket-closed" }));
    scheduleReconnect();
  });
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
  if (!csrfToken || !transportConnected || document.visibilityState !== "visible") return;
  statusAbort?.abort();
  const controller = new AbortController();
  statusAbort = controller;
  const requestEpoch = transportEpoch;
  const requestSequence = ++statusSequence;
  try {
    const response = await fetch("/api/status", {
      credentials: "same-origin",
      headers: { [CSRF_HEADER]: csrfToken },
      signal: controller.signal,
    });
    if (!response.ok) return;
    const parsed = SessionStatusSchema.safeParse(await response.json());
    if (!parsed.success || requestEpoch !== transportEpoch || requestSequence !== statusSequence || !transportConnected) {
      return;
    }
    const ownership = parsed.data.ownership;
    if (ownership.generation < lastOwnershipGeneration) return;
    lastOwnershipGeneration = ownership.generation;
    const canControl =
      controlExplicitlyRequested && ownership.state === "manual" && ownership.owner === "viewer";
    setUi(nextUi(ui, { type: "ownership", state: ownership.state, canControl }));
  } catch {
    // Request cancellation, stale responses, and temporary failures always leave the current UI fail-closed.
  } finally {
    if (requestSequence === statusSequence) statusAbort = null;
  }
}

function startPolling(): void {
  if (pollTimer !== null || document.visibilityState !== "visible") return;
  pollTimer = window.setInterval(() => void refreshStatus(), STATUS_POLL_MS);
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
    lastOwnershipGeneration = -1;
    reconnectAttempts = 0;
    signOutAttempts = 0;
    signOutFailure = null;
    controlExplicitlyRequested = false;
    setUi(nextUi(ui, { type: "paired" }));
    connectVnc();
  } catch {
    setUi(nextUi(ui, { type: "pair-failed", message: "Pairing failed. Check the code and try again." }));
  } finally {
    pairButton.disabled = false;
  }
}

async function requestOwnership(path: "/api/take-control" | "/api/reclaim", body?: unknown): Promise<void> {
  if (!transportConnected || ownershipActionPending || signOutFailure) return;
  ownershipActionPending = true;
  setUi(ui);
  try {
    const response = await request(path, body);
    if (!response.ok) throw new Error("request rejected");
    controlExplicitlyRequested = true;
    await refreshStatus();
  } catch {
    controlExplicitlyRequested = false;
    if (rfb) rfb.viewOnly = true;
  } finally {
    ownershipActionPending = false;
    setUi(ui);
  }
}

async function returnControl(): Promise<void> {
  if (!canSendInput()) return;
  controlExplicitlyRequested = false;
  setUi({ kind: "view-only", ownership: "returning-control" });
  try {
    const response = await request("/api/return-to-agent");
    if (!response.ok) throw new Error("request rejected");
    await refreshStatus();
  } catch {
    if (rfb) rfb.viewOnly = true;
  }
}

function keysymFor(character: string): number {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return 0;
  return codePoint <= 0xff ? codePoint : 0x01000000 | codePoint;
}

function sendCommittedText(text: string): void {
  if (!canSendInput() || !rfb) return;
  for (const character of text) rfb.sendKey(keysymFor(character), null);
}

function physicalKeysym(key: string): number | null {
  if (PHYSICAL_KEYSYMS[key] !== undefined) return PHYSICAL_KEYSYMS[key];
  const match = /^F([1-9]|1[0-2])$/.exec(key);
  return match ? 0xffbd + Number(match[1]) : null;
}

function forwardPhysicalKey(event: KeyboardEvent): void {
  if (!canSendInput() || composing || !rfb) return;
  const printable = event.key.length === 1 || event.key === "Dead";
  if (event.type === "keydown") {
    if (printable || event.repeat) return;
    const keysym = physicalKeysym(event.key);
    if (keysym === null) return;
    pressedKeys.set(event.code, keysym);
    rfb.sendKey(keysym, event.code, true);
    event.preventDefault();
  } else {
    const keysym = pressedKeys.get(event.code);
    if (keysym === undefined) return;
    pressedKeys.delete(event.code);
    rfb.sendKey(keysym, event.code, false);
    event.preventDefault();
  }
}

function handleBeforeInput(event: InputEvent): void {
  if (!canSendInput() || event.inputType === "insertCompositionText") return;
  if (!event.inputType.startsWith("insert") || !event.data) return;
  sendCommittedText(event.data);
  suppressInputText = event.data;
  event.preventDefault();
}

function handleInput(event: InputEvent): void {
  const text = event.data ?? keyboardInput.value;
  keyboardInput.value = "";
  if (!canSendInput() || !text) {
    suppressInputText = null;
    return;
  }
  if (text !== suppressInputText) sendCommittedText(text);
  suppressInputText = null;
}

async function signOutViewer(): Promise<void> {
  if (!csrfToken || signOutPending || signOutAttempts >= MAX_SIGN_OUT_ATTEMPTS) return;
  signOutPending = true;
  controlExplicitlyRequested = false;
  if (rfb) rfb.viewOnly = true;
  setUi(ui);
  try {
    const response = await request("/api/sign-out");
    if (!response.ok) throw new Error("sign-out not confirmed");
    stopPolling();
    clearReconnectTimer();
    invalidateStatusRequests();
    transportEpoch += 1;
    transportConnected = false;
    rfb?.disconnect();
    rfb = null;
    csrfToken = null;
    signOutFailure = null;
    setUi({ kind: "pairing", error: null });
  } catch {
    signOutAttempts += 1;
    signOutFailure =
      signOutAttempts >= MAX_SIGN_OUT_ATTEMPTS
        ? "Sign-out was not confirmed. Retry limit reached; close this viewer and contact an operator."
        : "Sign-out was not confirmed. Retry to revoke this viewer session.";
    if (rfb) rfb.viewOnly = true;
    setUi(ui);
  } finally {
    signOutPending = false;
    setUi(ui);
  }
}

pairButton.addEventListener("click", () => void pair());
pairingCode.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void pair();
});
takeControl.addEventListener("click", () => void requestOwnership("/api/take-control"));
returnToAgent.addEventListener("click", () => void returnControl());
reclaimControl.addEventListener("click", () => {
  if (window.confirm("Reclaiming control revokes control from the other device. Continue?")) {
    void requestOwnership("/api/reclaim", { confirm: true });
  }
});
keyboardToggle.addEventListener("click", () => keyboardInput.focus());
keyboardInput.addEventListener("compositionstart", () => {
  composing = true;
});
keyboardInput.addEventListener("compositionend", () => {
  composing = false;
});
keyboardInput.addEventListener("keydown", forwardPhysicalKey);
keyboardInput.addEventListener("keyup", forwardPhysicalKey);
keyboardInput.addEventListener("beforeinput", handleBeforeInput);
keyboardInput.addEventListener("input", (event) => handleInput(event as InputEvent));
signOut.addEventListener("click", () => void signOutViewer());
window.addEventListener("resize", applyViewportScaling);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    startPolling();
    void refreshStatus();
  } else {
    stopPolling();
  }
});
window.addEventListener("pagehide", stopPolling);

setUi(ui);
