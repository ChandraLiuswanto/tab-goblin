import { randomUUID } from "node:crypto";
import { TabGoblinErrorSchema } from "@tab-goblin/protocol";
import type { ActivityFeed } from "./activity-feed.js";

export type ManualActivityAction = "manual-take-control" | "manual-reclaim" | "manual-return-to-agent";
export type ManualActivitySource = "viewer" | "paseo-panel";

/** Records exactly one bounded metadata-only event around an actual ownership transition. */
export async function recordManualTransition<T>(
  feed: ActivityFeed,
  action: ManualActivityAction,
  source: ManualActivitySource,
  transition: () => Promise<T> | T,
): Promise<T> {
  const operationId = randomUUID();
  feed.begin({ operationId, source, tabId: null, action });
  try {
    const result = await transition();
    feed.finish(operationId, { status: "ok" });
    return result;
  } catch (error: unknown) {
    const parsed = TabGoblinErrorSchema.safeParse(error);
    feed.finish(operationId, { status: "error", code: parsed.success ? parsed.data.code : "transition_failed" });
    throw error;
  }
}
