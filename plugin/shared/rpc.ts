import { defineRpc } from "@getpaseo/plugin";
import { AdminResponseSchema, PROTOCOL_VERSION } from "@tab-goblin/protocol";
import { z } from "zod";
import { socketPathSchema, viewerUrlSchema } from "./settings.js";

const workspaceId = z.string().min(1).max(128);
const cwd = z.string().min(1).max(4096);
const workspaceScope = z.object({ workspaceId, cwd }).strict();
export const gatewayResponse = AdminResponseSchema;
export const pingRpc = defineRpc({ name: "tabgoblin.ping", input: z.object({}).strict(), output: z.object({ protocolVersion: z.number().int() }).strict() });
const gatewayRpc = (name: string) => defineRpc({ name, input: workspaceScope, output: gatewayResponse });
export const statusRpc = gatewayRpc("tabgoblin.status");
export const tabsRpc = gatewayRpc("tabgoblin.tabs");
export const startRpc = gatewayRpc("tabgoblin.start");
export const stopRpc = gatewayRpc("tabgoblin.stop");
export const activityRpc = gatewayRpc("tabgoblin.activity");
export const pairRpc = gatewayRpc("tabgoblin.pair");
export const returnToAgentRpc = gatewayRpc("tabgoblin.return-to-agent");
export const enableWorkspaceRpc = defineRpc({
  name: "tabgoblin.enable-workspace",
  input: workspaceScope.extend({ enabled: z.boolean() }).strict(),
  output: z.object({ ok: z.boolean() }).strict(),
});
export const configRpc = defineRpc({
  name: "tabgoblin.config",
  input: workspaceScope,
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      globallyEnabled: z.boolean(),
      workspaceEnabled: z.boolean(),
      effectiveEnabled: z.boolean(),
      socketPath: socketPathSchema,
      viewerUrl: viewerUrlSchema,
    }).strict(),
    z.object({ ok: z.literal(false) }).strict(),
  ]),
});
export const setGlobalEnabledRpc = defineRpc({
  name: "tabgoblin.set-global-enabled",
  input: workspaceScope.extend({ enabled: z.boolean() }).strict(),
  output: z.object({ ok: z.boolean() }).strict(),
});
export const updateConnectionRpc = defineRpc({
  name: "tabgoblin.update-connection",
  input: workspaceScope.extend({ socketPath: socketPathSchema, viewerUrl: viewerUrlSchema }).strict(),
  output: z.object({ ok: z.boolean() }).strict(),
});
export const protocolVersion = PROTOCOL_VERSION;
