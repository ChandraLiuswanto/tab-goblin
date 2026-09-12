import { describe, expect, it, vi } from "vitest";
import { registerHooks, shouldInject } from "../server/hooks.js";

const SETTINGS = {
  enabled: true,
  enabledWorkspaceCwds: ["/w/one"],
  mcpCapableProviders: ["claude", "codex", "copilot", "opencode"],
  bridgeCommand: "node",
  bridgeArgs: ["/abs/dist/index.js"],
  socketPath: "/run/user/1000/tabgoblin/gateway.sock",
  viewerUrl: "https://fedora.saga-skink.ts.net/",
};

function fakeServer() {
  const before = new Map<string, Function>();
  const on = new Map<string, Function>();
  return {
    context: {
      before: (name: string, handler: Function) => {
        before.set(name, handler);
        return () => before.delete(name);
      },
      on: (name: string, handler: Function) => {
        on.set(name, handler);
        return () => on.delete(name);
      },
      handle: () => undefined,
      registerProvider: () => {},
      registerSettings: () => {},
    } as never,
    before,
    on,
  };
}

describe("shouldInject", () => {
  it("injects for an opted-in cwd on a capable provider", () => {
    expect(shouldInject(SETTINGS, { cwd: "/w/one", provider: "claude" })).toBe(true);
  });

  it("accepts a provider/model shorthand", () => {
    expect(shouldInject(SETTINGS, { cwd: "/w/one", provider: "codex/gpt-5.5" })).toBe(true);
  });

  it("skips workspaces, unsupported providers, disabled plugin, and an existing bridge", () => {
    expect(shouldInject(SETTINGS, { cwd: "/w/two", provider: "claude" })).toBe(false);
    expect(shouldInject(SETTINGS, { cwd: "/w/one", provider: "omp" })).toBe(false);
    expect(shouldInject({ ...SETTINGS, enabled: false }, { cwd: "/w/one", provider: "claude" })).toBe(false);
    expect(
      shouldInject(SETTINGS, {
        cwd: "/w/one",
        provider: "claude",
        mcpServers: { tabgoblin: { type: "stdio", command: "node" } },
      }),
    ).toBe(false);
  });
});

describe("plugin lifecycle hooks", () => {
  it("adds a scoped bridge without disturbing existing MCP servers or launch env", async () => {
    const server = fakeServer();
    const notify = vi.fn();
    registerHooks(server.context, {
      readSettings: () => SETTINGS,
      gateway: { notify },
      newEnrollment: () => "11111111-1111-4111-8111-111111111111",
    });

    const request = {
      config: {
        provider: "claude",
        cwd: "/w/one",
        mcpServers: { linear: { type: "http", url: "https://linear.example/mcp" } },
      },
      env: { EXISTING: "1" },
    };
    const result = await server.before.get("agent.create")!({ request }, {});

    expect(result.config.mcpServers.linear).toEqual(request.config.mcpServers.linear);
    expect(result.config.mcpServers.tabgoblin).toMatchObject({
      type: "stdio",
      command: "node",
      args: ["/abs/dist/index.js"],
      env: {
        TABGOBLIN_SOCKET: SETTINGS.socketPath,
        TABGOBLIN_ENROLLMENT: "11111111-1111-4111-8111-111111111111",
      },
    });
    expect(result.env).toEqual({ EXISTING: "1" });
    expect(result.config.cwd).toBe("/w/one");
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ op: "record-enrollment", cwd: "/w/one" }),
    );
  });

  it("does nothing when injection is inapplicable and swallows settings or gateway failures", async () => {
    const server = fakeServer();
    registerHooks(server.context, {
      readSettings: () => SETTINGS,
      gateway: { notify: vi.fn() },
      newEnrollment: () => "x",
    });
    await expect(
      server.before.get("agent.create")!(
        { request: { config: { provider: "claude", cwd: "/w/two" }, env: {} } },
        {},
      ),
    ).resolves.toBeUndefined();

    const failingServer = fakeServer();
    registerHooks(failingServer.context, {
      readSettings: () => {
        throw new Error("settings unavailable");
      },
      gateway: { notify: () => { throw new Error("gateway unavailable"); } },
      newEnrollment: () => "x",
    });
    await expect(
      failingServer.before.get("agent.create")!(
        { request: { config: { provider: "claude", cwd: "/w/one" }, env: {} } },
        {},
      ),
    ).resolves.toBeUndefined();
  });

  it("reports session-open without mutating env, including history opens", async () => {
    const server = fakeServer();
    const notify = vi.fn();
    registerHooks(server.context, {
      readSettings: () => SETTINGS,
      gateway: { notify },
      newEnrollment: () => "x",
    });
    const result = await server.before.get("agent.session_open")!(
      {
        request: {
          agentId: "agent-1",
          workspaceId: "ws-1",
          provider: "claude",
          cwd: "/w/one",
          reason: "resume",
          purpose: "history",
          env: { A: "1" },
        },
      },
      {},
    );

    expect(result).toBeUndefined();
    expect(notify).toHaveBeenCalledWith({
      op: "session-open",
      agentId: "agent-1",
      workspaceId: "ws-1",
      purpose: "history",
    });
  });

  it("binds an enrollment with the authoritative agent identity and cleans up registrations", async () => {
    const server = fakeServer();
    const notify = vi.fn();
    const cleanup = registerHooks(server.context, {
      readSettings: () => SETTINGS,
      gateway: { notify },
      newEnrollment: () => "11111111-1111-4111-8111-111111111111",
    });
    await server.before.get("agent.create")!(
      { request: { config: { provider: "claude", cwd: "/w/one" }, env: {} } },
      {},
    );
    await server.on.get("agent.created")!(
      { agent: { id: "agent-1", workspaceId: "ws-1", cwd: "/w/one", provider: "claude" } },
      {},
    );
    expect(notify).toHaveBeenCalledWith({
      op: "bind-enrollment",
      cwd: "/w/one",
      agentId: "agent-1",
      workspaceId: "ws-1",
    });

    cleanup();
    expect(server.before.size).toBe(0);
    expect(server.on.size).toBe(0);
  });
});
