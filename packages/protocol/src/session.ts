import { z } from "zod";

export const OWNERSHIP_STATES = [
  "agent-ready",
  "taking-control",
  "manual",
  "returning-control",
  "needs-attention",
] as const;
export type OwnershipState = (typeof OWNERSHIP_STATES)[number];

export const SESSION_STATES = ["stopped", "starting", "ready", "failed"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

const tabId = z.string().min(1).max(64);
const ref = z.string().min(5).max(64).regex(/^r\d+-e\d+$/);

export const TabSchema = z
  .object({
    tabId,
    title: z.string().max(200),
    url: z.string().max(2048),
    active: z.boolean(),
  })
  .strict();
export type Tab = z.infer<typeof TabSchema>;

export const SessionStatusSchema = z
  .object({
    workspaceId: z.string().min(1).max(128),
    sessionState: z.enum(SESSION_STATES),
    ownership: z
      .object({
        state: z.enum(OWNERSHIP_STATES),
        generation: z.number().int().nonnegative().safe(),
        owner: z.enum(["agent", "viewer"]).nullable(),
      })
      .strict(),
    startedAt: z.string().max(64).nullable(),
    viewerUrl: z.string().max(2048).nullable(),
    lastError: z
      .object({ code: z.string().max(40), message: z.string().max(400) })
      .strict()
      .nullable(),
  })
  .strict();
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SnapshotNodeSchema = z
  .object({
    ref,
    role: z.string().max(40),
    name: z.string().max(200),
    value: z.string().max(200).optional(),
    depth: z.number().int().nonnegative().max(60),
  })
  .strict();

export const SnapshotSchema = z
  .object({
    tabId,
    revision: z.number().int().positive().safe(),
    url: z.string().max(2048),
    title: z.string().max(200),
    nodes: z.array(SnapshotNodeSchema).max(2000),
  })
  .strict();
export type Snapshot = z.infer<typeof SnapshotSchema>;

export function formatRef(revision: number, index: number): string {
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new RangeError("revision must be a positive safe integer");
  }
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError("index must be a non-negative safe integer");
  }
  return "r" + revision + "-e" + index;
}

export function parseRef(refValue: string): { revision: number; index: number } | null {
  const match = /^r(\d+)-e(\d+)$/.exec(refValue);
  if (!match) return null;

  const revision = Number(match[1]);
  const index = Number(match[2]);
  if (!Number.isSafeInteger(revision) || revision <= 0 || !Number.isSafeInteger(index)) {
    return null;
  }
  return { revision, index };
}
