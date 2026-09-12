import { defineRpc } from "@getpaseo/plugin";
import { AdminResponseSchema, PROTOCOL_VERSION } from "@tab-goblin/protocol";
import { z } from "zod";

const workspaceId = z.string().min(1).max(128);
export const gatewayResponse = AdminResponseSchema;

export const pingRpc = defineRpc({
  name: "tabgoblin.ping",
  input: z.object({}),
  output: z.object({ protocolVersion: z.number().int() }),
});

export const statusRpc = defineRpc({
  name: "tabgoblin.status",
  input: z.object({ workspaceId, cwd: z.string().min(1).max(4096) }),
  output: gatewayResponse,
});
export const startRpc = defineRpc({ name: "tabgoblin.start", input: z.object({ workspaceId }), output: gatewayResponse });
export const stopRpc = defineRpc({ name: "tabgoblin.stop", input: z.object({ workspaceId }), output: gatewayResponse });
export const activityRpc = defineRpc({ name: "tabgoblin.activity", input: z.object({ workspaceId }), output: gatewayResponse });
export const pairRpc = defineRpc({ name: "tabgoblin.pair", input: z.object({ workspaceId }), output: gatewayResponse });
export const returnToAgentRpc = defineRpc({
  name: "tabgoblin.return-to-agent",
  input: z.object({ workspaceId }),
  output: gatewayResponse,
});
export const enableWorkspaceRpc = defineRpc({
  name: "tabgoblin.enable-workspace",
  input: z.object({ cwd: z.string().min(1).max(4096), enabled: z.boolean() }),
  output: z.object({ ok: z.boolean() }),
});

export const protocolVersion = PROTOCOL_VERSION;
