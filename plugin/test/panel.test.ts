import { describe, expect, it } from "vitest";
import type { SessionStatus } from "@tab-goblin/protocol";
import {
  actionAvailability,
  describeState,
  initialEphemeralState,
  panelEphemeralReducer,
  pollInterval,
  sanitizeTabs,
  statusResponseIssue,
  viewerAddress,
} from "../client/panel-model.js";
import { filterActivity, sanitizeActivity } from "../client/activity-model.js";

const ready: SessionStatus = {
  workspaceId: "ws-1",
  sessionState: "ready",
  ownership: { state: "agent-ready", generation: 3, owner: null },
  startedAt: "2026-09-12T00:00:00.000Z",
  viewerUrl: "https://fedora.saga-skink.ts.net/",
  lastError: null,
};

describe("describeState", () => {
  it("says status unavailable — not disconnected — when the RPC fails", () => {
    const result = describeState({ rpcFailed: true, status: null });
    expect(result).toMatchObject({ tone: "unknown", headline: "Status unavailable" });
    expect(result.detail).toContain("may be stale");
    expect(result.detail).not.toMatch(/disconnected|offline|host is down/i);
  });

  it("reports a gateway-confirmed stopped session as stopped", () => {
    expect(describeState({ rpcFailed: false, status: { ...ready, sessionState: "stopped" } })).toMatchObject({
      headline: "Browser stopped",
      tone: "ok",
    });
  });

  it("names manual control and who holds it", () => {
    expect(describeState({
      rpcFailed: false,
      status: { ...ready, ownership: { state: "manual", generation: 4, owner: "viewer" } },
    }).headline).toBe("You have control");
  });

  it("does not claim instant cancellation while taking control", () => {
    const result = describeState({
      rpcFailed: false,
      status: { ...ready, ownership: { state: "taking-control", generation: 4, owner: null } },
    });
    expect(result.detail).toMatch(/finish/i);
    expect(result.detail).not.toMatch(/cancel(l)?ed|stopped immediately/i);
  });

  it("warns without pretending anything was rolled back in needs-attention", () => {
    const result = describeState({
      rpcFailed: false,
      status: { ...ready, ownership: { state: "needs-attention", generation: 4, owner: null } },
    });
    expect(result.tone).toBe("warn");
    expect(result.detail).toMatch(/uncertain|unknown/i);
    expect(result.detail).not.toMatch(/rolled back|undone/i);
  });
});

describe("panel request safety", () => {
  it("clears pairing material and action errors when the workspace scope changes", () => {
    const paired = panelEphemeralReducer(initialEphemeralState("host-a/ws-1"), {
      type: "pair-succeeded",
      scope: "host-a/ws-1",
      request: 1,
      code: "PAIR-SECRET",
      expiresAt: "2026-09-12T00:02:00Z",
    });
    const failed = panelEphemeralReducer(paired, {
      type: "action-failed",
      scope: "host-a/ws-1",
      request: 2,
      message: "old failure",
    });
    const switched = panelEphemeralReducer(failed, { type: "scope-changed", scope: "host-a/ws-2" });
    expect(switched.pairing).toBeNull();
    expect(switched.actionError).toBeNull();
  });

  it("drops late pairing and failure results from the previous workspace", () => {
    const switched = panelEphemeralReducer(initialEphemeralState("host-a/ws-1"), {
      type: "scope-changed",
      scope: "host-a/ws-2",
    });
    const latePair = panelEphemeralReducer(switched, {
      type: "pair-succeeded",
      scope: "host-a/ws-1",
      request: 4,
      code: "PAIR-SECRET",
      expiresAt: "later",
    });
    const lateError = panelEphemeralReducer(latePair, {
      type: "action-failed",
      scope: "host-a/ws-1",
      request: 5,
      message: "wrong workspace",
    });
    expect(lateError).toEqual(switched);
  });

  it("keeps only the latest same-scope pairing response", () => {
    const state = initialEphemeralState("host-a/ws-1");
    const latest = panelEphemeralReducer(state, {
      type: "pair-succeeded",
      scope: state.scope,
      request: 9,
      code: "LATEST",
      expiresAt: "later",
    });
    const stale = panelEphemeralReducer(latest, {
      type: "pair-succeeded",
      scope: state.scope,
      request: 8,
      code: "STALE",
      expiresAt: "earlier",
    });
    expect(stale.pairing?.code).toBe("LATEST");
  });

  it("backs status polling off after errors and caps it at thirty seconds", () => {
    expect(pollInterval(0)).toBe(3_000);
    expect(pollInterval(1)).toBe(6_000);
    expect(pollInterval(9)).toBe(30_000);
  });

  it("fails closed on cross-workspace and regressed ownership generations", () => {
    expect(statusResponseIssue({ ok: true, status: ready }, "ws-2", 0)).toBe("invalid_workspace_status");
    expect(statusResponseIssue({ ok: true, status: ready }, "ws-1", 4)).toBe("stale_ownership_generation");
    expect(statusResponseIssue({ ok: true, status: ready }, "ws-1", 3)).toBeNull();
  });

  it("disables mutating controls without confirmed current status", () => {
    expect(actionAvailability(null, false, true)).toEqual({ start: false, stop: false, viewer: false, pair: false, returnToAgent: false });
    expect(actionAvailability(ready, true, true)).toEqual({ start: false, stop: false, viewer: false, pair: false, returnToAgent: false });
  });

  it("offers return-to-agent only as an explicit action during manual ownership", () => {
    const manual = { ...ready, ownership: { state: "manual" as const, generation: 4, owner: "viewer" as const } };
    expect(actionAvailability(manual, false, true).returnToAgent).toBe(true);
    expect(actionAvailability(ready, false, true).returnToAgent).toBe(false);
  });
});

describe("bounded rendering and viewer links", () => {
  it("redacts, bounds, and caps hostile tab data", () => {
    const tabs = sanitizeTabs(Array.from({ length: 120 }, (_, index) => ({
      tabId: `tab-${index}`,
      active: index === 0,
      title: `${"x".repeat(260)}\u0000`,
      url: "https://user:secret@example.test/path?token=secret#private",
    })));
    expect(tabs).toHaveLength(100);
    expect(tabs[0]?.title.length).toBeLessThanOrEqual(200);
    expect(tabs[0]?.url).toBe("https://example.test/path");
    expect(JSON.stringify(tabs)).not.toContain("secret");
  });

  it("removes credentials, query tokens, and fragments from HTTPS viewer addresses", () => {
    expect(viewerAddress("https://user:password@viewer.test/live?token=secret#pair")).toBe("https://viewer.test/live");
  });

  it("fails closed for insecure non-loopback and non-web viewer addresses", () => {
    expect(viewerAddress("http://viewer.test/live")).toBeNull();
    expect(viewerAddress("javascript:alert(1)")).toBeNull();
    expect(viewerAddress("http://127.0.0.1:7000/live")).toBe("http://127.0.0.1:7000/live");
  });
});

describe("activity rendering", () => {
  const records = sanitizeActivity([
    { operationId: "1", source: "agent", tabId: "tab-1", action: "navigate", status: "ok", startedAt: "2026-09-12T00:00:00Z", endedAt: null, code: null, url: "https://example.test/?token=x", title: "Page" },
    { operationId: "2", source: "agent", tabId: "tab-1", action: "click", status: "error", startedAt: "2026-09-12T00:01:00Z", endedAt: null, code: "stale_ref", url: null, title: null },
  ]);

  it("renders newest first and keeps redacted bounded fields", () => {
    expect(records.map((record) => record.operationId)).toEqual(["2", "1"]);
    expect(records[1]?.url).toBe("https://example.test");
    expect(JSON.stringify(records)).not.toContain("token=x");
  });

  it("filters errors behaviorally", () => {
    expect(filterActivity(records, "errors").map((record) => record.operationId)).toEqual(["2"]);
  });
});
