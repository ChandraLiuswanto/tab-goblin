import { z } from "zod";
import { SessionStatusSchema } from "./session.js";

export const VIEWER_COOKIE = "tg_viewer";
export const CSRF_HEADER = "x-tabgoblin-csrf";
export const PAIRING_CODE_TTL_MS = 120_000;
export const VIEWER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const workspaceId = z.string().min(1).max(128);
const csrfToken = z.string().min(1).max(256);

// Pairing codes travel in request bodies, never URLs, log lines, or analytics events.
export const PairRequestSchema = z.object({ code: z.string().min(8).max(64) }).strict();
export const PairResponseSchema = z
  .object({ workspaceId, csrfToken, viewOnly: z.boolean() })
  .strict();

// Viewer status is session-specific: generic ownership alone never authorizes a viewer.
export const ViewerStatusSchema = SessionStatusSchema.extend({
  isOwner: z.boolean().default(false),
});
export type ViewerStatus = z.infer<typeof ViewerStatusSchema>;

export const ViewerSessionSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    workspaceId,
    csrfToken,
    expiresAt: z.number().int().positive().safe(),
  })
  .strict();
export type ViewerSession = z.infer<typeof ViewerSessionSchema>;
