import { z } from "zod";

const boundedString = z.string().min(1).max(4096);
const generationMap = z.record(z.string().min(1).max(128), z.number().int().nonnegative()).refine(
  (value) => Object.keys(value).length <= 512,
  "too many lifecycle generations",
);

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
}).strict();

export const defaultTabGoblinSettings = tabGoblinSettingsSchema.parse({});
export type TabGoblinSettings = z.infer<typeof tabGoblinSettingsSchema>;
