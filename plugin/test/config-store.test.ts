import { chmodSync, lstatSync, mkdirSync, renameSync, symlinkSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfigStore } from "../server/config-store.js";
import { testConnectionDefaults } from "./connection-defaults.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function directory() { const value = mkdtempSync(join(tmpdir(), "tabgoblin-config-")); directories.push(value); return value; }
describe("app-owned durable config", () => {
  it("persists bounded configuration privately across a reload", async () => {
    const dir = directory(); const first = createConfigStore(dir, testConnectionDefaults);
    await first.update((current) => ({ ...current, enabled: true, enabledWorkspaceCwds: ["/work"] }));
    expect(lstatSync(dir).mode & 0o077).toBe(0);
    expect(lstatSync(first.path).mode & 0o777).toBe(0o600);
    chmodSync(first.path, 0o700);
    expect(createConfigStore(dir, testConnectionDefaults).read()).toMatchObject({ enabled: true, enabledWorkspaceCwds: ["/work"] });
    expect(lstatSync(first.path).mode & 0o777).toBe(0o600);
    chmodSync(first.path, 0o400);
    createConfigStore(dir, testConnectionDefaults);
    expect(lstatSync(first.path).mode & 0o777).toBe(0o600);
  });
  it("rejects credential-bearing viewer URLs and non-absolute socket paths", async () => {
    const connection = { bridgeCommand: "/usr/bin/node", bridgeArgs: ["/opt/tabgoblin/bridge.js"], socketPath: "/run/user/1000/tabgoblin/gateway.sock" };
    const store = createConfigStore(directory(), connection);
    await expect(store.update((current) => ({ ...current, viewerUrl: "https://user:secret@viewer.test/?token=secret" }))).rejects.toThrow();
    await expect(store.update((current) => ({ ...current, socketPath: "relative.sock" }))).rejects.toThrow();
    expect(store.read()).toMatchObject({ socketPath: connection.socketPath, viewerUrl: "" });
  });

  it("ignores stale persisted bridge command and args in favour of server-derived defaults", async () => {
    const dir = directory(); const first = createConfigStore(dir, { ...testConnectionDefaults, bridgeCommand: "node", bridgeArgs: [] });
    await first.update((current) => ({ ...current, enabled: true }));
    expect(createConfigStore(dir, testConnectionDefaults).read()).toMatchObject({ enabled: true, bridgeCommand: testConnectionDefaults.bridgeCommand, bridgeArgs: testConnectionDefaults.bridgeArgs });
  });
  it("rejects a symlink anywhere in the XDG state-home ancestor chain", () => {
    const root = directory(); const target = join(root, "target"); mkdirSync(target); const linked = join(root, "state-link"); symlinkSync(target, linked);
    const previous = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = linked;
    try { expect(() => createConfigStore(undefined, testConnectionDefaults)).toThrow(/unsafe/); }
    finally { if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous; }
  });
  it("keeps writes anchored to the verified directory descriptor after its path is swapped", async () => {
    const root = directory(); const app = join(root, "app"); const store = createConfigStore(app, testConnectionDefaults); const verified = join(root, "verified");
    renameSync(app, verified); mkdirSync(app, { mode: 0o700 });
    await store.update((current) => ({ ...current, enabled: true }));
    expect(createConfigStore(verified, testConnectionDefaults).read().enabled).toBe(true);
    expect(createConfigStore(app, testConnectionDefaults).read().enabled).toBe(false);
  });
});
