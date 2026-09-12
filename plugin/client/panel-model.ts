import { boundedText, redactUrl, type AdminResponse, type SessionStatus, type Tab } from "@tab-goblin/protocol";

export type StateDescription = {
  headline: string;
  detail: string;
  tone: "ok" | "warn" | "unknown";
};

export function describeState(input: { rpcFailed: boolean; status: SessionStatus | null }): StateDescription {
  if (input.rpcFailed) {
    return {
      headline: "Status unavailable",
      detail: "The last successful status may be stale. Refresh after gateway access returns.",
      tone: "unknown",
    };
  }
  const status = input.status;
  if (!status) return { headline: "Checking browser", detail: "Waiting for a gateway-confirmed state.", tone: "unknown" };
  if (status.sessionState === "failed") {
    return {
      headline: "Browser needs attention",
      detail: status.lastError ? boundedText(`${status.lastError.code}: ${status.lastError.message}`, 260) : "The browser failed. Restart it explicitly when ready.",
      tone: "warn",
    };
  }
  if (status.sessionState === "stopped") return { headline: "Browser stopped", detail: "The persistent browser profile is kept.", tone: "ok" };
  if (status.sessionState === "starting") return { headline: "Browser starting", detail: "Waiting for the browser runtime to become ready.", tone: "unknown" };

  switch (status.ownership.state) {
    case "agent-ready":
      return { headline: "Browser ready", detail: "Agent automation may use the browser.", tone: "ok" };
    case "taking-control":
      return { headline: "Handoff in progress", detail: "An in-flight browser action may finish before manual control begins.", tone: "warn" };
    case "manual":
      return status.ownership.owner === "viewer"
        ? { headline: "You have control", detail: "Agent browser actions remain blocked until you explicitly return control.", tone: "ok" }
        : { headline: "Manual control active", detail: "Automation remains blocked until control is explicitly returned.", tone: "warn" };
    case "returning-control":
      return { headline: "Returning control", detail: "Viewer input is draining. Automation will not resume until the handoff finishes.", tone: "warn" };
    case "needs-attention":
      return { headline: "Control state needs attention", detail: "A prior operation has an uncertain or unknown result. Inspect status before choosing the next action.", tone: "warn" };
  }
}

export type SanitizedTab = Pick<Tab, "tabId" | "active"> & { title: string; url: string };

export function sanitizeTabs(tabs: readonly Tab[] | undefined): SanitizedTab[] {
  return (tabs ?? []).slice(0, 100).map((tab) => ({
    tabId: boundedText(tab.tabId, 64),
    active: tab.active,
    title: boundedText(tab.title || "Untitled tab", 200),
    url: redactUrl(tab.url),
  }));
}

function isLoopback(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

/** Returns a credential-free viewer address that is safe to copy or open. */
export function viewerAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) return null;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    const safe = parsed.toString();
    return parsed.pathname === "/" && !raw.split(/[?#]/, 1)[0]?.endsWith("/") ? safe.replace(/\/$/, "") : safe;
  } catch {
    return null;
  }
}

export function pollInterval(failureCount: number): number {
  const failures = Number.isSafeInteger(failureCount) && failureCount > 0 ? failureCount : 0;
  return Math.min(30_000, 3_000 * 2 ** Math.min(failures, 4));
}

export function actionAvailability(status: SessionStatus | null, rpcFailed: boolean, hasSafeViewerAddress: boolean) {
  if (rpcFailed || !status) return { start: false, stop: false, viewer: false, pair: false, returnToAgent: false };
  const ready = status.sessionState === "ready";
  return {
    start: status.sessionState === "stopped" || status.sessionState === "failed",
    stop: status.sessionState !== "stopped",
    viewer: ready && hasSafeViewerAddress,
    pair: ready && status.ownership.state === "agent-ready",
    returnToAgent: ready && (status.ownership.state === "manual" || status.ownership.state === "needs-attention"),
  };
}

/** Returns a safe reason to reject a status response, or null when it is current and in scope. */
export function statusResponseIssue(response: AdminResponse, workspaceId: string, minimumGeneration: number): string | null {
  if (!response.ok) return response.error.code;
  if (!response.status || response.status.workspaceId !== workspaceId) return "invalid_workspace_status";
  if (response.status.ownership.generation < minimumGeneration) return "stale_ownership_generation";
  return null;
}

export type PairingMaterial = { code: string; expiresAt: string };
export type PanelEphemeralState = {
  scope: string;
  latestRequest: number;
  pairing: PairingMaterial | null;
  actionError: string | null;
};

export type PanelEphemeralAction =
  | { type: "scope-changed"; scope: string }
  | { type: "request-started"; scope: string; request: number }
  | { type: "pair-succeeded"; scope: string; request: number; code: string; expiresAt: string }
  | { type: "action-failed"; scope: string; request: number; message: string }
  | { type: "clear-pairing"; scope: string }
  | { type: "clear-error"; scope: string };

export function initialEphemeralState(scope: string): PanelEphemeralState {
  return { scope, latestRequest: 0, pairing: null, actionError: null };
}

export function panelEphemeralReducer(state: PanelEphemeralState, action: PanelEphemeralAction): PanelEphemeralState {
  if (action.type === "scope-changed") {
    return action.scope === state.scope ? state : initialEphemeralState(action.scope);
  }
  if (action.scope !== state.scope) return state;
  if (action.type === "request-started") {
    return action.request < state.latestRequest ? state : { ...state, latestRequest: action.request, actionError: null };
  }
  if (action.type === "clear-pairing") return { ...state, pairing: null };
  if (action.type === "clear-error") return { ...state, actionError: null };
  if (action.request < state.latestRequest) return state;
  if (action.type === "pair-succeeded") {
    return {
      ...state,
      latestRequest: action.request,
      actionError: null,
      pairing: { code: boundedText(action.code, 64), expiresAt: boundedText(action.expiresAt, 64) },
    };
  }
  return { ...state, latestRequest: action.request, actionError: boundedText(action.message, 240) };
}
