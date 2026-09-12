import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultTabGoblinSettings, tabGoblinSettingsSchema, type TabGoblinSettings } from "../shared/settings.js";

const CONFIG_FILE = "settings.json";
const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function appDirectory(): string {
  const stateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "/tmp", ".local", "state");
  return join(stateHome, "tabgoblin-plugin");
}

function openPrivateDirectory(directory: string): number {
  mkdirSync(directory, { recursive: true, mode: OWNER_DIRECTORY_MODE });
  let fd: number;
  try { fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW); }
  catch { throw new Error("TabGoblin config directory is unsafe"); }
  const stat = fstatSync(fd);
  if (!stat.isDirectory() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) { closeSync(fd); throw new Error("TabGoblin config directory is unsafe"); }
  fchmodSync(fd, OWNER_DIRECTORY_MODE);
  return fd;
}

function openPrivateFile(path: string): number {
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  const stat = fstatSync(fd);
  if (!stat.isFile() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) { closeSync(fd); throw new Error("TabGoblin config file is unsafe"); }
  fchmodSync(fd, OWNER_FILE_MODE);
  return fd;
}

function readConfig(path: string): TabGoblinSettings {
  try {
    const fd = openPrivateFile(path);
    try { return tabGoblinSettingsSchema.parse(JSON.parse(readFileSync(fd, "utf8"))); }
    finally { closeSync(fd); }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultTabGoblinSettings;
    throw error;
  }
}

function writeConfig(directory: string, directoryFd: number, path: string, value: TabGoblinSettings): void {
  const temporary = join(directory, `.${CONFIG_FILE}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, OWNER_FILE_MODE);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("TabGoblin temporary config file is unsafe");
    fchmodSync(fd, OWNER_FILE_MODE);
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    // The verified private directory retains its mode; replacement is same-directory and atomic.
    renameSync(temporary, path);
    fsyncSync(directoryFd);
  } finally { rmSync(temporary, { force: true }); }
}

export interface ConfigStore {
  read(): TabGoblinSettings;
  update(change: (current: TabGoblinSettings) => TabGoblinSettings): Promise<TabGoblinSettings>;
  path: string;
}

/** Synchronous load guarantees hooks have a durable fail-closed value at registration time. */
export function createConfigStore(directory = appDirectory()): ConfigStore {
  const absoluteDirectory = resolve(directory);
  const directoryFd = openPrivateDirectory(absoluteDirectory);
  const path = join(absoluteDirectory, CONFIG_FILE);
  let value: TabGoblinSettings;
  try { value = readConfig(path); } finally { closeSync(directoryFd); }
  let writes = Promise.resolve();
  return {
    path,
    read: () => value,
    update(change) {
      const run = writes.then(() => {
        const next = tabGoblinSettingsSchema.parse(change(value));
        const writeDirectoryFd = openPrivateDirectory(absoluteDirectory);
        try { writeConfig(absoluteDirectory, writeDirectoryFd, path, next); }
        finally { closeSync(writeDirectoryFd); }
        value = next;
        return next;
      });
      writes = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}
