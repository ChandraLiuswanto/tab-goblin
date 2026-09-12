import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createConfigStore } from "../server/config-store.js";
import { deriveServerConnectionDefaults } from "../server/defaults.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function directory() { const value = mkdtempSync(join(tmpdir(), "tabgoblin-defaults-")); directories.push(value); return value; }

function installedCheckout() {
  const root = directory();
  const entrypoint = join(root, "plugin", "bundle", "server", "index.server.js");
  const bridge = join(root, "packages", "mcp-bridge", "dist", "index.js");
  mkdirSync(join(root, "plugin", "bundle", "server"), { recursive: true });
  mkdirSync(join(root, "packages", "mcp-bridge", "dist"), { recursive: true });
  writeFileSync(join(root, "plugin", "paseo-plugin.json"), "{}\n");
  writeFileSync(bridge, "#!/usr/bin/env node\n");
  return { root, entrypoint, bridge };
}

describe("server-owned connection defaults", () => {
  it("derives the Node bridge and runtime socket from an installed plugin entrypoint", () => {
    const { entrypoint, bridge } = installedCheckout();
    expect(deriveServerConnectionDefaults({ entrypointUrl: pathToFileURL(entrypoint).href, xdgRuntimeDir: "/run/user/123" })).toEqual({
      bridgeCommand: process.execPath,
      bridgeArgs: [bridge],
      socketPath: "/run/user/123/tabgoblin/gateway.sock",
    });
  });

  it("fails clearly when the stable checkout layout has not been built", () => {
    const root = directory();
    const entrypoint = join(root, "plugin", "bundle", "index.server.js");
    mkdirSync(join(root, "plugin", "bundle"), { recursive: true });
    writeFileSync(join(root, "plugin", "paseo-plugin.json"), "{}\n");
    expect(() => deriveServerConnectionDefaults({ entrypointUrl: pathToFileURL(entrypoint).href, xdgRuntimeDir: "/run/user/123" })).toThrow(/npm run build/i);
  });

  it("uses derived defaults on a clean install and never replaces a saved connection choice", async () => {
    const { entrypoint, bridge } = installedCheckout();
    const initial = deriveServerConnectionDefaults({ entrypointUrl: pathToFileURL(entrypoint).href, xdgRuntimeDir: "/run/user/123" });
    const configDirectory = directory();
    const store = createConfigStore(configDirectory, initial);
    expect(store.read()).toMatchObject({ ...initial, enabled: false });

    await store.update((current) => ({ ...current, bridgeCommand: "/custom/node", bridgeArgs: ["/custom/bridge.mjs"], socketPath: "/custom/gateway.sock" }));
    const changedDefaults = { bridgeCommand: process.execPath, bridgeArgs: [bridge], socketPath: "/run/user/456/tabgoblin/gateway.sock" };
    expect(createConfigStore(configDirectory, changedDefaults).read()).toMatchObject({
      bridgeCommand: "/custom/node", bridgeArgs: ["/custom/bridge.mjs"], socketPath: "/custom/gateway.sock",
    });
  });
});
