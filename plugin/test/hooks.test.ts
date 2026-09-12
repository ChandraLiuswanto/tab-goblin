import { describe, expect, it, vi } from "vitest";
import { ADMIN_SOCKET_ENV, ENROLLMENT_ENV } from "@tab-goblin/protocol";
import { registerHooks, shouldInject } from "../server/hooks.js";
import { defaultTabGoblinSettings } from "../shared/settings.js";

const SETTINGS = { ...defaultTabGoblinSettings, enabled: true, enabledWorkspaceCwds: ["/w/one"], socketPath: "/run/tabgoblin.sock", bridgeArgs: ["bridge.mjs"], workspaceGenerations: { "ws-1": 3 }, agentGenerations: { "agent-1": 4 } };
function fakeServer() { const before = new Map<string, any>(); const on = new Map<string, any>(); return { before: (name: string, fn: any) => (before.set(name, fn), () => before.delete(name)), on: (name: string, fn: any) => (on.set(name, fn), () => on.delete(name)), beforeHandlers: before, onHandlers: on } as any; }

describe("Claude-only scoped injection", () => {
  it("only injects into opted-in Claude workspaces", () => {
    expect(shouldInject(SETTINGS, { cwd: "/w/one", provider: "claude/2.1" })).toBe(true);
    expect(shouldInject(SETTINGS, { cwd: "/w/one", provider: "codex" })).toBe(false);
  });
  it("keeps static MCP configuration free of credentials and adds fresh session env", async () => {
    const server = fakeServer(); const request = vi.fn().mockResolvedValue({ ok: true }); const notify = vi.fn();
    registerHooks(server, { readSettings: () => SETTINGS, gateway: { request, notify }, newEnrollment: () => "synthetic-nonce", advanceAgentGeneration: vi.fn(), advanceWorkspaceGeneration: vi.fn() });
    const created = server.beforeHandlers.get("agent.create")({ request: { config: { provider: "claude", cwd: "/w/one", mcpServers: {} }, env: { KEEP: "1" } } });
    expect(created.config.mcpServers.tabgoblin).toEqual({ type: "stdio", command: "node", args: ["bridge.mjs"] });
    expect(JSON.stringify(created.config.mcpServers)).not.toContain("synthetic-nonce");
    const opened = await server.beforeHandlers.get("agent.session_open")({ request: { agentId: "agent-1", workspaceId: "ws-1", provider: "claude", cwd: "/w/one", purpose: "history", reason: "resume", env: { KEEP: "1" } } });
    expect(opened.env).toMatchObject({ KEEP: "1", [ADMIN_SOCKET_ENV]: "/run/tabgoblin.sock", [ENROLLMENT_ENV]: "synthetic-nonce" });
    expect(request).toHaveBeenCalledWith({ op: "record-enrollment", enrollment: "synthetic-nonce", cwd: "/w/one", workspaceId: "ws-1", workspaceGeneration: 3 });
    expect(notify).toHaveBeenCalledWith({ op: "session-open", agentId: "agent-1", workspaceId: "ws-1", purpose: "history", agentGeneration: 4, workspaceGeneration: 3 });
  });
  it("fails open when enrollment recording fails", async () => {
    const server = fakeServer(); registerHooks(server, { readSettings: () => SETTINGS, gateway: { request: vi.fn().mockRejectedValue(new Error("down")), notify: vi.fn() }, newEnrollment: () => "x", advanceAgentGeneration: vi.fn(), advanceWorkspaceGeneration: vi.fn() });
    await expect(server.beforeHandlers.get("agent.session_open")({ request: { agentId: "a", workspaceId: "ws-1", provider: "claude", cwd: "/w/one", purpose: "interactive", reason: "resume", env: {} } })).resolves.toBeUndefined();
  });
});
