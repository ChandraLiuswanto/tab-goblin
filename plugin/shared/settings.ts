import { defineSettings, settingsRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const tabGoblinSettings = defineSettings({
  id: "tabgoblin",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(false),
    enabledWorkspaceCwds: z.array(z.string()).default([]),
    mcpCapableProviders: z.array(z.string()).default(["claude", "codex", "copilot", "opencode"]),
    bridgeCommand: z.string().default("node"),
    bridgeArgs: z.array(z.string()).default([]),
    socketPath: z.string().default(""),
    viewerUrl: z.string().default(""),
  }),
});

export const settings = settingsRpc("tabgoblin");
export type TabGoblinSettings = z.infer<typeof tabGoblinSettings.schema>;
