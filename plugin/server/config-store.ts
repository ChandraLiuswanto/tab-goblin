import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultTabGoblinSettings, tabGoblinSettingsSchema, type TabGoblinSettings } from "../shared/settings.js";

const CONFIG_FILE = "settings.json";

function appDirectory(): string {
  const stateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "/tmp", ".local", "state");
  return join(stateHome, "tabgoblin-plugin");
}

function secureDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("TabGoblin config directory is unsafe");
  chmodSync(directory, 0o700);
}

function secureFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("TabGoblin config file is unsafe");
  if ((stat.mode & 0o077) !== 0) chmodSync(path, 0o600);
}

function readConfig(path: string): TabGoblinSettings {
  try {
    secureFile(path);
    const fd = openSync(path, "r");
    try {
      return tabGoblinSettingsSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
    } finally {
      closeSync(fd);
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultTabGoblinSettings;
    throw error;
  }
}

function writeConfig(directory: string, path: string, value: TabGoblinSettings): void {
  const temporary = join(directory, `.${CONFIG_FILE}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export interface ConfigStore {
  read(): TabGoblinSettings;
  update(change: (current: TabGoblinSettings) => TabGoblinSettings): Promise<TabGoblinSettings>;
  path: string;
}

/** Synchronous load guarantees hooks have a durable fail-closed value at registration time. */
export function createConfigStore(directory = appDirectory()): ConfigStore {
  const absoluteDirectory = resolve(directory);
  secureDirectory(absoluteDirectory);
  const path = join(absoluteDirectory, CONFIG_FILE);
  let value = readConfig(path);
  let writes = Promise.resolve();
  return {
    path,
    read: () => value,
    update(change) {
      const run = writes.then(() => {
        const next = tabGoblinSettingsSchema.parse(change(value));
        writeConfig(absoluteDirectory, path, next);
        value = next;
        return next;
      });
      writes = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}
