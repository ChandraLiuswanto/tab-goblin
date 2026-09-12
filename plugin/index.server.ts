import type { PluginServerContext } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import { createConfigStore } from "./server/config-store.js";
import { createGatewayManager, type GatewayClient } from "./server/gateway-client.js";
import { createHandlers, ping } from "./server/handlers.js";
import { registerHooks } from "./server/hooks.js";
import { createLifecycleCoordinator, type LifecycleCoordinator } from "./server/lifecycle-coordinator.js";
import { activityRpc, enableWorkspaceRpc, pairRpc, pingRpc, returnToAgentRpc, startRpc, statusRpc, stopRpc } from "./shared/rpc.js";

export function cleanupPlugin(cleanupHooks: () => void, lifecycle: Pick<LifecycleCoordinator, "cleanup">, gateway: Pick<GatewayClient, "close">): Promise<void> {
  cleanupHooks();
  // Keep failed requests durable and retryable. Do not close the client before its bounded requests settle.
  return lifecycle.cleanup().finally(() => gateway.close());
}

export default function contribute(server: PluginServerContext) {
  const settings = createConfigStore();
  const gateway = createGatewayManager(() => settings.read().socketPath);
  const lifecycle = createLifecycleCoordinator(settings, gateway);
  void lifecycle.replayPending();
  const handlers = createHandlers(gateway, lifecycle);
  const cleanupHooks = registerHooks(server, { readSettings: settings.read, lifecycle, newEnrollment: randomUUID });
  server.handle(pingRpc, ping);
  server.handle(statusRpc, handlers.status); server.handle(startRpc, handlers.start); server.handle(stopRpc, handlers.stop);
  server.handle(activityRpc, handlers.activity); server.handle(pairRpc, handlers.pair); server.handle(returnToAgentRpc, handlers.returnToAgent);
  server.handle(enableWorkspaceRpc, handlers.enableWorkspace);
  return () => cleanupPlugin(cleanupHooks, lifecycle, gateway);
}
