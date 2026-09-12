import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const nodeRequire = createRequire(import.meta.url);
const checkout = fileURLToPath(new URL("../../", import.meta.url));

function realisticServerContext() {
  return {
    before: vi.fn(() => () => undefined),
    on: vi.fn(() => () => undefined),
    handle: vi.fn(),
    registerProvider: vi.fn(),
    registerSettings: vi.fn(),
  };
}

async function paseoCjsContribution() {
  const result = await build({
    entryPoints: [join(checkout, "plugin", "index.server.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    external: ["@getpaseo/plugin", "@getpaseo/plugin/server", "zod"],
    write: false,
    logLevel: "silent",
  });
  const bundle = result.outputFiles[0]!.text;
  const factory = runInNewContext(`(function(require) {\nconst module = { exports: {} };\nconst exports = module.exports;\n${bundle}\nreturn module.exports;\n})`, { Buffer, clearTimeout, process, setTimeout }, { filename: "paseo-plugin-server.cjs" });
  const contribution = factory((specifier: string) => specifier === "@getpaseo/plugin"
    ? { defineRpc: (definition: unknown) => definition }
    : nodeRequire(specifier));
  return { bundle, contribute: contribution.default as (server: ReturnType<typeof realisticServerContext>) => () => Promise<void> };
}

describe("Paseo CJS plugin initialization", () => {
  it("initializes the actual server entry bundle with SDK stubs and an explicit checkout root", async () => {
    const state = mkdtempSync(join(tmpdir(), "tabgoblin-paseo-state-"));
    const runtime = mkdtempSync(join(tmpdir(), "tabgoblin-paseo-runtime-"));
    directories.push(state, runtime);
    const original = {
      TABGOBLIN_INSTALL_ROOT: process.env.TABGOBLIN_INSTALL_ROOT,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    };
    process.env.TABGOBLIN_INSTALL_ROOT = checkout;
    process.env.XDG_STATE_HOME = state;
    process.env.XDG_RUNTIME_DIR = runtime;
    try {
      const { bundle, contribute } = await paseoCjsContribution();
      const server = realisticServerContext();
      const cleanup = contribute(server);
      expect(bundle).toContain("module.exports");
      expect(server.handle).toHaveBeenCalledTimes(12);
      expect(server.before).toHaveBeenCalledTimes(2);
      expect(server.on).toHaveBeenCalledTimes(2);
      await cleanup();
    } finally {
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });
});
