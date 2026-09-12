import { execFileSync, execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../src/index.js";

interface PackageManifest {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const repoRoot = new URL("../../../", import.meta.url);
const repoRootPath = fileURLToPath(repoRoot);

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(new URL(path, repoRoot), "utf8")) as PackageManifest;
}

function run(command: string, cwd = repoRootPath): void {
  execSync(command, { cwd, stdio: "pipe" });
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
    const protocolDist = join(repoRootPath, "packages/protocol/dist");
    const runDir = join(repoRootPath, ".tabgoblin-run");
    mkdirSync(runDir, { recursive: true });
    const fixtureDir = mkdtempSync(join(runDir, "protocol-typecheck-"));
    const fixture = join(fixtureDir, "dependent.ts");

    writeFileSync(
      fixture,
      'import { PROTOCOL_VERSION } from "@tab-goblin/protocol";\nconst version: number = PROTOCOL_VERSION;\nvoid version;\n',
    );
    rmSync(protocolDist, { recursive: true, force: true });

    try {
      if (!firstTypecheckCommand) throw new Error("root typecheck command is missing");
      run(firstTypecheckCommand);
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
        { cwd: repoRootPath, stdio: "pipe" },
      );
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
      rmSync(protocolDist, { recursive: true, force: true });
    }
  });

  it("typechecks the planned noVNC root import through the viewer command", () => {
    const viewer = readManifest("packages/viewer/package.json");
    const viewerDir = join(repoRootPath, "packages/viewer");
    const sourceDir = join(viewerDir, "src");
    const sourceDirExisted = existsSync(sourceDir);
    const fixture = join(sourceDir, "manifest-typecheck-smoke.ts");

    mkdirSync(sourceDir, { recursive: true });
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
      const typecheckCommand = viewer.scripts?.typecheck;
      if (!typecheckCommand) throw new Error("viewer typecheck command is missing");
      run(typecheckCommand, viewerDir);
    } finally {
      rmSync(fixture, { force: true });
      if (!sourceDirExisted) rmSync(sourceDir, { recursive: true, force: true });
    }
  });
});
