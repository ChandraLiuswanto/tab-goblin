import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfigStore } from "../server/config-store.js";
import { createLifecycleCoordinator } from "../server/lifecycle-coordinator.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function store() { const directory = mkdtempSync(join(tmpdir(), "tabgoblin-lifecycle-")); directories.push(directory); return createConfigStore(directory); }
const unavailable = { ok: false as const, error: { code: "runtime_unavailable", message: "down", retryable: true } };

describe("durable lifecycle coordinator", () => {
  it("keeps the master switch independent from workspace opt-in", async () => {
    const settings = store();
    const gateway = { request: vi.fn().mockResolvedValue({ ok: true, lifecycleGeneration: 1 }), notify: vi.fn(), close: vi.fn() } as any;
    const coordinator = createLifecycleCoordinator(settings, gateway);

    expect(coordinator.settings().enabled).toBe(false);
    await expect(coordinator.enableWorkspace("ws", "/w")).resolves.toEqual({ ok: true });
    expect(coordinator.settings()).toMatchObject({ enabled: false, enabledWorkspaceCwds: ["/w"] });
    await expect(coordinator.setGlobalEnabled(true)).resolves.toEqual({ ok: true });
    expect(coordinator.settings()).toMatchObject({ enabled: true, enabledWorkspaceCwds: ["/w"] });
  });

  it("does not re-enable globally while a prior authority revocation remains pending", async () => {
    const settings = store();
    await settings.update((current) => ({ ...current, pendingRevocations: [{ kind: "workspace", id: "ws" }], workspaceGenerations: { ws: 3 } }));
    const gateway = { request: vi.fn().mockResolvedValue(unavailable), notify: vi.fn(), close: vi.fn() } as any;
    const coordinator = createLifecycleCoordinator(settings, gateway);

    await expect(coordinator.setGlobalEnabled(true)).resolves.toEqual({ ok: false });
    expect(settings.read().enabled).toBe(false);
    expect(settings.read().pendingRevocations).toEqual([{ kind: "workspace", id: "ws" }]);
  });

  it("durably disables globally before revoking current workspace and agent identities", async () => {
    const settings = store();
    await settings.update((current) => ({ ...current, enabled: true, enabledWorkspaceCwds: ["/w"], workspaceGenerations: { ws: 3 }, activeAgentIds: ["agent"] }));
    const observedEnabled: boolean[] = [];
    const observedPending: unknown[] = [];
    const gateway = { request: vi.fn(async () => { observedEnabled.push(settings.read().enabled); observedPending.push(settings.read().pendingRevocations); return { ok: true, lifecycleGeneration: 4 }; }), notify: vi.fn(), close: vi.fn() } as any;
    const coordinator = createLifecycleCoordinator(settings, gateway);

    await expect(coordinator.setGlobalEnabled(false)).resolves.toEqual({ ok: true });
    expect(observedEnabled).toEqual([false, false]);
    expect(observedPending[0]).toEqual([{ kind: "workspace", id: "ws" }, { kind: "agent", id: "agent" }]);
    expect(gateway.request.mock.calls.map(([body]: any[]) => body)).toEqual([
      { op: "revoke-workspace", workspaceId: "ws" },
      { op: "revoke-agent", agentId: "agent" },
    ]);
    expect(settings.read()).toMatchObject({ enabled: false, pendingRevocations: [], revokedWorkspaceIds: ["ws"], revokedAgentIds: ["agent"] });
  });

  it("updates connection settings through socket synchronization before acknowledging the mutation", async () => {
    const settings = store();
    let activeSocket = "/tmp/old.sock";
    const gateway = {
      socketPath: vi.fn(() => activeSocket),
      switchSocketPath: vi.fn(async (socketPath: string, _revocations: unknown[], hooks: any) => { await hooks.beforeRevocations(); await hooks.commit([]); activeSocket = socketPath; return { ok: true, responses: [] }; }),
      request: vi.fn(), notify: vi.fn(), close: vi.fn(),
    } as any;
    const coordinator = createLifecycleCoordinator(settings, gateway);

    await expect(coordinator.updateConnection({ socketPath: "/tmp/new.sock", viewerUrl: "https://viewer.test/" })).resolves.toEqual({ ok: true });
    expect(gateway.switchSocketPath).toHaveBeenCalledWith("/tmp/new.sock", [], expect.objectContaining({ beforeRevocations: expect.any(Function), commit: expect.any(Function) }));
    expect(settings.read()).toMatchObject({ socketPath: "/tmp/new.sock", viewerUrl: "https://viewer.test/" });
  });

  it("does not report a socket update as active when old authority revocation blocks the switch", async () => {
    const settings = store();
    await settings.update((current) => ({ ...current, workspaceGenerations: { ws: 2 } }));
    const gateway = {
      socketPath: vi.fn(() => "/tmp/old.sock"),
      switchSocketPath: vi.fn(async (_socketPath: string, _revocations: unknown[], hooks: any) => { await hooks.beforeRevocations(); return { ok: false, responses: [unavailable] }; }),
      request: vi.fn(), notify: vi.fn(), close: vi.fn(),
    } as any;
    const coordinator = createLifecycleCoordinator(settings, gateway);

    await expect(coordinator.updateConnection({ socketPath: "/tmp/new.sock", viewerUrl: "" })).resolves.toEqual({ ok: false });
    expect(settings.read().pendingRevocations).toEqual([{ kind: "workspace", id: "ws" }]);
  });

  it("does not report opt-out success or advance state until the revoke is acknowledged, then replays it after reload", async () => {
    const settings = store(); await settings.update((current) => ({ ...current, enabled: true, enabledWorkspaceCwds: ["/w"], workspaceGenerations: { ws: 7 } }));
    const firstGateway = { request: vi.fn().mockResolvedValue(unavailable), notify: vi.fn(), close: vi.fn() } as any;
    const first = createLifecycleCoordinator(settings, firstGateway);
    await expect(first.disableWorkspace("ws", "/w")).resolves.toEqual({ ok: false });
    expect(settings.read().enabledWorkspaceCwds).toEqual(["/w"]);
    expect(settings.read().workspaceGenerations).toEqual({ ws: 7 });
    expect(settings.read().pendingRevocations).toEqual([{ kind: "workspace", id: "ws" }]);
    const secondGateway = { request: vi.fn().mockResolvedValue({ ok: true, lifecycleGeneration: 8 }), notify: vi.fn(), close: vi.fn() } as any;
    const reloaded = createLifecycleCoordinator(createConfigStore(dirname(settings.path)), secondGateway);
    await reloaded.replayPending();
    expect(secondGateway.request).toHaveBeenCalledWith({ op: "revoke-workspace", workspaceId: "ws" }, expect.any(Number));
    expect(reloaded.settings().pendingRevocations).toEqual([]);
  });

  it("keeps a revoke pending when a protocol-valid success omits its lifecycle generation", async () => {
    const settings = store(); await settings.update((current) => ({ ...current, workspaceGenerations: { ws: 3 } }));
    const gateway = { request: vi.fn().mockResolvedValue({ ok: true }), notify: vi.fn(), close: vi.fn() } as any;
    const coordinator = createLifecycleCoordinator(settings, gateway);
    await expect(coordinator.revokeWorkspace("ws")).resolves.toBe(false);
    expect(settings.read().pendingRevocations).toEqual([{ kind: "workspace", id: "ws" }]);
    expect(settings.read().workspaceGenerations.ws).toBe(3);
    expect(settings.read().revokedWorkspaceIds).toEqual([]);
  });

  it("does not retry an old-socket revoke on the replacement socket after a successful switch", async () => {
    const settings = store(); await settings.update((current) => ({ ...current, socketPath: "/new.sock", workspaceGenerations: { ws: 3 } }));
    let activeSocket = "/old.sock";
    const acknowledged = { ok: true as const, lifecycleGeneration: 8 };
    const gateway = { socketPath: vi.fn(() => activeSocket), switchSocketPath: vi.fn(async (socketPath: string, _revocations: unknown[], hooks: any) => { await hooks.beforeRevocations(); await hooks.commit([acknowledged]); activeSocket = socketPath; return { ok: true, responses: [acknowledged] }; }), request: vi.fn(), notify: vi.fn(), close: vi.fn() } as any;
    const coordinator = createLifecycleCoordinator(settings, gateway);
    await coordinator.revokeWorkspace("ws");
    expect(gateway.switchSocketPath).toHaveBeenCalledWith("/new.sock", [{ op: "revoke-workspace", workspaceId: "ws" }], expect.objectContaining({ beforeRevocations: expect.any(Function), commit: expect.any(Function) }), undefined);
    expect(gateway.request).not.toHaveBeenCalled();
    expect(settings.read().workspaceGenerations.ws).toBe(8);
  });

  it("keeps the old socket and all intents when a switch acknowledgement omits its lifecycle generation", async () => {
    const settings = store(); await settings.update((current) => ({ ...current, socketPath: "/new.sock", workspaceGenerations: { ws: 3 } }));
    const gateway = { socketPath: vi.fn(() => "/old.sock"), switchSocketPath: vi.fn(async (_socketPath: string, _revocations: unknown[], hooks: any) => { await hooks.beforeRevocations(); return { ok: false, responses: [{ ok: true }] }; }), request: vi.fn().mockResolvedValue({ ok: true }), notify: vi.fn(), close: vi.fn() } as any;
    const coordinator = createLifecycleCoordinator(settings, gateway);
    await coordinator.revokeWorkspace("ws");
    expect(settings.read().pendingRevocations).toEqual([{ kind: "workspace", id: "ws" }]);
    expect(settings.read().revokedWorkspaceIds).toEqual([]);
  });

  it("persists the exact acknowledged revocation generation with its revoked marker", async () => {
    const settings = store(); await settings.update((current) => ({ ...current, agentGenerations: { agent: 2 }, workspaceGenerations: { ws: 3 } }));
    const gateway = { request: vi.fn().mockResolvedValue({ ok: true, lifecycleGeneration: 9 }), notify: vi.fn(), close: vi.fn() } as any;
    const coordinator = createLifecycleCoordinator(settings, gateway);
    await coordinator.revokeAgent("agent"); await coordinator.revokeWorkspace("ws");
    expect(settings.read().agentGenerations.agent).toBe(9);
    expect(settings.read().workspaceGenerations.ws).toBe(9);
    expect(settings.read().revokedAgentIds).toEqual(["agent"]);
    expect(settings.read().revokedWorkspaceIds).toEqual(["ws"]);
  });

  it("reconciles durable nonzero generations after a gateway identity change without reviving tombstones", async () => {
    const initial = store();
    await initial.update((current) => ({
      ...current,
      gatewayInstanceId: "11111111-1111-4111-8111-111111111111",
      enabled: true,
      enabledWorkspaceCwds: ["/live", "/revoked"],
      activeAgentIds: ["live-agent"],
      agentGenerations: { "live-agent": 3, "revoked-agent": 4 },
      workspaceGenerations: { "live-workspace": 5, "revoked-workspace": 6 },
      revokedAgentIds: ["revoked-agent"],
      revokedWorkspaceIds: ["revoked-workspace"],
    }));
    // Reopen the same durable config against a new, empty gateway process.
    const settings = createConfigStore(dirname(initial.path));
    const calls: any[] = [];
    const gateway = { request: vi.fn(async (body) => {
      calls.push(body);
      if (body.op === "health") return { ok: true, protocolVersion: 1, gatewayInstanceId: "22222222-2222-4222-8222-222222222222" };
      if (body.op === "reset-agent") return { ok: true, lifecycleGeneration: 11 };
      if (body.op === "reset-workspace") return { ok: true, lifecycleGeneration: body.workspaceId === "revoked-workspace" ? 21 : 12 };
      if (body.op.startsWith("revoke-")) return { ok: true, lifecycleGeneration: 13 };
      return { ok: true };
    }), notify: vi.fn(), close: vi.fn() } as any;
    const coordinator = createLifecycleCoordinator(settings, gateway);

    await expect(coordinator.openSession({ agentId: "live-agent", workspaceId: "live-workspace", cwd: "/live", purpose: "interactive", enrollment: "11111111-1111-4111-8111-111111111111" })).resolves.toEqual({ socketPath: settings.read().socketPath, agentGeneration: 11, workspaceGeneration: 12 });
    expect(calls.slice(0, 8)).toEqual([
      { op: "health" },
      { op: "reset-agent", agentId: "live-agent" },
      { op: "revoke-agent", agentId: "revoked-agent" },
      { op: "reset-workspace", workspaceId: "live-workspace" },
      { op: "revoke-workspace", workspaceId: "revoked-workspace" },
      { op: "record-enrollment", enrollment: "11111111-1111-4111-8111-111111111111", cwd: "/live", workspaceId: "live-workspace", workspaceGeneration: 12 },
      { op: "bind-enrollment", cwd: "/live", agentId: "live-agent", workspaceId: "live-workspace", agentGeneration: 11, workspaceGeneration: 12 },
      { op: "session-open", agentId: "live-agent", workspaceId: "live-workspace", purpose: "interactive", agentGeneration: 11, workspaceGeneration: 12 },
    ]);
    expect(settings.read()).toMatchObject({ gatewayInstanceId: "22222222-2222-4222-8222-222222222222", revokedAgentIds: ["revoked-agent"], revokedWorkspaceIds: ["revoked-workspace"] });

    // No session request is an implicit tombstone reset.
    await expect(coordinator.openSession({ agentId: "revoked-agent", workspaceId: "live-workspace", cwd: "/live", purpose: "interactive", enrollment: "33333333-3333-4333-8333-333333333333" })).resolves.toBeUndefined();
    await expect(coordinator.openSession({ agentId: "new-agent", workspaceId: "revoked-workspace", cwd: "/revoked", purpose: "interactive", enrollment: "44444444-4444-4444-8444-444444444444" })).resolves.toBeUndefined();
    expect(calls.filter((body) => body.op === "record-enrollment")).toHaveLength(1);

    // Explicit workspace opt-in is the only reset path, and preserves exact IDs.
    await expect(coordinator.enableWorkspace("revoked-workspace", "/revoked")).resolves.toEqual({ ok: true });
    await expect(coordinator.openSession({ agentId: "new-agent", workspaceId: "revoked-workspace", cwd: "/revoked", purpose: "interactive", enrollment: "44444444-4444-4444-8444-444444444444" })).resolves.toMatchObject({ workspaceGeneration: 21 });
    expect(calls).toContainEqual({ op: "reset-workspace", workspaceId: "revoked-workspace" });
  });

  it("persists cleanup intent before a failed revoke and leaves the workspace fail-closed", async () => {
    const settings = store(); await settings.update((current) => ({ ...current, gatewayInstanceId: "11111111-1111-4111-8111-111111111111", enabled: true, enabledWorkspaceCwds: ["/w"], workspaceGenerations: { ws: 5 } }));
    const gateway = { request: vi.fn(async (body) => body.op === "health"
      ? { ok: true, protocolVersion: 1, gatewayInstanceId: "11111111-1111-4111-8111-111111111111" }
      : gateway.request.mock.calls.filter(([request]: any[]) => request.op === "revoke-workspace").length === 1 ? unavailable : { ok: true, lifecycleGeneration: 7 }), notify: vi.fn(), close: vi.fn() } as any;
    const coordinator = createLifecycleCoordinator(settings, gateway);
    await coordinator.cleanup();
    expect(settings.read().pendingRevocations).toEqual([{ kind: "workspace", id: "ws" }]);
    await coordinator.replayPending();
    await expect(coordinator.openSession({ agentId: "new", workspaceId: "ws", cwd: "/w", purpose: "interactive", enrollment: "11111111-1111-4111-8111-111111111111" })).resolves.toBeUndefined();
    expect(gateway.request.mock.calls.map(([body]: any[]) => body.op)).toEqual(["revoke-workspace", "revoke-workspace", "health"]);
    expect(settings.read().revokedWorkspaceIds).toEqual(["ws"]);
  });

  it("serializes deferred enables so an older response cannot roll back a newer generation", async () => {
    const settings = store(); await settings.update((current) => ({ ...current, enabled: true }));
    let releaseFirst!: (value: unknown) => void; const firstResponse = new Promise((resolve) => { releaseFirst = resolve; });
    const request = vi.fn().mockReturnValueOnce(firstResponse).mockResolvedValueOnce({ ok: true, lifecycleGeneration: 8 });
    const coordinator = createLifecycleCoordinator(settings, { request, notify: vi.fn(), close: vi.fn() } as any);
    const first = coordinator.enableWorkspace("ws", "/w"); const second = coordinator.enableWorkspace("ws", "/w");
    await new Promise((resolve) => setTimeout(resolve, 0)); expect(request).toHaveBeenCalledTimes(1);
    releaseFirst({ ok: true, lifecycleGeneration: 7 });
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(settings.read().workspaceGenerations.ws).toBe(8);
  });
});

function dirname(path: string): string { return path.slice(0, path.lastIndexOf("/")); }
