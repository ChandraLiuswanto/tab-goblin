import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { PROTOCOL_VERSION, tabGoblinError, type AdminResponse } from "@tab-goblin/protocol";
import type { ConfigStore } from "./config-store.js";
import type { GatewayClient } from "./gateway-client.js";

function invalidWorkspace(): AdminResponse { return { ok: false, error: tabGoblinError("invalid_input", "Workspace ID and cwd do not match a Paseo workspace") }; }
async function validWorkspace(context: PluginHandlerContext, workspaceId: string, cwd: string): Promise<boolean> {
  const result = await context.paseo.workspaces.list();
  return result.entries.some((workspace) => workspace.id === workspaceId && workspace.workspaceDirectory === cwd);
}
export function ping() { return { protocolVersion: PROTOCOL_VERSION }; }

export function createHandlers(gateway: GatewayClient, settings: ConfigStore) {
  const gatewayHandler = (op: "status" | "start" | "stop" | "activity" | "pair" | "return-to-agent") =>
    async ({ workspaceId, cwd }: { workspaceId: string; cwd: string }, context: PluginHandlerContext): Promise<AdminResponse> =>
      await validWorkspace(context, workspaceId, cwd) ? gateway.request({ op, workspaceId } as never) : invalidWorkspace();
  return {
    status: gatewayHandler("status"), start: gatewayHandler("start"), stop: gatewayHandler("stop"), activity: gatewayHandler("activity"), pair: gatewayHandler("pair"), returnToAgent: gatewayHandler("return-to-agent"),
    enableWorkspace: async ({ workspaceId, cwd, enabled }: { workspaceId: string; cwd: string; enabled: boolean }, context: PluginHandlerContext) => {
      if (!await validWorkspace(context, workspaceId, cwd)) return { ok: false };
      const before = settings.read();
      if (enabled) {
        const response = await gateway.request({ op: "reset-workspace", workspaceId });
        if (!response.ok || typeof response.lifecycleGeneration !== "number") return { ok: false };
        const generation = response.lifecycleGeneration;
        await settings.update((current) => ({ ...current, enabledWorkspaceCwds: [...new Set([...current.enabledWorkspaceCwds, cwd])], workspaceGenerations: { ...current.workspaceGenerations, [workspaceId]: generation } }));
      } else {
        gateway.notify({ op: "revoke-workspace", workspaceId });
        await settings.update((current) => ({ ...current, enabledWorkspaceCwds: current.enabledWorkspaceCwds.filter((item) => item !== cwd), workspaceGenerations: { ...current.workspaceGenerations, [workspaceId]: (current.workspaceGenerations[workspaceId] ?? 0) + 1 } }));
      }
      return { ok: before.enabled === settings.read().enabled || enabled !== undefined };
    },
  };
}
