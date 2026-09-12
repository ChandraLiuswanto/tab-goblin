import { z } from "zod";
import { boundedText, redactUrl } from "./text.js";

export const ACTIVITY_LIMIT = 200;

// Strictness is load-bearing: unknown fields could contain typed values, evaluation
// results, credentials, or other page data that must never enter activity storage.
export const ActivityRecordSchema = z
  .object({
    operationId: z.string().min(1).max(64),
    source: z.string().max(80),
    tabId: z.string().max(64).nullable(),
    action: z.string().max(40),
    status: z.enum(["running", "ok", "error"]),
    startedAt: z.string().max(64),
    endedAt: z.string().max(64).nullable(),
    code: z.string().max(40).nullable(),
    url: z.string().max(4096).transform(redactUrl).pipe(z.string().max(2048)).nullable(),
    title: z
      .string()
      .max(4096)
      .transform((value) => boundedText(value, 200))
      .pipe(z.string().max(200))
      .nullable(),
  })
  .strict();
export type ActivityRecord = z.infer<typeof ActivityRecordSchema>;
