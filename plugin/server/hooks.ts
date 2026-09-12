import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ADMIN_SOCKET_ENV, ENROLLMENT_ENV, MCP_SERVER_NAME, type AdminRequest, type AdminResponse } from "@tab-goblin/protocol";
import type { TabGoblinSettings } from "../shared/settings.js";

export interface HookDependencies {
  readSettings(): TabGoblinSettings;
  gateway: { request(body: AdminRequest): Promise<AdminResponse>; notify(body: AdminRequest): void };
  newEnrollment(): string;
  advanceAgentGeneration(agentId: string): Promise<unknown>;
  advanceWorkspaceGeneration(workspaceId: string): Promise<unknown>;
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
      return { ...request, config: { ...request.config, mcpServers: { ...(config.mcpServers ?? {}), [MCP_SERVER_NAME]: { type: "stdio", command: dependencies.readSettings().bridgeCommand, args: dependencies.readSettings().bridgeArgs } } } };
    } catch { return undefined; }
  });
  const stopSessionOpen = server.before("agent.session_open", async ({ request }) => {
    try {
      const settings = dependencies.readSettings();
      if (!request.workspaceId || !shouldInject(settings, request)) return undefined;
      const workspaceGeneration = request.workspaceId ? (settings.workspaceGenerations[request.workspaceId] ?? 0) : 0;
      const agentGeneration = settings.agentGenerations[request.agentId] ?? 0;
      const enrollment = dependencies.newEnrollment();
      const recorded = await dependencies.gateway.request({ op: "record-enrollment", enrollment, cwd: request.cwd, workspaceId: request.workspaceId, workspaceGeneration });
      if (!recorded.ok) return undefined;
      const bound = await dependencies.gateway.request({ op: "bind-enrollment", cwd: request.cwd, agentId: request.agentId, workspaceId: request.workspaceId, agentGeneration, workspaceGeneration });
      if (!bound.ok) return undefined;
      dependencies.gateway.notify({ op: "session-open", agentId: request.agentId, workspaceId: request.workspaceId, purpose: request.purpose, agentGeneration, workspaceGeneration });
      return { ...request, env: { ...request.env, [ADMIN_SOCKET_ENV]: settings.socketPath, [ENROLLMENT_ENV]: enrollment } };
    } catch { return undefined; }
  });
  const stopArchived = server.on("agent.archived", async ({ agent }) => {
    try {
      await dependencies.gateway.request({ op: "revoke-agent", agentId: agent.id });
      await dependencies.advanceAgentGeneration(agent.id);
    } catch { /* fail open */ }
  });
  const stopWorkspaceArchived = server.on("workspace.archived", async ({ workspace }) => { try { await dependencies.gateway.request({ op: "revoke-workspace", workspaceId: workspace.id }); await dependencies.advanceWorkspaceGeneration(workspace.id); } catch { /* fail open */ } });
  return () => { stopCreate(); stopSessionOpen(); stopArchived(); stopWorkspaceArchived(); };
}
