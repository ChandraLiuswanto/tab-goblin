import type { ConnectionDefaults } from "../shared/settings.js";

export const testConnectionDefaults: ConnectionDefaults = {
  bridgeCommand: "/usr/bin/node",
  bridgeArgs: ["/opt/tabgoblin/bridge.js"],
  socketPath: "/run/user/1000/tabgoblin/gateway.sock",
};
