import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ADMIN_SOCKET_ENV, ENROLLMENT_ENV, MCP_SERVER_NAME, type AdminRequest } from "@tab-goblin/protocol";
import type { TabGoblinSettings } from "../shared/settings.js";

export interface HookDependencies {
  readSettings(): TabGoblinSettings;
  gateway: { notify(body: AdminRequest): void };
  newEnrollment(): string;
}

export function shouldInject(
  settings: TabGoblinSettings,
  config: { cwd?: string; provider?: string; mcpServers?: Record<string, unknown> },
): boolean {
  if (!settings.enabled || !config.cwd || !config.provider) return false;
  if (!settings.enabledWorkspaceCwds.includes(config.cwd)) return false;
  if (config.mcpServers?.[MCP_SERVER_NAME]) return false;
  return settings.mcpCapableProviders.includes(config.provider.split("/", 1)[0]);
}

export function registerHooks(server: PluginServerContext, dependencies: HookDependencies): () => void {
  const stopCreate = server.before("agent.create", async ({ request }) => {
    try {
      const settings = dependencies.readSettings();
      const config = request.config as unknown as {
        cwd?: string;
        provider?: string;
        mcpServers?: Record<string, unknown>;
      };
      if (!shouldInject(settings, config) || !config.cwd) return undefined;

      const enrollment = dependencies.newEnrollment();
      dependencies.gateway.notify({ op: "record-enrollment", enrollment, cwd: config.cwd });
      return {
        config: {
          ...request.config,
          mcpServers: {
            ...(config.mcpServers ?? {}),
            [MCP_SERVER_NAME]: {
              type: "stdio",
              command: settings.bridgeCommand,
              args: settings.bridgeArgs,
              env: {
                [ADMIN_SOCKET_ENV]: settings.socketPath,
                [ENROLLMENT_ENV]: enrollment,
              },
            },
          },
        },
        env: request.env,
      };
    } catch {
      // Lifecycle hooks must never block agent creation.
      return undefined;
    }
  });

  const stopSessionOpen = server.before("agent.session_open", async ({ request }) => {
    try {
      dependencies.gateway.notify({
        op: "session-open",
        agentId: request.agentId,
        workspaceId: request.workspaceId,
        purpose: request.purpose,
      });
    } catch {
      // The gateway is best effort and must not block session opening.
    }
    // Deliberately return undefined: session hooks may only alter env and credentials
    // must reach the bridge through the dedicated MCP config, not the launch env.
    return undefined;
  });

  const stopCreated = server.on("agent.created", async ({ agent }) => {
    try {
      dependencies.gateway.notify({
        op: "bind-enrollment",
        cwd: agent.cwd,
        agentId: agent.id,
        workspaceId: agent.workspaceId,
      });
    } catch {
      // The gateway is best effort and must not block agent creation.
    }
  });

  return () => {
    stopCreate();
    stopSessionOpen();
    stopCreated();
  };
}
