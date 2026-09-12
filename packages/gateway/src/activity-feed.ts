import {
  ACTIVITY_LIMIT,
  ActivityRecordSchema,
  type ActivityRecord,
} from "@tab-goblin/protocol";

export interface ActivityBeginInput {
  operationId: string;
  source: string;
  tabId: string | null;
  action: string;
}

export interface ActivityOutcome {
  status: "ok" | "error";
  code?: string | null;
  url?: string | null;
  title?: string | null;
}

export class ActivityFeed {
  private readonly records = new Map<string, ActivityRecord>();
  private readonly limit: number;

  constructor(limit = ACTIVITY_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new RangeError("activity limit must be a non-negative safe integer");
    }
    this.limit = Math.min(limit, ACTIVITY_LIMIT);
  }

  begin(input: ActivityBeginInput): void {
    const record = ActivityRecordSchema.parse({
      ...input,
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      code: null,
      url: null,
      title: null,
    });

    this.records.set(record.operationId, record);
    this.evictOldest();
  }

  finish(operationId: string, outcome: ActivityOutcome): void {
    const existing = this.records.get(operationId);
    if (!existing) return;

    const record = ActivityRecordSchema.parse({
      ...existing,
      status: outcome.status,
      endedAt: new Date().toISOString(),
      code: outcome.code ?? null,
      url: outcome.url ?? null,
      title: outcome.title ?? null,
    });
    this.records.set(operationId, record);
  }

  list(): ActivityRecord[] {
    return [...this.records.values()].reverse().map((record) => ({ ...record }));
  }

  clear(): void {
    this.records.clear();
  }

  private evictOldest(): void {
    while (this.records.size > this.limit) {
      const oldest = this.records.keys().next();
      if (oldest.done) return;
      this.records.delete(oldest.value);
    }
  }
}
