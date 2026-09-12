import { describe, expect, it, vi } from "vitest";
import { createHandlers } from "../server/handlers.js";
import { defaultTabGoblinSettings } from "../shared/settings.js";

const context = { paseo: { workspaces: { list: vi.fn().mockResolvedValue({ entries: [{ id: "ws-1", workspaceDirectory: "/w/one" }] }) } } } as any;
function store(value = defaultTabGoblinSettings) { let current = value; return { read: () => current, update: async (change: any) => (current = change(current)), path: "/tmp/settings.json" }; }
describe("server RPC handlers", () => {
  it("validates the host workspace ID and cwd before forwarding", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true }); const handlers = createHandlers({ request, notify: vi.fn(), close: vi.fn() }, store());
    await expect(handlers.status({ workspaceId: "ws-1", cwd: "/w/one" }, context)).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith({ op: "status", workspaceId: "ws-1" });
    await expect(handlers.status({ workspaceId: "ws-1", cwd: "/wrong" }, context)).resolves.toMatchObject({ ok: false });
  });
  it("resets then durably enables a verified workspace", async () => {
    const settings = store({ ...defaultTabGoblinSettings, enabled: true }); const request = vi.fn().mockResolvedValue({ ok: true, lifecycleGeneration: 7 });
    const handlers = createHandlers({ request, notify: vi.fn(), close: vi.fn() }, settings);
    await expect(handlers.enableWorkspace({ workspaceId: "ws-1", cwd: "/w/one", enabled: true }, context)).resolves.toEqual({ ok: true });
    expect(settings.read().workspaceGenerations).toEqual({ "ws-1": 7 });
    expect(settings.read().enabledWorkspaceCwds).toEqual(["/w/one"]);
  });
});
