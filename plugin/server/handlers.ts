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

export function createHandlers(gateway: GatewayClient, lifecycle: LifecycleCoordinator) {
  const gatewayHandler = (op: "status" | "start" | "stop" | "activity" | "pair" | "return-to-agent") =>
    async ({ workspaceId, cwd }: { workspaceId: string; cwd: string }, context: PluginHandlerContext): Promise<AdminResponse> =>
      await validWorkspace(context, workspaceId, cwd) ? gateway.request({ op, workspaceId } as never) : invalidWorkspace();
  return {
    status: gatewayHandler("status"), start: gatewayHandler("start"), stop: gatewayHandler("stop"), activity: gatewayHandler("activity"), pair: gatewayHandler("pair"), returnToAgent: gatewayHandler("return-to-agent"),
    enableWorkspace: async ({ workspaceId, cwd, enabled }: { workspaceId: string; cwd: string; enabled: boolean }, context: PluginHandlerContext) => {
      if (!await validWorkspace(context, workspaceId, cwd)) return { ok: false };
      return enabled ? lifecycle.enableWorkspace(workspaceId, cwd) : lifecycle.disableWorkspace(workspaceId, cwd);
    },
  };
}
