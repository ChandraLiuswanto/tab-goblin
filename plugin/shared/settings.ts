import { z } from "zod";

const boundedString = z.string().min(1).max(4096);
export const socketPathSchema = z.string().min(1).max(4096).refine(
  (value) => value.startsWith("/") && !/[\u0000-\u001f\u007f]/.test(value),
  "socket path must be an absolute control-free path",
);
function safeViewerUrl(value: string): boolean {
  if (value === "") return true;
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    return (parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback))
      && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch { return false; }
}
export const viewerUrlSchema = z.string().max(2048).refine(safeViewerUrl, "viewer URL must be credential-free HTTPS or loopback HTTP");
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
  socketPath: socketPathSchema.default("/tmp/tabgoblin.sock"),
  viewerUrl: viewerUrlSchema.default(""),
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
