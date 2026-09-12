import { z } from "zod";

const boundedString = z.string().min(1).max(4096);
const generationMap = z.record(z.string().min(1).max(128), z.number().int().nonnegative()).refine(
  (value) => Object.keys(value).length <= 512,
  "too many lifecycle generations",
);
const boundedIds = z.array(z.string().min(1).max(128)).max(512);
const pendingRevocations = z.array(z.object({
  kind: z.enum(["agent", "workspace"]),
  id: z.string().min(1).max(128),
}).strict()).max(512);

/** App-owned server configuration. It is intentionally not a Paseo host setting. */
export const tabGoblinSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  enabledWorkspaceCwds: z.array(boundedString).max(256).default([]),
  bridgeCommand: boundedString.default("node"),
  bridgeArgs: z.array(boundedString).max(32).default([]),
  socketPath: boundedString.default("/tmp/tabgoblin.sock"),
  viewerUrl: z.string().max(4096).default(""),
  workspaceGenerations: generationMap.default({}),
  agentGenerations: generationMap.default({}),
  // Active IDs are cleanup targets, not credentials or lifecycle generations.
  activeAgentIds: boundedIds.default([]),
  // An acknowledged revocation must be reset before that agent can receive a new enrollment.
  revokedAgentIds: boundedIds.default([]),
  // Workspaces are reset only when an explicitly opted-in session next needs them.
  revokedWorkspaceIds: boundedIds.default([]),
  // Authority cleanup work only. It intentionally contains no enrollment or bearer material.
  pendingRevocations: pendingRevocations.default([]),
}).strict();

export const defaultTabGoblinSettings = tabGoblinSettingsSchema.parse({});
export type TabGoblinSettings = z.infer<typeof tabGoblinSettingsSchema>;
