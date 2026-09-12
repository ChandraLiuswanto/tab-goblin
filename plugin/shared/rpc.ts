import { defineRpc } from "@getpaseo/plugin";
import { AdminResponseSchema, PROTOCOL_VERSION } from "@tab-goblin/protocol";
import { z } from "zod";

const workspaceId = z.string().min(1).max(128);
const cwd = z.string().min(1).max(4096);
export const gatewayResponse = AdminResponseSchema;
export const pingRpc = defineRpc({ name: "tabgoblin.ping", input: z.object({}), output: z.object({ protocolVersion: z.number().int() }) });
const gatewayRpc = (name: string) => defineRpc({ name, input: z.object({ workspaceId, cwd }), output: gatewayResponse });
export const statusRpc = gatewayRpc("tabgoblin.status");
export const startRpc = gatewayRpc("tabgoblin.start");
export const stopRpc = gatewayRpc("tabgoblin.stop");
export const activityRpc = gatewayRpc("tabgoblin.activity");
export const pairRpc = gatewayRpc("tabgoblin.pair");
export const returnToAgentRpc = gatewayRpc("tabgoblin.return-to-agent");
export const enableWorkspaceRpc = defineRpc({ name: "tabgoblin.enable-workspace", input: z.object({ workspaceId, cwd, enabled: z.boolean() }), output: z.object({ ok: z.boolean() }) });
export const protocolVersion = PROTOCOL_VERSION;
