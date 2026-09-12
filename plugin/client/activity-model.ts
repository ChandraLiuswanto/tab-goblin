import { ACTIVITY_LIMIT, boundedText, redactUrl, type ActivityRecord } from "@tab-goblin/protocol";

export type ActivityFilter = "all" | "errors" | "manual";
export type SanitizedActivity = ActivityRecord;

const MANUAL_ACTIONS = new Set(["manual-take-control", "manual-reclaim", "manual-return-to-agent"]);

export function sanitizeActivity(records: readonly ActivityRecord[] | undefined): SanitizedActivity[] {
  return (records ?? [])
    .slice(0, ACTIVITY_LIMIT)
    .map((record) => ({
      operationId: boundedText(record.operationId, 64),
      source: boundedText(record.source, 80),
      tabId: record.tabId === null ? null : boundedText(record.tabId, 64),
      action: boundedText(record.action, 40),
      status: record.status,
      startedAt: boundedText(record.startedAt, 64),
      endedAt: record.endedAt === null ? null : boundedText(record.endedAt, 64),
      code: record.code === null ? null : boundedText(record.code, 40),
      url: record.url === null ? null : redactUrl(record.url),
      title: record.title === null ? null : boundedText(record.title, 200),
    }))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export function filterActivity(records: readonly SanitizedActivity[], filter: ActivityFilter): SanitizedActivity[] {
  if (filter === "errors") return records.filter((record) => record.status === "error");
  if (filter === "manual") return records.filter((record) => MANUAL_ACTIONS.has(record.action));
  return [...records];
}

export function formatActivityTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "Time unavailable";
  return new Date(parsed).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
