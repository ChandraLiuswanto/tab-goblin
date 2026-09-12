import { z } from "zod";
import { ACTIVITY_LIMIT, ActivityRecordSchema } from "./activity.js";
import { TabGoblinErrorSchema } from "./errors.js";
import { SessionStatusSchema, SnapshotSchema, TabSchema } from "./session.js";
import { TOOL_NAMES } from "./tools.js";

export const ADMIN_SOCKET_ENV = "TABGOBLIN_SOCKET";
export const ENROLLMENT_ENV = "TABGOBLIN_ENROLLMENT";
export const MCP_SERVER_NAME = "tabgoblin";

const workspaceId = z.string().min(1).max(128);
const agentId = z.string().min(1).max(128);
const cwd = z.string().min(1).max(4096);
const enrollment = z.string().uuid();
const gatewayInstanceId = z.string().uuid();
// Generation zero is the initial lifecycle. T12 must persist generations returned
// by explicit reset operations and attach them to every later lifecycle notification.
const lifecycleGeneration = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const scopedOperation = (op: "status" | "tabs" | "start" | "stop" | "activity" | "pair" | "return-to-agent") =>
  z.object({ op: z.literal(op), workspaceId }).strict();

export const AdminRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("health") }).strict(),
  scopedOperation("status"),
  scopedOperation("tabs"),
  scopedOperation("start"),
  scopedOperation("stop"),
  scopedOperation("activity"),
  scopedOperation("pair"),
  scopedOperation("return-to-agent"),
  // Tool input is validated again against the selected ToolInputSchemas member server-side.
  z
    .object({
      op: z.literal("tool"),
      enrollment,
      workspaceId,
      name: z.enum(TOOL_NAMES),
      input: z.record(z.string(), z.unknown()),
      source: z.string().min(1).max(80),
    })
    .strict(),
  z
    .object({
      op: z.literal("record-enrollment"),
      enrollment,
      cwd,
      workspaceId,
      workspaceGeneration: lifecycleGeneration.default(0),
    })
    .strict(),
  // The bridge's only call before it knows its workspace scope.
  z.object({ op: z.literal("resolve-enrollment"), enrollment }).strict(),
  z
    .object({
      op: z.literal("bind-enrollment"),
      cwd,
      agentId,
      workspaceId: workspaceId.nullable(),
      agentGeneration: lifecycleGeneration.default(0),
      workspaceGeneration: lifecycleGeneration.default(0),
    })
    .strict(),
  z
    .object({
      op: z.literal("session-open"),
      agentId,
      workspaceId: workspaceId.nullable(),
      purpose: z.enum(["interactive", "history"]),
      agentGeneration: lifecycleGeneration.default(0),
      workspaceGeneration: lifecycleGeneration.default(0),
    })
    .strict(),
  z.object({ op: z.literal("revoke-agent"), agentId }).strict(),
  z.object({ op: z.literal("revoke-workspace"), workspaceId }).strict(),
  z.object({ op: z.literal("reset-agent"), agentId }).strict(),
  z.object({ op: z.literal("reset-workspace"), workspaceId }).strict(),
]);
export type AdminRequest = z.infer<typeof AdminRequestSchema>;

export const AdminResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      status: SessionStatusSchema.optional(),
      activity: z.array(ActivityRecordSchema).max(ACTIVITY_LIMIT).optional(),
      tabs: z.array(TabSchema).max(100).optional(),
      snapshot: SnapshotSchema.optional(),
      pairingCode: z.string().min(8).max(64).optional(),
      pairingExpiresAt: z.string().max(64).optional(),
      lifecycleGeneration: lifecycleGeneration.optional(),
      protocolVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
      // New on every gateway process. Plugins reconcile only when this changes.
      gatewayInstanceId: gatewayInstanceId.optional(),
      binding: z
        .object({ agentId, workspaceId })
        .strict()
        .optional(),
      // Tool responses are operation-specific and validated/bounded by their producers.
      result: z.unknown().optional(),
    })
    .strict(),
  z.object({ ok: z.literal(false), error: TabGoblinErrorSchema }).strict(),
]);
export type AdminResponse = z.infer<typeof AdminResponseSchema>;
