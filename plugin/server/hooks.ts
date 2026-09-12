import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ADMIN_SOCKET_ENV, ENROLLMENT_ENV, MCP_SERVER_NAME } from "@tab-goblin/protocol";
import type { TabGoblinSettings } from "../shared/settings.js";
import type { LifecycleCoordinator } from "./lifecycle-coordinator.js";

export interface HookDependencies {
  readSettings(): TabGoblinSettings;
  lifecycle: LifecycleCoordinator;
  newEnrollment(): string;
}

export function shouldInject(settings: TabGoblinSettings, config: { cwd?: string; provider?: string; mcpServers?: Record<string, unknown> }): boolean {
  return settings.enabled && !!config.cwd && config.provider?.split("/", 1)[0] === "claude"
    && settings.enabledWorkspaceCwds.includes(config.cwd) && !config.mcpServers?.[MCP_SERVER_NAME];
}

export function registerHooks(server: PluginServerContext, dependencies: HookDependencies): () => void {
  const stopCreate = server.before("agent.create", ({ request }) => {
    try {
      const config = request.config as unknown as { cwd?: string; provider?: string; mcpServers?: Record<string, unknown> };
      if (!shouldInject(dependencies.readSettings(), config)) return undefined;
      const settings = dependencies.readSettings();
      return { ...request, config: { ...request.config, mcpServers: { ...(config.mcpServers ?? {}), [MCP_SERVER_NAME]: { type: "stdio", command: settings.bridgeCommand, args: settings.bridgeArgs } } } };
    } catch { return undefined; }
  });
  const stopSessionOpen = server.before("agent.session_open", async ({ request }) => {
    try {
      if (!request.workspaceId || !shouldInject(dependencies.readSettings(), request)) return undefined;
      const enrollment = dependencies.newEnrollment();
      const scope = await dependencies.lifecycle.openSession({ agentId: request.agentId, workspaceId: request.workspaceId, cwd: request.cwd, purpose: request.purpose, enrollment });
      return scope ? { ...request, env: { ...request.env, [ADMIN_SOCKET_ENV]: scope.socketPath, [ENROLLMENT_ENV]: enrollment } } : undefined;
    } catch { return undefined; }
  });
  const stopArchived = server.on("agent.archived", async ({ agent }) => { await dependencies.lifecycle.revokeAgent(agent.id); });
  const stopWorkspaceArchived = server.on("workspace.archived", async ({ workspace }) => { await dependencies.lifecycle.revokeWorkspace(workspace.id); });
  return () => { stopCreate(); stopSessionOpen(); stopArchived(); stopWorkspaceArchived(); };
}
