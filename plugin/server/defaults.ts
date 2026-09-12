import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ConnectionDefaults } from "../shared/settings.js";

const PLUGIN_MANIFEST = join("plugin", "paseo-plugin.json");
const BRIDGE_ENTRYPOINT = join("packages", "mcp-bridge", "dist", "index.js");

function regularFile(path: string): boolean {
  try { return statSync(path).isFile(); }
  catch { return false; }
}

function checkoutRoot(configuredRoot: string | undefined): string {
  if (!configuredRoot || !isAbsolute(configuredRoot)) {
    throw new Error("TABGOBLIN_INSTALL_ROOT must be an absolute checkout path in the Paseo server environment");
  }
  let root: string;
  try { root = realpathSync.native(configuredRoot); }
  catch { throw new Error("TABGOBLIN_INSTALL_ROOT does not name an accessible TabGoblin checkout"); }
  if (!statSync(root).isDirectory() || !regularFile(join(root, PLUGIN_MANIFEST))) {
    throw new Error("TABGOBLIN_INSTALL_ROOT must name a TabGoblin checkout containing plugin/paseo-plugin.json");
  }
  if (!regularFile(join(root, BRIDGE_ENTRYPOINT))) {
    throw new Error("TabGoblin installation is incomplete: run npm ci and npm run build from TABGOBLIN_INSTALL_ROOT before loading the plugin");
  }
  return root;
}

/**
 * Paseo 0.8 evaluates server contributions as CJS bundles in a cache, so module
 * filenames are neither available nor tied to the installed checkout. Use this
 * explicit server-environment setting rather than import.meta or __dirname.
 */
export function deriveServerConnectionDefaults(options: { installRoot?: string; xdgRuntimeDir?: string } = {}): ConnectionDefaults {
  const runtimeDirectory = options.xdgRuntimeDir ?? process.env.XDG_RUNTIME_DIR;
  if (!runtimeDirectory || !isAbsolute(runtimeDirectory)) {
    throw new Error("XDG_RUNTIME_DIR must be an absolute path for the TabGoblin gateway socket");
  }
  const root = checkoutRoot(options.installRoot ?? process.env.TABGOBLIN_INSTALL_ROOT);
  return {
    bridgeCommand: process.execPath,
    bridgeArgs: [join(root, BRIDGE_ENTRYPOINT)],
    socketPath: join(runtimeDirectory, "tabgoblin", "gateway.sock"),
  };
}
