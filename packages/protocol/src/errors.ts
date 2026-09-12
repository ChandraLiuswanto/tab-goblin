import { z } from "zod";
import { boundedText } from "./text.js";

export const ERROR_CODES = [
  "session_not_ready",
  "tab_not_found",
  "stale_ref",
  "manual_control",
  "busy",
  "timeout_uncertain",
  "auth_failed",
  "runtime_unavailable",
  "invalid_input",
  "not_enrolled",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

// Only transient infrastructure faults are retryable. A timed-out mutation is never
// retryable: callers must inspect current state instead of replaying a side effect.
const RETRYABLE: ReadonlySet<ErrorCode> = new Set(["busy", "runtime_unavailable"]);

export const TabGoblinErrorSchema = z
  .object({
    code: z.enum(ERROR_CODES),
    message: z.string().max(400),
    retryable: z.boolean(),
  })
  .strict()
  .refine(({ code, retryable }) => !retryable || RETRYABLE.has(code), {
    message: "retryable is only allowed for transient infrastructure faults",
    path: ["retryable"],
  });
export type TabGoblinError = z.infer<typeof TabGoblinErrorSchema>;

export function tabGoblinError(
  code: ErrorCode,
  message: string,
  retryable = RETRYABLE.has(code),
): TabGoblinError {
  return {
    code,
    message: boundedText(message, 400),
    retryable: retryable && RETRYABLE.has(code),
  };
}
