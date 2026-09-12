import type { PluginServerContext } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import { createConfigStore } from "./server/config-store.js";
import { createGatewayManager } from "./server/gateway-client.js";
import { createHandlers, ping } from "./server/handlers.js";
import { registerHooks } from "./server/hooks.js";
import { activityRpc, enableWorkspaceRpc, pairRpc, pingRpc, returnToAgentRpc, startRpc, statusRpc, stopRpc } from "./shared/rpc.js";

export default function contribute(server: PluginServerContext) {
  const settings = createConfigStore();
  const gateway = createGatewayManager(() => settings.read().socketPath);
  const handlers = createHandlers(gateway, settings);
  const cleanupHooks = registerHooks(server, {
    readSettings: settings.read,
    gateway,
    newEnrollment: randomUUID,
    advanceAgentGeneration: (agentId) => settings.update((current) => ({ ...current, agentGenerations: { ...current.agentGenerations, [agentId]: (current.agentGenerations[agentId] ?? 0) + 1 } })),
    advanceWorkspaceGeneration: (workspaceId) => settings.update((current) => ({ ...current, workspaceGenerations: { ...current.workspaceGenerations, [workspaceId]: (current.workspaceGenerations[workspaceId] ?? 0) + 1 } })),
  });
  server.handle(pingRpc, ping);
  server.handle(statusRpc, handlers.status); server.handle(startRpc, handlers.start); server.handle(stopRpc, handlers.stop);
  server.handle(activityRpc, handlers.activity); server.handle(pairRpc, handlers.pair); server.handle(returnToAgentRpc, handlers.returnToAgent);
  server.handle(enableWorkspaceRpc, handlers.enableWorkspace);
  return () => {
    cleanupHooks();
    // Paseo provides no cleanup reason: revoke authority for reload and disable alike,
    // but leave browser/profile state untouched so a later fresh session can recover.
    for (const workspaceId of Object.keys(settings.read().workspaceGenerations)) gateway.notify({ op: "revoke-workspace", workspaceId });
    for (const agentId of Object.keys(settings.read().agentGenerations)) gateway.notify({ op: "revoke-agent", agentId });
    gateway.close();
  };
}
