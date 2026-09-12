import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConnectionDefaults } from "../shared/settings.js";

const PLUGIN_MANIFEST = join("plugin", "paseo-plugin.json");
const BRIDGE_ENTRYPOINT = join("packages", "mcp-bridge", "dist", "index.js");

function checkoutRoot(entrypointUrl: string): string {
  let directory = dirname(fileURLToPath(entrypointUrl));
  while (true) {
    const bridge = join(directory, BRIDGE_ENTRYPOINT);
    if (existsSync(join(directory, PLUGIN_MANIFEST)) && existsSync(bridge)) return directory;
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error("TabGoblin installation is incomplete: run npm ci and npm run build from the checkout before loading the plugin");
    }
    directory = parent;
  }
}

/**
 * Resolve deployment-specific defaults from the loaded server module, not a
 * source-tree assumption. Paseo does not expose a plugin installation path in
 * PluginServerContext, while import.meta.url remains correct for bundled code.
 */
export function deriveServerConnectionDefaults(options: { entrypointUrl?: string; xdgRuntimeDir?: string } = {}): ConnectionDefaults {
  const runtimeDirectory = options.xdgRuntimeDir ?? process.env.XDG_RUNTIME_DIR;
  if (!runtimeDirectory || !isAbsolute(runtimeDirectory)) {
    throw new Error("XDG_RUNTIME_DIR must be an absolute path for the TabGoblin gateway socket");
  }
  const root = checkoutRoot(options.entrypointUrl ?? import.meta.url);
  return {
    bridgeCommand: process.execPath,
    bridgeArgs: [join(root, BRIDGE_ENTRYPOINT)],
    socketPath: join(runtimeDirectory, "tabgoblin", "gateway.sock"),
  };
}
