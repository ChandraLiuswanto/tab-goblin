import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sourceNodeModules = join(sourceRoot, "node_modules");

export interface IsolatedWorkspace {
  root: string;
  packagePath(name: string): string;
  cleanup(): void;
}

export function createIsolatedWorkspace(packageNames: string[]): IsolatedWorkspace {
  if (!existsSync(sourceNodeModules)) {
    throw new Error("root node_modules is missing; run npm ci before the acceptance tests");
  }

  const root = mkdtempSync(join(tmpdir(), "tabgoblin-workspace-"));
  cpSync(join(sourceRoot, "package.json"), join(root, "package.json"));
  cpSync(join(sourceRoot, "tsconfig.base.json"), join(root, "tsconfig.base.json"));
  mkdirSync(join(root, "packages"), { recursive: true });

  for (const name of packageNames) {
    const sourcePackage = join(sourceRoot, "packages", name);
    const targetPackage = join(root, "packages", name);
    mkdirSync(targetPackage, { recursive: true });
    cpSync(join(sourcePackage, "package.json"), join(targetPackage, "package.json"));
    const tsconfig = join(sourcePackage, "tsconfig.json");
    if (existsSync(tsconfig)) cpSync(tsconfig, join(targetPackage, "tsconfig.json"));
    cpSync(join(sourcePackage, "src"), join(targetPackage, "src"), { recursive: true });
  }

  const targetNodeModules = join(root, "node_modules");
  mkdirSync(targetNodeModules);
  for (const entry of readdirSync(sourceNodeModules)) {
    if (entry === "@tab-goblin") continue;
    symlinkSync(join(sourceNodeModules, entry), join(targetNodeModules, entry));
  }

  const workspaceScope = join(targetNodeModules, "@tab-goblin");
  mkdirSync(workspaceScope);
  for (const name of packageNames) {
    symlinkSync(join(root, "packages", name), join(workspaceScope, name));
  }

  return {
    root,
    packagePath: (name: string) => join(root, "packages", name),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function workspaceEnvironment(workspaceRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${join(workspaceRoot, "node_modules", ".bin")}:${process.env.PATH ?? ""}`,
  };
}
