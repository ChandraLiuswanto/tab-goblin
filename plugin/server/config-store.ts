import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultTabGoblinSettings, tabGoblinSettingsSchema, type TabGoblinSettings } from "../shared/settings.js";

const CONFIG_FILE = "settings.json";
const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;
const NOFOLLOW = constants.O_NOFOLLOW;
const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW;

function appDirectory(): string {
  const stateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "/tmp", ".local", "state");
  return join(stateHome, "tabgoblin-plugin");
}

function unsafe(): Error { return new Error("TabGoblin config directory is unsafe"); }
function requireNoFollow(): void { if (!NOFOLLOW) throw unsafe(); }
function isOwned(stat: ReturnType<typeof fstatSync>): boolean {
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}
function componentPath(directoryFd: number, name: string): string {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) throw unsafe();
  // Linux exposes descriptor-relative paths here. Every operation below uses this
  // retained descriptor, never a path re-resolved after verification.
  return `/proc/self/fd/${directoryFd}/${name}`;
}
function directoryComponents(directory: string): string[] {
  return resolve(directory).split("/").filter(Boolean);
}

function openChildDirectory(parentFd: number, name: string): number {
  const path = componentPath(parentFd, name);
  let fd: number;
  try {
    fd = openSync(path, DIRECTORY_OPEN_FLAGS);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unsafe();
    try { mkdirSync(path, { mode: OWNER_DIRECTORY_MODE }); }
    catch (mkdirError: unknown) { if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw unsafe(); }
    try { fd = openSync(path, DIRECTORY_OPEN_FLAGS); }
    catch { throw unsafe(); }
  }
  const stat = fstatSync(fd);
  if (!stat.isDirectory()) { closeSync(fd); throw unsafe(); }
  return fd;
}

/**
 * Walk every absolute path component through a retained parent descriptor. This
 * rejects ancestor symlinks (including XDG_STATE_HOME) and prevents a later
 * rename/swap from redirecting config I/O to a different directory.
 */
function openPrivateDirectory(directory: string): number {
  requireNoFollow();
  let fd: number;
  try { fd = openSync("/", DIRECTORY_OPEN_FLAGS); }
  catch { throw unsafe(); }
  try {
    for (const component of directoryComponents(directory)) {
      const child = openChildDirectory(fd, component);
      closeSync(fd);
      fd = child;
    }
    const stat = fstatSync(fd);
    if (!stat.isDirectory() || !isOwned(stat)) throw unsafe();
    fchmodSync(fd, OWNER_DIRECTORY_MODE);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error instanceof Error && error.message === unsafe().message ? error : unsafe();
  }
}

function openPrivateFile(directoryFd: number, name: string): number {
  const fd = openSync(componentPath(directoryFd, name), constants.O_RDONLY | NOFOLLOW);
  const stat = fstatSync(fd);
  if (!stat.isFile() || !isOwned(stat)) { closeSync(fd); throw new Error("TabGoblin config file is unsafe"); }
  fchmodSync(fd, OWNER_FILE_MODE);
  return fd;
}

function readConfig(directoryFd: number): TabGoblinSettings {
  try {
    const fd = openPrivateFile(directoryFd, CONFIG_FILE);
    try { return tabGoblinSettingsSchema.parse(JSON.parse(readFileSync(fd, "utf8"))); }
    finally { closeSync(fd); }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultTabGoblinSettings;
    throw error;
  }
}

function writeConfig(directoryFd: number, value: TabGoblinSettings): void {
  const temporary = `.${CONFIG_FILE}.${randomUUID()}.tmp`;
  const temporaryPath = componentPath(directoryFd, temporary);
  const configPath = componentPath(directoryFd, CONFIG_FILE);
  const fd = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, OWNER_FILE_MODE);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !isOwned(stat)) throw new Error("TabGoblin temporary config file is unsafe");
    fchmodSync(fd, OWNER_FILE_MODE);
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    // Both names are descriptor-relative to the same verified directory.
    renameSync(temporaryPath, configPath);
    fsyncSync(directoryFd);
  } finally { rmSync(temporaryPath, { force: true }); }
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
  let value: TabGoblinSettings;
  try { value = readConfig(directoryFd); }
  catch (error) { closeSync(directoryFd); throw error; }
  let writes = Promise.resolve();
  return {
    path: join(absoluteDirectory, CONFIG_FILE),
    read: () => value,
    update(change) {
      const run = writes.then(() => {
        const next = tabGoblinSettingsSchema.parse(change(value));
        writeConfig(directoryFd, next);
        value = next;
        return next;
      });
      writes = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}
