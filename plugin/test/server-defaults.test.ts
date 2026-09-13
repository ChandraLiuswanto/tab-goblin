import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfigStore } from "../server/config-store.js";
import { deriveServerConnectionDefaults } from "../server/defaults.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function directory() { const value = mkdtempSync(join(tmpdir(), "tabgoblin-defaults-")); directories.push(value); return value; }

function installedCheckout() {
  const root = directory();
  const bridge = join(root, "packages", "mcp-bridge", "dist", "index.js");
  mkdirSync(join(root, "plugin"), { recursive: true });
  mkdirSync(join(root, "packages", "mcp-bridge", "dist"), { recursive: true });
  writeFileSync(join(root, "plugin", "paseo-plugin.json"), "{}\n");
  writeFileSync(bridge, "#!/usr/bin/env node\n");
  return { root, bridge };
}

describe("server-owned connection defaults", () => {
  it("derives the Node bridge and runtime socket from the explicit checkout root", () => {
    const { root, bridge } = installedCheckout();
    expect(deriveServerConnectionDefaults({ installRoot: root, xdgRuntimeDir: "/run/user/123" })).toEqual({
      bridgeCommand: process.execPath,
      bridgeArgs: [bridge],
      socketPath: "/run/user/123/tabgoblin/gateway.sock",
    });
  });

  it("rejects a missing or relative configured installation root", () => {
    expect(() => deriveServerConnectionDefaults({ xdgRuntimeDir: "/run/user/123" })).toThrow(/TABGOBLIN_INSTALL_ROOT/);
    expect(() => deriveServerConnectionDefaults({ installRoot: "relative-checkout", xdgRuntimeDir: "/run/user/123" })).toThrow(/TABGOBLIN_INSTALL_ROOT/);
  });

  it("fails clearly when the stable checkout layout has not been built", () => {
    const root = directory();
    mkdirSync(join(root, "plugin"), { recursive: true });
    writeFileSync(join(root, "plugin", "paseo-plugin.json"), "{}\n");
    expect(() => deriveServerConnectionDefaults({ installRoot: root, xdgRuntimeDir: "/run/user/123" })).toThrow(/npm run build/i);
  });

  it("uses derived defaults on a clean install, keeps a saved socket path, and refreshes the bridge launch command", async () => {
    const { root, bridge } = installedCheckout();
    const initial = deriveServerConnectionDefaults({ installRoot: root, xdgRuntimeDir: "/run/user/123" });
    const configDirectory = directory();
    const store = createConfigStore(configDirectory, initial);
    expect(store.read()).toMatchObject({ ...initial, enabled: false });

    await store.update((current) => ({ ...current, bridgeCommand: "/custom/node", bridgeArgs: ["/custom/bridge.mjs"], socketPath: "/custom/gateway.sock" }));
    const changedDefaults = { bridgeCommand: process.execPath, bridgeArgs: [bridge], socketPath: "/run/user/456/tabgoblin/gateway.sock" };
    expect(createConfigStore(configDirectory, changedDefaults).read()).toMatchObject({
      bridgeCommand: process.execPath, bridgeArgs: [bridge], socketPath: "/custom/gateway.sock",
    });
  });
});
