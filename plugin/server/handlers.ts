import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { PROTOCOL_VERSION, tabGoblinError, type AdminResponse } from "@tab-goblin/protocol";
import type { GatewayClient } from "./gateway-client.js";
import type { LifecycleCoordinator } from "./lifecycle-coordinator.js";

function invalidWorkspace(): AdminResponse { return { ok: false, error: tabGoblinError("invalid_input", "Workspace ID and cwd do not match a Paseo workspace") }; }
async function validWorkspace(context: PluginHandlerContext, workspaceId: string, cwd: string): Promise<boolean> {
  const result = await context.paseo.workspaces.list();
  return result.entries.some((workspace) => workspace.id === workspaceId && workspace.workspaceDirectory === cwd);
}
export function ping() { return { protocolVersion: PROTOCOL_VERSION }; }

type Scope = { workspaceId: string; cwd: string };

export function createHandlers(gateway: GatewayClient, lifecycle: LifecycleCoordinator) {
  const gatewayHandler = (op: "status" | "tabs" | "start" | "stop" | "activity" | "pair" | "return-to-agent") =>
    async ({ workspaceId, cwd }: Scope, context: PluginHandlerContext): Promise<AdminResponse> =>
      await validWorkspace(context, workspaceId, cwd) ? gateway.request({ op, workspaceId }) : invalidWorkspace();
  return {
    status: gatewayHandler("status"),
    tabs: gatewayHandler("tabs"),
    start: gatewayHandler("start"),
    stop: gatewayHandler("stop"),
    activity: gatewayHandler("activity"),
    pair: gatewayHandler("pair"),
    returnToAgent: gatewayHandler("return-to-agent"),
    config: async ({ workspaceId, cwd }: Scope, context: PluginHandlerContext) => {
      if (!await validWorkspace(context, workspaceId, cwd)) return { ok: false as const };
      const settings = lifecycle.settings();
      const workspaceEnabled = settings.enabledWorkspaceCwds.includes(cwd);
      return {
        ok: true as const,
        globallyEnabled: settings.enabled,
        workspaceEnabled,
        effectiveEnabled: settings.enabled && workspaceEnabled,
        socketPath: settings.socketPath,
        viewerUrl: settings.viewerUrl,
      };
    },
    setGlobalEnabled: async ({ workspaceId, cwd, enabled }: Scope & { enabled: boolean }, context: PluginHandlerContext) => {
      if (!await validWorkspace(context, workspaceId, cwd)) return { ok: false as const };
      return lifecycle.setGlobalEnabled(enabled);
    },
    updateConnection: async ({ workspaceId, cwd, socketPath, viewerUrl }: Scope & { socketPath: string; viewerUrl: string }, context: PluginHandlerContext) => {
      if (!await validWorkspace(context, workspaceId, cwd)) return { ok: false as const };
      return lifecycle.updateConnection({ socketPath, viewerUrl });
    },
    enableWorkspace: async ({ workspaceId, cwd, enabled }: Scope & { enabled: boolean }, context: PluginHandlerContext) => {
      if (!await validWorkspace(context, workspaceId, cwd)) return { ok: false as const };
      return enabled ? lifecycle.enableWorkspace(workspaceId, cwd) : lifecycle.disableWorkspace(workspaceId, cwd);
    },
  };
}
