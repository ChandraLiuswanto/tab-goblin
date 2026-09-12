import { describe, expect, it, vi } from "vitest";
import { createHandlers } from "../server/handlers.js";

const context = { paseo: { workspaces: { list: vi.fn().mockResolvedValue({ entries: [{ id: "ws-1", workspaceDirectory: "/w/one" }] }) } } } as any;
const lifecycle = { enableWorkspace: vi.fn().mockResolvedValue({ ok: true }), disableWorkspace: vi.fn().mockResolvedValue({ ok: true }) } as any;
describe("server RPC handlers", () => {
  it("validates the host workspace ID and cwd before forwarding", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true }); const handlers = createHandlers({ request, notify: vi.fn(), close: vi.fn() }, lifecycle);
    await expect(handlers.status({ workspaceId: "ws-1", cwd: "/w/one" }, context)).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith({ op: "status", workspaceId: "ws-1" });
    await expect(handlers.status({ workspaceId: "ws-1", cwd: "/wrong" }, context)).resolves.toMatchObject({ ok: false });
  });
  it("returns the coordinator acknowledgement for an opt-in", async () => {
    const request = vi.fn(); const handlers = createHandlers({ request, notify: vi.fn(), close: vi.fn() }, lifecycle);
    await expect(handlers.enableWorkspace({ workspaceId: "ws-1", cwd: "/w/one", enabled: true }, context)).resolves.toEqual({ ok: true });
    expect(lifecycle.enableWorkspace).toHaveBeenCalledWith("ws-1", "/w/one");
  });
});
