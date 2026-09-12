import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../src/index.js";

interface PackageManifest {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const repoRoot = new URL("../../../", import.meta.url);

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(new URL(path, repoRoot), "utf8")) as PackageManifest;
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
        "npm run typecheck -w @tab-goblin/protocol",
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
    expect(viewer.devDependencies?.esbuild).toMatch(/^\^/);
  });
});
