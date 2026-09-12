import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CSRF_HEADER } from "@tab-goblin/protocol";
import { ActivityFeed } from "../../packages/gateway/src/activity-feed.js";
import { createAdminServer } from "../../packages/gateway/src/admin-server.js";
import { EnrollmentRegistry } from "../../packages/gateway/src/enrollment.js";
import { OwnershipController } from "../../packages/gateway/src/ownership.js";
import { PairingCodes } from "../../packages/gateway/src/pairing.js";
import { createViewerServer } from "../../packages/gateway/src/viewer-server.js";
import { filterActivity, sanitizeActivity } from "../client/activity-model.js";
import { createConfigStore } from "../server/config-store.js";
import { createGatewayManager } from "../server/gateway-client.js";
import { createHandlers } from "../server/handlers.js";
import { createLifecycleCoordinator } from "../server/lifecycle-coordinator.js";
import { activityRpc } from "../shared/rpc.js";
import { testConnectionDefaults } from "./connection-defaults.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.allSettled(cleanups.splice(0).reverse().map((cleanup) => cleanup())); });

async function pair(base: string, origin: string, pairing: PairingCodes, workspaceId: string) {
  const issued = pairing.issue(workspaceId);
  const response = await fetch(`${base}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ code: issued.code }),
  });
  const body = await response.json() as { csrfToken: string };
  return { cookie: response.headers.get("set-cookie")!.split(";", 1)[0]!, csrfToken: body.csrfToken };
}

function headers(session: { cookie: string; csrfToken: string }, origin: string) {
  return { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken, origin, "content-type": "application/json" };
}

describe("manual transition activity integration", () => {
  it("flows real viewer transitions through activity RPC into the manual filter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabgoblin-manual-activity-"));
    const socketPath = join(directory, "gateway.sock");
    const pairing = new PairingCodes();
    const ownership = new OwnershipController();
    const activity = new ActivityFeed();
    const services = {
      runtime: { state: () => "ready", endpoints: () => null, start: async () => ({}), stop: async () => undefined, stageFile: async () => "" },
      ownership: () => ownership,
      activity: () => activity,
      browser: async () => { throw new Error("not used"); },
      issuePairingCode: (workspaceId: string) => pairing.issue(workspaceId),
      viewerUrlFor: () => "https://viewer.test/",
    };
    const admin = createAdminServer({ services: services as never, enrollment: new EnrollmentRegistry(), socketPath });
    await admin.listen();
    const viewer = createViewerServer({ services: services as never, pairing, port: 0, staticRoot: directory, allowedOrigins: ["http://127.0.0.1"] });
    const port = await viewer.listen();
    const base = `http://127.0.0.1:${port}`;
    const gateway = createGatewayManager(() => socketPath);
    const config = createConfigStore(join(directory, "config"), testConnectionDefaults);
    await config.update((current) => ({ ...current, socketPath }));
    const handlers = createHandlers(gateway, createLifecycleCoordinator(config, gateway));
    const context = { paseo: { workspaces: { list: async () => ({ entries: [{ id: "ws-1", workspaceDirectory: "/w/one" }] }) } } } as any;
    cleanups.push(async () => { gateway.close(); await viewer.close(); await admin.close(); await rm(directory, { recursive: true, force: true }); });

    const first = await pair(base, base, pairing, "ws-1");
    const second = await pair(base, base, pairing, "ws-1");
    await fetch(`${base}/api/take-control`, { method: "POST", headers: headers(first, base), body: "{}" });
    await fetch(`${base}/api/reclaim`, { method: "POST", headers: headers(second, base), body: JSON.stringify({ confirm: true }) });
    await fetch(`${base}/api/return-to-agent`, { method: "POST", headers: headers(second, base), body: "{}" });

    const scope = activityRpc.input.parse({ workspaceId: "ws-1", cwd: "/w/one" });
    const response = activityRpc.output.parse(await handlers.activity(scope, context));
    expect(response.ok).toBe(true);
    const filtered = filterActivity(sanitizeActivity(response.ok ? response.activity : undefined), "manual");
    expect(filtered.map((record) => record.action)).toEqual([
      "manual-return-to-agent",
      "manual-reclaim",
      "manual-take-control",
    ]);
    expect(filtered).toHaveLength(3);
    expect(filtered.every((record) => record.status === "ok" && record.source === "viewer")).toBe(true);
  });
});
