import { z } from "zod";
import { redactUrl } from "./text.js";

export const NETWORK_DIAGNOSTIC_LIMIT = 100;

// This strict, body-free wire record deliberately excludes headers, cookies, timing,
// request/response bodies, and console data. Parsing also guarantees a redacted URL.
export const NetworkDiagnosticSchema = z
  .object({
    method: z.string().min(1).max(16),
    url: z.string().max(4096).transform(redactUrl).pipe(z.string().max(2048)),
    status: z.number().int().min(100).max(599),
  })
  .strict();
export type NetworkDiagnostic = z.infer<typeof NetworkDiagnosticSchema>;
