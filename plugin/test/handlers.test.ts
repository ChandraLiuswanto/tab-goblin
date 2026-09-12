import { describe, expect, it, vi } from "vitest";
import { createHandlers } from "../server/handlers.js";
import type { TabGoblinSettings } from "../shared/settings.js";

const SETTINGS = {
  enabled: false,
  enabledWorkspaceCwds: ["/w/one"],
  mcpCapableProviders: ["claude"],
  bridgeCommand: "node",
  bridgeArgs: [],
  socketPath: "/run/tabgoblin.sock",
  viewerUrl: "https://viewer.example",
};

describe("server RPC handlers", () => {
  it("forwards only the typed workspace scope to the gateway", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    const handlers = createHandlers({ request, notify: vi.fn(), close: vi.fn() }, { read: () => SETTINGS, write: vi.fn() });

    await expect(handlers.status({ workspaceId: "ws-1", cwd: "/w/one" })).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith({ op: "status", workspaceId: "ws-1" });
  });

  it("adds and removes an opted-in cwd without mutating the settings object", () => {
    let saved: TabGoblinSettings = SETTINGS;
    const handlers = createHandlers(
      { request: vi.fn(), notify: vi.fn(), close: vi.fn() },
      { read: () => saved, write: (next) => { saved = next; } },
    );

    expect(handlers.enableWorkspace({ cwd: "/w/two", enabled: true })).toEqual({ ok: true });
    expect(saved.enabledWorkspaceCwds).toEqual(["/w/one", "/w/two"]);
    expect(SETTINGS.enabledWorkspaceCwds).toEqual(["/w/one"]);
    handlers.enableWorkspace({ cwd: "/w/one", enabled: false });
    expect(saved.enabledWorkspaceCwds).toEqual(["/w/two"]);
  });
});
