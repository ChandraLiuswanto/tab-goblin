import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../src/index.js";
import { createIsolatedWorkspace, workspaceEnvironment } from "./isolated-workspace.js";

interface PackageManifest {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const repoRoot = new URL("../../../", import.meta.url);
const repoRootPath = fileURLToPath(repoRoot);

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(new URL(path, repoRoot), "utf8")) as PackageManifest;
}

function run(command: string, cwd: string, workspaceRoot: string): void {
  execSync(command, {
    cwd,
    env: workspaceEnvironment(workspaceRoot),
    stdio: "pipe",
  });
}

describe("protocol package", () => {
  it("exports a protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe("workspace manifest wiring", () => {
  it("exposes ordered eventual full-workspace build and typecheck commands", () => {
    const root = readManifest("package.json");

    expect(root.scripts?.build).toBe(
      [
        "npm run build -w @tab-goblin/protocol",
        "npm run build -w @tab-goblin/fixture-site",
        "npm run build -w @tab-goblin/gateway",
        "npm run build -w @tab-goblin/mcp-bridge",
        "npm run build -w @tab-goblin/viewer",
      ].join(" && "),
    );
    expect(root.scripts?.typecheck).toBe(
      [
        "npm run build -w @tab-goblin/protocol",
        "npm run typecheck -w @tab-goblin/fixture-site",
        "npm run typecheck -w @tab-goblin/gateway",
        "npm run typecheck -w @tab-goblin/mcp-bridge",
        "npm run typecheck -w @tab-goblin/viewer",
        "npm run typecheck -w plugin",
      ].join(" && "),
    );
  });

  it("defines the future fixture, bridge, and viewer build wiring", () => {
    const fixture = readManifest("packages/fixture-site/package.json");
    const bridge = readManifest("packages/mcp-bridge/package.json");
    const viewer = readManifest("packages/viewer/package.json");

    expect(fixture.scripts).toMatchObject({
      build: "tsc -p tsconfig.json",
      typecheck: "tsc -p tsconfig.json --noEmit",
    });
    expect(bridge.scripts?.build).toBe("tsc -p tsconfig.json && chmod +x dist/index.js");
    expect(viewer.scripts).toMatchObject({
      build: "esbuild src/viewer.ts --bundle --format=esm --outfile=public/viewer.js",
      typecheck:
        "tsc --noEmit --target ES2023 --module ESNext --moduleResolution Bundler --lib ES2023,DOM --strict --skipLibCheck src/*.ts",
    });
    expect(viewer.devDependencies).toMatchObject({
      "@types/novnc__novnc": "^1.6.0",
      esbuild: expect.stringMatching(/^\^/),
    });
  });

  it("emits protocol declarations before checking a representative dependent import", () => {
    const root = readManifest("package.json");
    const firstTypecheckCommand = root.scripts?.typecheck?.split(" && ")[0];
    const workspace = createIsolatedWorkspace(["protocol"]);
    const protocolDist = join(workspace.packagePath("protocol"), "dist");
    const fixtureDir = join(workspace.root, "fixtures");
    const fixture = join(fixtureDir, "dependent.ts");

    mkdirSync(fixtureDir);
    writeFileSync(
      fixture,
      'import { PROTOCOL_VERSION } from "@tab-goblin/protocol";\nconst version: number = PROTOCOL_VERSION;\nvoid version;\n',
    );

    try {
      expect(existsSync(protocolDist)).toBe(false);
      if (!firstTypecheckCommand) throw new Error("root typecheck command is missing");
      run(firstTypecheckCommand, workspace.root, workspace.root);
      expect(existsSync(join(protocolDist, "index.d.ts"))).toBe(true);
      execFileSync(
        join(repoRootPath, "node_modules/.bin/tsc"),
        [
          "--noEmit",
          "--target",
          "ES2023",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--strict",
          "--skipLibCheck",
          fixture,
        ],
        {
          cwd: workspace.root,
          env: workspaceEnvironment(workspace.root),
          stdio: "pipe",
        },
      );
    } finally {
      workspace.cleanup();
    }
  });

  it("typechecks the planned noVNC root import through the viewer command", () => {
    const viewer = readManifest("packages/viewer/package.json");
    const workspace = createIsolatedWorkspace(["protocol", "viewer"]);
    const viewerDir = workspace.packagePath("viewer");
    const fixture = join(viewerDir, "src", "manifest-typecheck-smoke.ts");

    expect(existsSync(fixture)).toBe(false);
    writeFileSync(
      fixture,
      [
        'import RFB from "@novnc/novnc";',
        'const rfb = new RFB(document.createElement("div"), "wss://example.invalid");',
        "rfb.viewOnly = true;",
        "rfb.disconnect();",
      ].join("\n"),
    );

    try {
      // The isolated protocol package starts without declarations, like a clean checkout.
      // Standalone viewer typechecking consumes the declarations built in this workspace.
      expect(existsSync(join(workspace.packagePath("protocol"), "dist"))).toBe(false);
      run("npm run build -w @tab-goblin/protocol", workspace.root, workspace.root);
      const typecheckCommand = viewer.scripts?.typecheck;
      if (!typecheckCommand) throw new Error("viewer typecheck command is missing");
      run(typecheckCommand, viewerDir, workspace.root);
    } finally {
      workspace.cleanup();
    }
  });
});
