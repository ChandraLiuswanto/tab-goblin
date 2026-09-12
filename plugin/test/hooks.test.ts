import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_SOCKET_ENV, ENROLLMENT_ENV } from "@tab-goblin/protocol";
import { createConfigStore } from "../server/config-store.js";
import { registerHooks, shouldInject } from "../server/hooks.js";
import { createLifecycleCoordinator } from "../server/lifecycle-coordinator.js";
import { createTabGoblinSettingsSchema } from "../shared/settings.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const defaultTabGoblinSettings = createTabGoblinSettingsSchema({ bridgeCommand: "node", bridgeArgs: [], socketPath: "/run/tabgoblin.sock" }).parse({});
const SETTINGS = { ...defaultTabGoblinSettings, enabled: true, enabledWorkspaceCwds: ["/w/one"], bridgeArgs: ["bridge.mjs"], workspaceGenerations: { "ws-1": 3 }, agentGenerations: { "agent-1": 4 } };
function fakeServer() { const before = new Map<string, any>(); const on = new Map<string, any>(); return { before: (name: string, fn: any) => (before.set(name, fn), () => before.delete(name)), on: (name: string, fn: any) => (on.set(name, fn), () => on.delete(name)), beforeHandlers: before, onHandlers: on } as any; }

describe("Claude-only scoped injection", () => {
  it("only injects into opted-in Claude workspaces", () => {
    expect(shouldInject(SETTINGS, { cwd: "/w/one", provider: "claude/2.1" })).toBe(true);
    expect(shouldInject(SETTINGS, { cwd: "/w/one", provider: "codex" })).toBe(false);
  });
  it("keeps static MCP configuration free of credentials and adds fresh session env", async () => {
    const server = fakeServer(); const openSession = vi.fn().mockResolvedValue({ socketPath: "/run/tabgoblin.sock", agentGeneration: 4, workspaceGeneration: 3 });
    registerHooks(server, { readSettings: () => SETTINGS, lifecycle: { openSession, revokeAgent: vi.fn(), revokeWorkspace: vi.fn() } as any, newEnrollment: () => "synthetic-nonce" });
    const created = server.beforeHandlers.get("agent.create")({ request: { config: { provider: "claude", cwd: "/w/one", mcpServers: {} }, env: { KEEP: "1" } } });
    expect(created.config.mcpServers.tabgoblin).toEqual({ type: "stdio", command: "node", args: ["bridge.mjs"] });
    expect(JSON.stringify(created.config.mcpServers)).not.toContain("synthetic-nonce");
    const opened = await server.beforeHandlers.get("agent.session_open")({ request: { agentId: "agent-1", workspaceId: "ws-1", provider: "claude", cwd: "/w/one", purpose: "history", reason: "resume", env: { KEEP: "1" } } });
    expect(opened.env).toMatchObject({ KEEP: "1", [ADMIN_SOCKET_ENV]: "/run/tabgoblin.sock", [ENROLLMENT_ENV]: "synthetic-nonce" });
    expect(openSession).toHaveBeenCalledWith({ agentId: "agent-1", workspaceId: "ws-1", cwd: "/w/one", purpose: "history", enrollment: "synthetic-nonce" });
  });
  it("returns an archive callback promise while a real coordinator durably records delayed revocation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tabgoblin-hooks-")); directories.push(directory); const settings = createConfigStore(directory);
    await settings.update((current) => ({ ...current, workspaceGenerations: { "ws-1": 3 } }));
    let resolve!: (response: unknown) => void; const delayed = new Promise((done) => { resolve = done; });
    const lifecycle = createLifecycleCoordinator(settings, { request: vi.fn().mockReturnValue(delayed), notify: vi.fn(), close: vi.fn() } as any);
    const server = fakeServer(); registerHooks(server, { readSettings: settings.read, lifecycle, newEnrollment: () => "x" });
    const completion = server.onHandlers.get("workspace.archived")({ workspace: { id: "ws-1" } });
    expect(completion).toBeInstanceOf(Promise);
    await new Promise((done) => setTimeout(done, 0));
    expect(settings.read().pendingRevocations).toEqual([{ kind: "workspace", id: "ws-1" }]);
    resolve({ ok: true, lifecycleGeneration: 8 });
    await completion;
    expect(settings.read().pendingRevocations).toEqual([]);
    expect(settings.read().workspaceGenerations).toEqual({ "ws-1": 8 });
  });

  it("fails open when enrollment recording fails", async () => {
    const server = fakeServer(); registerHooks(server, { readSettings: () => SETTINGS, lifecycle: { openSession: vi.fn().mockRejectedValue(new Error("down")), revokeAgent: vi.fn(), revokeWorkspace: vi.fn() } as any, newEnrollment: () => "x" });
    await expect(server.beforeHandlers.get("agent.session_open")({ request: { agentId: "a", workspaceId: "ws-1", provider: "claude", cwd: "/w/one", purpose: "interactive", reason: "resume", env: {} } })).resolves.toBeUndefined();
  });
});
