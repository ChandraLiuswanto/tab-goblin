import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityFeed } from "../../packages/gateway/src/activity-feed.js";
import { createAdminServer } from "../../packages/gateway/src/admin-server.js";
import { EnrollmentRegistry } from "../../packages/gateway/src/enrollment.js";
import { createConfigStore } from "../server/config-store.js";
import { createGatewayManager } from "../server/gateway-client.js";
import { createHandlers } from "../server/handlers.js";
import { createLifecycleCoordinator } from "../server/lifecycle-coordinator.js";
import { configRpc, enableWorkspaceRpc, setGlobalEnabledRpc, tabsRpc, updateConnectionRpc } from "../shared/rpc.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function harness() {
  const directory = mkdtempSync(join(tmpdir(), "tabgoblin-rpc-integration-"));
  const socketPath = join(directory, "gateway.sock");
  const runtime = {
    state: vi.fn(() => "ready" as const),
    start: vi.fn(), stop: vi.fn(), stageFile: vi.fn(),
  };
  const session = {
    listTabs: vi.fn(async () => [{ tabId: "tab-1", title: "Fixture", url: "https://fixture.test/", active: true }]),
  };
  const ownership = {
    snapshot: vi.fn(() => ({ state: "agent-ready" as const, generation: 0, owner: null, ownerViewerSessionId: null })),
    returnToAgent: vi.fn(), acquireAgentLease: vi.fn(),
  };
  const services = {
    runtime,
    ownership: vi.fn(() => ownership),
    activity: vi.fn(() => new ActivityFeed()),
    browser: vi.fn(async () => session),
    issuePairingCode: vi.fn(),
    viewerUrlFor: vi.fn(() => "https://viewer.test/"),
  };
  const admin = createAdminServer({ services: services as never, enrollment: new EnrollmentRegistry(), socketPath });
  await admin.listen();
  const gateway = createGatewayManager(() => socketPath);
  const settings = createConfigStore(join(directory, "config"));
  await settings.update((current) => ({ ...current, socketPath }));
  const lifecycle = createLifecycleCoordinator(settings, gateway);
  const handlers = createHandlers(gateway, lifecycle);
  const context = { paseo: { workspaces: { list: vi.fn().mockResolvedValue({ entries: [{ id: "ws-1", workspaceDirectory: "/w/one" }] }) } } } as any;
  cleanups.push(async () => { gateway.close(); await admin.close(); rmSync(directory, { recursive: true, force: true }); });
  return { runtime, session, services, handlers, context };
}

async function callRpc(contract: any, handler: any, input: unknown, context: any) {
  const parsedInput = contract.input.parse(input);
  return contract.output.parse(await handler(parsedInput, context));
}

describe("client RPC to trusted admin integration", () => {
  it("keeps default global disable separate, then rereads authoritative effective activation", async () => {
    const { handlers, context } = await harness();
    const scope = { workspaceId: "ws-1", cwd: "/w/one" };

    await expect(callRpc(configRpc, handlers.config, scope, context)).resolves.toMatchObject({
      ok: true,
      globallyEnabled: false,
      workspaceEnabled: false,
      effectiveEnabled: false,
    });
    await expect(callRpc(setGlobalEnabledRpc, handlers.setGlobalEnabled, { ...scope, enabled: true }, context)).resolves.toEqual({ ok: true });
    await expect(callRpc(configRpc, handlers.config, scope, context)).resolves.toMatchObject({
      ok: true,
      globallyEnabled: true,
      workspaceEnabled: false,
      effectiveEnabled: false,
    });
    await expect(callRpc(enableWorkspaceRpc, handlers.enableWorkspace, { ...scope, enabled: true }, context)).resolves.toEqual({ ok: true });
    await expect(callRpc(configRpc, handlers.config, scope, context)).resolves.toMatchObject({
      ok: true,
      globallyEnabled: true,
      workspaceEnabled: true,
      effectiveEnabled: true,
    });
    await expect(callRpc(setGlobalEnabledRpc, handlers.setGlobalEnabled, { ...scope, enabled: false }, context)).resolves.toEqual({ ok: true });
    await expect(callRpc(configRpc, handlers.config, scope, context)).resolves.toMatchObject({
      ok: true,
      globallyEnabled: false,
      workspaceEnabled: true,
      effectiveEnabled: false,
    });
  });

  it("durably updates credential-free connection settings and exposes only the reread projection", async () => {
    const { handlers, context } = await harness();
    const scope = { workspaceId: "ws-1", cwd: "/w/one" };
    const initial = await callRpc(configRpc, handlers.config, scope, context);
    expect(initial.ok).toBe(true);
    if (!initial.ok) throw new Error("expected config");

    await expect(callRpc(updateConnectionRpc, handlers.updateConnection, {
      ...scope,
      socketPath: initial.socketPath,
      viewerUrl: "https://viewer.test/",
    }, context)).resolves.toEqual({ ok: true });
    await expect(callRpc(configRpc, handlers.config, scope, context)).resolves.toMatchObject({
      ok: true,
      viewerUrl: "https://viewer.test/",
    });
    await expect(callRpc(updateConnectionRpc, handlers.updateConnection, {
      ...scope,
      socketPath: initial.socketPath,
      viewerUrl: "https://user:secret@viewer.test/?token=secret",
    }, context)).rejects.toThrow();
  });

  it("returns real browser tabs through the scoped plugin RPC without an agent enrollment", async () => {
    const { handlers, context, session } = await harness();
    const result = await callRpc(tabsRpc, handlers.tabs, { workspaceId: "ws-1", cwd: "/w/one" }, context);

    expect(result).toEqual({ ok: true, tabs: [{ tabId: "tab-1", title: "Fixture", url: "https://fixture.test/", active: true }] });
    expect(session.listTabs).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it("propagates session_not_ready and never invents tabs from an enrollment", async () => {
    const { handlers, context, runtime, services } = await harness();
    runtime.state.mockReturnValue("stopped");

    await expect(callRpc(tabsRpc, handlers.tabs, { workspaceId: "ws-1", cwd: "/w/one" }, context)).resolves.toMatchObject({
      ok: false,
      error: { code: "session_not_ready" },
    });
    expect(services.browser).not.toHaveBeenCalled();
  });
});
