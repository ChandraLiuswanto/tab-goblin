import { chmodSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfigStore } from "../server/config-store.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function directory() { const value = mkdtempSync(join(tmpdir(), "tabgoblin-config-")); directories.push(value); return value; }
describe("app-owned durable config", () => {
  it("persists bounded configuration privately across a reload", async () => {
    const dir = directory(); const first = createConfigStore(dir);
    await first.update((current) => ({ ...current, enabled: true, enabledWorkspaceCwds: ["/work"] }));
    expect(lstatSync(dir).mode & 0o077).toBe(0);
    expect(lstatSync(first.path).mode & 0o077).toBe(0);
    expect(createConfigStore(dir).read()).toMatchObject({ enabled: true, enabledWorkspaceCwds: ["/work"] });
  });
  it("rejects a symlinked app directory", () => {
    const root = directory(); const target = join(root, "target"); mkdirSync(target); const linked = join(root, "linked"); symlinkSync(target, linked);
    expect(() => createConfigStore(linked)).toThrow(/unsafe/);
  });
});
