import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnrollmentRegistry } from "../../packages/gateway/src/enrollment.js";
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
      { op: "bind-enrollment", enrollment: "11111111-1111-4111-8111-111111111111", cwd: "/live", agentId: "live-agent", workspaceId: "live-workspace", agentGeneration: 11, workspaceGeneration: 12 },
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

  it("binds the retry nonce when an earlier recorded nonce response was lost", async () => {
    const settings = store();
    const gatewayInstanceId = "11111111-1111-4111-8111-111111111111";
    const firstNonce = "22222222-2222-4222-8222-222222222222";
    const retryNonce = "33333333-3333-4333-8333-333333333333";
    await settings.update((current) => ({
      ...current,
      gatewayInstanceId,
      enabled: true,
      enabledWorkspaceCwds: ["/w"],
    }));
    const registry = new EnrollmentRegistry();
    let loseFirstRecordResponse = true;
    const gateway = { request: vi.fn(async (body: any) => {
      if (body.op === "health") return { ok: true, protocolVersion: 1, gatewayInstanceId };
      if (body.op === "record-enrollment") {
        registry.record(body.enrollment, body.cwd, body.workspaceId, body.workspaceGeneration);
        if (body.enrollment === firstNonce && loseFirstRecordResponse) {
          loseFirstRecordResponse = false;
          throw new Error("record response lost");
        }
        return { ok: true };
      }
      if (body.op === "bind-enrollment") {
        const binding = registry.bind(body.enrollment, body.cwd, body.agentId, body.workspaceId, {
          agentGeneration: body.agentGeneration,
          workspaceGeneration: body.workspaceGeneration,
        });
        return binding
          ? { ok: true }
          : { ok: false, error: { code: "auth_failed", message: "no exact pending enrollment", retryable: false } };
      }
      if (body.op === "session-open") {
        registry.noteSessionOpen(body.agentId, body.workspaceId, body.purpose, {
          agentGeneration: body.agentGeneration,
          workspaceGeneration: body.workspaceGeneration,
        });
        return { ok: true };
      }
      throw new Error(`unexpected operation: ${body.op}`);
    }), notify: vi.fn(), close: vi.fn() } as any;
    const coordinator = createLifecycleCoordinator(settings, gateway);
    const session = { agentId: "agent", workspaceId: "ws", cwd: "/w", purpose: "interactive" as const };

    await expect(coordinator.openSession({ ...session, enrollment: firstNonce })).resolves.toBeUndefined();
    await expect(registry.authorize(firstNonce)).rejects.toMatchObject({ code: "not_enrolled" });
    await expect(coordinator.openSession({ ...session, enrollment: retryNonce })).resolves.toEqual({
      socketPath: settings.read().socketPath,
      agentGeneration: 0,
      workspaceGeneration: 0,
    });
    await expect(registry.authorize(retryNonce)).resolves.toMatchObject({
      enrollment: retryNonce,
      agentId: "agent",
      workspaceId: "ws",
      cwd: "/w",
    });
    await expect(registry.authorize(firstNonce)).rejects.toMatchObject({ code: "not_enrolled" });
    expect(gateway.request.mock.calls
      .map(([body]: any[]) => body)
      .filter((body: any) => body.op === "bind-enrollment"))
      .toEqual([expect.objectContaining({ enrollment: retryNonce })]);
  });

  it("rotates cleanup credentials across reload on the same gateway without clearing archive tombstones", async () => {
    const initial = store();
    await initial.update((current) => ({ ...current, gatewayInstanceId: "11111111-1111-4111-8111-111111111111", enabled: true, enabledWorkspaceCwds: ["/w"], activeAgentIds: ["agent"], agentGenerations: { agent: 4 }, workspaceGenerations: { ws: 5 }, revokedWorkspaceIds: ["archived"] }));
    const calls: any[] = [];
    const gateway = { request: vi.fn(async (body) => {
      calls.push(body);
      if (body.op === "health") return { ok: true, protocolVersion: 1, gatewayInstanceId: "11111111-1111-4111-8111-111111111111" };
      if (body.op === "revoke-agent") return { ok: true, lifecycleGeneration: 6 };
      if (body.op === "revoke-workspace") return { ok: true, lifecycleGeneration: 7 };
      if (body.op === "reset-agent") return { ok: true, lifecycleGeneration: 8 };
      if (body.op === "reset-workspace") return { ok: true, lifecycleGeneration: 9 };
      return { ok: true };
    }), notify: vi.fn(), close: vi.fn() } as any;
    await createLifecycleCoordinator(initial, gateway).cleanup();
    expect(initial.read()).toMatchObject({ rotatingAgentIds: ["agent"], rotatingWorkspaceIds: ["ws"], revokedWorkspaceIds: ["archived"] });

    // Reload preserves only the cleanup rotation, then admits a fresh nonce.
    const settings = createConfigStore(dirname(initial.path));
    const coordinator = createLifecycleCoordinator(settings, gateway);
    await expect(coordinator.openSession({ agentId: "agent", workspaceId: "ws", cwd: "/w", purpose: "interactive", enrollment: "22222222-2222-4222-8222-222222222222" })).resolves.toMatchObject({ agentGeneration: 8, workspaceGeneration: 9 });
    expect(calls).toContainEqual({ op: "record-enrollment", enrollment: "22222222-2222-4222-8222-222222222222", cwd: "/w", workspaceId: "ws", workspaceGeneration: 9 });
    expect(settings.read()).toMatchObject({ rotatingAgentIds: [], rotatingWorkspaceIds: [], revokedWorkspaceIds: ["archived"], agentGenerations: { agent: 8 } });
    await expect(coordinator.openSession({ agentId: "new", workspaceId: "archived", cwd: "/w", purpose: "interactive", enrollment: "33333333-3333-4333-8333-333333333333" })).resolves.toBeUndefined();
  });

  it("lets an explicit archive override a cleanup rotation and remain closed on reopen", async () => {
    const settings = store();
    await settings.update((current) => ({ ...current, gatewayInstanceId: "11111111-1111-4111-8111-111111111111", enabled: true, enabledWorkspaceCwds: ["/w"], activeAgentIds: ["agent"], agentGenerations: { agent: 2 }, workspaceGenerations: { ws: 3 } }));
    const calls: any[] = [];
    const gateway = { request: vi.fn(async (body) => {
      calls.push(body);
      if (body.op === "health") return { ok: true, protocolVersion: 1, gatewayInstanceId: "11111111-1111-4111-8111-111111111111" };
      return body.op.startsWith("revoke-") ? { ok: true, lifecycleGeneration: 4 } : { ok: true };
    }), notify: vi.fn(), close: vi.fn() } as any;
    const coordinator = createLifecycleCoordinator(settings, gateway);

    await coordinator.cleanup();
    expect(settings.read()).toMatchObject({ rotatingWorkspaceIds: ["ws"], revokedWorkspaceIds: [] });
    await expect(coordinator.revokeWorkspace("ws")).resolves.toBe(true);
    expect(settings.read()).toMatchObject({ rotatingWorkspaceIds: [], revokedWorkspaceIds: ["ws"] });

    await expect(coordinator.openSession({ agentId: "agent", workspaceId: "ws", cwd: "/w", purpose: "interactive", enrollment: "44444444-4444-4444-8444-444444444444" })).resolves.toBeUndefined();
    expect(calls.filter((body) => body.op === "reset-workspace" || body.op === "record-enrollment")).toEqual([]);
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
