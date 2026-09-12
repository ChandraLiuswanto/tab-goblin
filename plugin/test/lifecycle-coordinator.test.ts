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
    const gateway = { socketPath: vi.fn(() => "/old.sock"), switchSocketPath: vi.fn().mockResolvedValue([{ ok: true, lifecycleGeneration: 8 }]), request: vi.fn(), notify: vi.fn(), close: vi.fn() } as any;
    const coordinator = createLifecycleCoordinator(settings, gateway);
    await coordinator.revokeWorkspace("ws");
    expect(gateway.switchSocketPath).toHaveBeenCalledWith("/new.sock", [{ op: "revoke-workspace", workspaceId: "ws" }], undefined);
    expect(gateway.request).not.toHaveBeenCalled();
    expect(settings.read().workspaceGenerations.ws).toBe(8);
  });

  it("keeps the old socket and all intents when a switch acknowledgement omits its lifecycle generation", async () => {
    const settings = store(); await settings.update((current) => ({ ...current, socketPath: "/new.sock", workspaceGenerations: { ws: 3 } }));
    const gateway = { socketPath: vi.fn(() => "/old.sock"), switchSocketPath: vi.fn().mockResolvedValue([{ ok: true }]), request: vi.fn().mockResolvedValue({ ok: true }), notify: vi.fn(), close: vi.fn() } as any;
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

  it("resets a previously revoked agent and persists the returned generation before recording enrollment", async () => {
    const settings = store(); await settings.update((current) => ({ ...current, enabled: true, enabledWorkspaceCwds: ["/w"], workspaceGenerations: { ws: 2 }, agentGenerations: { agent: 3 }, revokedAgentIds: ["agent"] }));
    const calls: unknown[] = []; const gateway = { request: vi.fn(async (body) => { calls.push(body); return body.op === "reset-agent" ? { ok: true, lifecycleGeneration: 9 } : { ok: true }; }), notify: vi.fn(), close: vi.fn() } as any;
    const coordinator = createLifecycleCoordinator(settings, gateway);
    await expect(coordinator.openSession({ agentId: "agent", workspaceId: "ws", cwd: "/w", purpose: "interactive", enrollment: "11111111-1111-4111-8111-111111111111" })).resolves.toMatchObject({ agentGeneration: 9, workspaceGeneration: 2 });
    expect(calls).toEqual([
      { op: "reset-agent", agentId: "agent" },
      { op: "record-enrollment", enrollment: "11111111-1111-4111-8111-111111111111", cwd: "/w", workspaceId: "ws", workspaceGeneration: 2 },
      { op: "bind-enrollment", cwd: "/w", agentId: "agent", workspaceId: "ws", agentGeneration: 9, workspaceGeneration: 2 },
      { op: "session-open", agentId: "agent", workspaceId: "ws", purpose: "interactive", agentGeneration: 9, workspaceGeneration: 2 },
    ]);
    expect(settings.read().agentGenerations.agent).toBe(9);
  });

  it("persists cleanup intent before a failed revoke and resets only the still-enabled workspace", async () => {
    const settings = store(); await settings.update((current) => ({ ...current, enabled: true, enabledWorkspaceCwds: ["/w"], workspaceGenerations: { ws: 5 } }));
    const gateway = { request: vi.fn().mockResolvedValueOnce(unavailable).mockResolvedValueOnce({ ok: true, lifecycleGeneration: 7 }).mockResolvedValueOnce({ ok: true, lifecycleGeneration: 8 }).mockResolvedValue({ ok: true }), notify: vi.fn(), close: vi.fn() } as any;
    const coordinator = createLifecycleCoordinator(settings, gateway);
    await coordinator.cleanup();
    expect(settings.read().pendingRevocations).toEqual([{ kind: "workspace", id: "ws" }]);
    await coordinator.replayPending();
    await expect(coordinator.openSession({ agentId: "new", workspaceId: "ws", cwd: "/w", purpose: "interactive", enrollment: "11111111-1111-4111-8111-111111111111" })).resolves.toMatchObject({ workspaceGeneration: 8 });
    expect(gateway.request.mock.calls.map(([body]: any[]) => body.op)).toEqual(["revoke-workspace", "revoke-workspace", "reset-workspace", "record-enrollment", "bind-enrollment", "session-open"]);
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
