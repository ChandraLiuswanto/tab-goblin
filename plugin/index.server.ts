import type { PluginServerContext } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import { createGatewayClient } from "./server/gateway-client.js";
import { createHandlers, ping } from "./server/handlers.js";
import { registerHooks } from "./server/hooks.js";
import {
  activityRpc,
  enableWorkspaceRpc,
  pairRpc,
  pingRpc,
  returnToAgentRpc,
  startRpc,
  statusRpc,
  stopRpc,
} from "./shared/rpc.js";
import { tabGoblinSettings, type TabGoblinSettings } from "./shared/settings.js";

/**
 * The plugin SDK persists registered settings for the client-side settings RPC.
 * It exposes no server-side settings read/write/subscribe API, so this cache is
 * intentionally isolated for the hooks/handlers until that API is available.
 */
function createSettingsCache(): { read(): TabGoblinSettings; write(value: TabGoblinSettings): void } {
  let value = tabGoblinSettings.schema.parse({});
  return {
    read: () => value,
    write: (next) => {
      value = next;
    },
  };
}

export default function contribute(server: PluginServerContext) {
  server.registerSettings(tabGoblinSettings);

  const settings = createSettingsCache();
  const gateway = createGatewayClient(settings.read().socketPath);
  const handlers = createHandlers(gateway, settings);
  const cleanupHooks = registerHooks(server, {
    readSettings: settings.read,
    gateway,
    newEnrollment: randomUUID,
  });

  server.handle(pingRpc, ping);
  server.handle(statusRpc, handlers.status);
  server.handle(startRpc, handlers.start);
  server.handle(stopRpc, handlers.stop);
  server.handle(activityRpc, handlers.activity);
  server.handle(pairRpc, handlers.pair);
  server.handle(returnToAgentRpc, handlers.returnToAgent);
  server.handle(enableWorkspaceRpc, handlers.enableWorkspace);

  return () => {
    cleanupHooks();
    gateway.close();
  };
}
