import { z } from "zod";
import { NETWORK_DIAGNOSTIC_LIMIT } from "./network.js";
import { isNavigableUrl } from "./text.js";

export const TOOL_NAMES = [
  "tabgoblin_status",
  "tabgoblin_start",
  "tabgoblin_list_tabs",
  "tabgoblin_new_tab",
  "tabgoblin_close_tab",
  "tabgoblin_navigate",
  "tabgoblin_back",
  "tabgoblin_forward",
  "tabgoblin_reload",
  "tabgoblin_snapshot",
  "tabgoblin_click",
  "tabgoblin_fill",
  "tabgoblin_type",
  "tabgoblin_keypress",
  "tabgoblin_select",
  "tabgoblin_hover",
  "tabgoblin_scroll",
  "tabgoblin_drag",
  "tabgoblin_wait",
  "tabgoblin_text",
  "tabgoblin_screenshot",
  "tabgoblin_logs",
  "tabgoblin_network",
  "tabgoblin_upload",
  "tabgoblin_evaluate",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const tabId = z.string().min(1).max(64);
const ref = z.string().min(5).max(64).regex(/^r\d+-e\d+$/);
const timeoutMs = z.number().int().min(1000).max(30_000).default(10_000);
const navigableUrl = z
  .string()
  .min(1)
  .max(2048)
  .refine(isNavigableUrl, { message: "Only http: and https: URLs are allowed" });
const scrollDelta = z.number().int().min(-100_000).max(100_000);

export const ToolInputSchemas = {
  tabgoblin_status: z.object({}).strict(),
  tabgoblin_start: z.object({}).strict(),
  tabgoblin_list_tabs: z.object({}).strict(),
  tabgoblin_new_tab: z.object({ url: navigableUrl }).strict(),
  tabgoblin_close_tab: z.object({ tabId }).strict(),
  tabgoblin_navigate: z.object({ tabId, url: navigableUrl, timeoutMs }).strict(),
  tabgoblin_back: z.object({ tabId, timeoutMs }).strict(),
  tabgoblin_forward: z.object({ tabId, timeoutMs }).strict(),
  tabgoblin_reload: z.object({ tabId, timeoutMs }).strict(),
  tabgoblin_snapshot: z.object({ tabId }).strict(),
  tabgoblin_click: z.object({ tabId, ref, timeoutMs }).strict(),
  tabgoblin_fill: z
    .object({ tabId, ref, value: z.string().max(4096), timeoutMs })
    .strict(),
  tabgoblin_type: z.object({ tabId, ref, text: z.string().max(4096), timeoutMs }).strict(),
  tabgoblin_keypress: z
    .object({ tabId, key: z.string().min(1).max(40), timeoutMs })
    .strict(),
  tabgoblin_select: z
    .object({
      tabId,
      ref,
      values: z.array(z.string().max(200)).max(20),
      timeoutMs,
    })
    .strict(),
  tabgoblin_hover: z.object({ tabId, ref, timeoutMs }).strict(),
  tabgoblin_scroll: z.object({ tabId, dx: scrollDelta, dy: scrollDelta }).strict(),
  tabgoblin_drag: z.object({ tabId, fromRef: ref, toRef: ref, timeoutMs }).strict(),
  tabgoblin_wait: z
    .object({
      tabId,
      condition: z.enum(["load", "text"]),
      text: z.string().max(200).optional(),
      timeoutMs,
    })
    .strict()
    .refine((input) => input.condition !== "text" || input.text !== undefined, {
      message: "text is required when condition is text",
      path: ["text"],
    }),
  tabgoblin_text: z
    .object({
      tabId,
      maxChars: z.number().int().min(100).max(50_000).default(10_000),
    })
    .strict(),
  tabgoblin_screenshot: z
    .object({ tabId, fullPage: z.boolean().default(false) })
    .strict(),
  tabgoblin_logs: z
    .object({ tabId, maxEntries: z.number().int().min(1).max(100).default(50) })
    .strict(),
  tabgoblin_network: z
    .object({
      tabId,
      maxEntries: z.number().int().min(1).max(NETWORK_DIAGNOSTIC_LIMIT).default(50),
    })
    .strict(),
  tabgoblin_upload: z
    .object({ tabId, ref, path: z.string().min(1).max(4096) })
    .strict(),
  tabgoblin_evaluate: z
    .object({
      tabId,
      expression: z.string().max(2000),
      maxChars: z.number().int().min(100).max(10_000).default(2000),
    })
    .strict(),
} satisfies Record<ToolName, z.ZodType>;
