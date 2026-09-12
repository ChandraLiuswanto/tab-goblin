import { describe, expect, it, vi } from "vitest";
import { defaultTabGoblinSettings } from "../shared/settings.js";
import { createHandlers } from "../server/handlers.js";

const context = { paseo: { workspaces: { list: vi.fn().mockResolvedValue({ entries: [{ id: "ws-1", workspaceDirectory: "/w/one" }] }) } } } as any;
function lifecycle(overrides: Record<string, unknown> = {}) {
  return {
    settings: vi.fn(() => ({
      ...defaultTabGoblinSettings,
      activeAgentIds: ["must-not-leak"],
      agentGenerations: { "must-not-leak": 3 },
    })),
    enableWorkspace: vi.fn().mockResolvedValue({ ok: true }),
    disableWorkspace: vi.fn().mockResolvedValue({ ok: true }),
    setGlobalEnabled: vi.fn().mockResolvedValue({ ok: true }),
    updateConnection: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as any;
}

describe("server RPC handlers", () => {
  it("validates the host workspace ID and cwd before forwarding status and tabs", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    const handlers = createHandlers({ request, notify: vi.fn(), close: vi.fn() }, lifecycle());
    await expect(handlers.status({ workspaceId: "ws-1", cwd: "/w/one" }, context)).resolves.toEqual({ ok: true });
    await expect(handlers.tabs({ workspaceId: "ws-1", cwd: "/w/one" }, context)).resolves.toEqual({ ok: true });
    expect(request.mock.calls.map(([body]) => body)).toEqual([
      { op: "status", workspaceId: "ws-1" },
      { op: "tabs", workspaceId: "ws-1" },
    ]);
    await expect(handlers.tabs({ workspaceId: "ws-1", cwd: "/wrong" }, context)).resolves.toMatchObject({ ok: false });
  });

  it("returns only the authoritative non-secret configuration projection", async () => {
    const state = {
      ...defaultTabGoblinSettings,
      enabled: true,
      enabledWorkspaceCwds: ["/w/one"],
      socketPath: "/tmp/tabgoblin.sock",
      viewerUrl: "https://viewer.test/",
      activeAgentIds: ["agent-secret"],
      agentGenerations: { "agent-secret": 7 },
    };
    const handlers = createHandlers({ request: vi.fn(), notify: vi.fn(), close: vi.fn() }, lifecycle({ settings: vi.fn(() => state) }));

    const result = await handlers.config({ workspaceId: "ws-1", cwd: "/w/one" }, context);
    expect(result).toEqual({
      ok: true,
      globallyEnabled: true,
      workspaceEnabled: true,
      effectiveEnabled: true,
      socketPath: "/tmp/tabgoblin.sock",
      viewerUrl: "https://viewer.test/",
    });
    expect(JSON.stringify(result)).not.toMatch(/agent-secret|generation|activeAgent/i);
  });

  it("routes master and connection mutations through the lifecycle coordinator", async () => {
    const coordinator = lifecycle();
    const handlers = createHandlers({ request: vi.fn(), notify: vi.fn(), close: vi.fn() }, coordinator);

    await expect(handlers.setGlobalEnabled({ workspaceId: "ws-1", cwd: "/w/one", enabled: true }, context)).resolves.toEqual({ ok: true });
    await expect(handlers.updateConnection({ workspaceId: "ws-1", cwd: "/w/one", socketPath: "/tmp/next.sock", viewerUrl: "https://viewer.test/" }, context)).resolves.toEqual({ ok: true });
    expect(coordinator.setGlobalEnabled).toHaveBeenCalledWith(true);
    expect(coordinator.updateConnection).toHaveBeenCalledWith({ socketPath: "/tmp/next.sock", viewerUrl: "https://viewer.test/" });
  });

  it("rejects config reads and mutations for a mismatched workspace", async () => {
    const coordinator = lifecycle();
    const handlers = createHandlers({ request: vi.fn(), notify: vi.fn(), close: vi.fn() }, coordinator);
    await expect(handlers.config({ workspaceId: "ws-1", cwd: "/wrong" }, context)).resolves.toEqual({ ok: false });
    await expect(handlers.setGlobalEnabled({ workspaceId: "ws-1", cwd: "/wrong", enabled: true }, context)).resolves.toEqual({ ok: false });
    expect(coordinator.setGlobalEnabled).not.toHaveBeenCalled();
  });

  it("returns the coordinator acknowledgement for an opt-in without changing the master switch", async () => {
    const coordinator = lifecycle();
    const handlers = createHandlers({ request: vi.fn(), notify: vi.fn(), close: vi.fn() }, coordinator);
    await expect(handlers.enableWorkspace({ workspaceId: "ws-1", cwd: "/w/one", enabled: true }, context)).resolves.toEqual({ ok: true });
    expect(coordinator.enableWorkspace).toHaveBeenCalledWith("ws-1", "/w/one");
    expect(coordinator.setGlobalEnabled).not.toHaveBeenCalled();
  });
});
