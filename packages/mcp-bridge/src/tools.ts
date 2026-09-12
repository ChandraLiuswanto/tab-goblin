import { ToolInputSchemas, TOOL_NAMES, type ToolName } from "@tab-goblin/protocol";
import { z } from "zod";

const descriptions: Record<ToolName, string> = {
  tabgoblin_status: "Read the workspace TabGoblin session status, including readiness and manual-control state.",
  tabgoblin_start: "Start the workspace TabGoblin session before issuing tab commands; this is scoped to the enrolled workspace.",
  tabgoblin_list_tabs: "List the tabs in the enrolled workspace session with their identifiers, titles, redacted URLs, and active state.",
  tabgoblin_new_tab: "Open an http or https URL in a new workspace tab and return its tab identifier.",
  tabgoblin_close_tab: "Close one tab in the enrolled workspace session by its tab identifier.",
  tabgoblin_navigate: "Navigate one workspace tab to an http or https URL, bounded by the supplied timeout.",
  tabgoblin_back: "Navigate one workspace tab backward in its history, bounded by the supplied timeout.",
  tabgoblin_forward: "Navigate one workspace tab forward in its history, bounded by the supplied timeout.",
  tabgoblin_reload: "Reload one workspace tab, bounded by the supplied timeout.",
  tabgoblin_snapshot: "Return a fresh bounded accessibility snapshot with stable element references for one workspace tab.",
  tabgoblin_click: "Click a reference from a fresh snapshot in one workspace tab, bounded by the supplied timeout.",
  tabgoblin_fill: "Replace the value of a referenced editable element in one workspace tab, bounded by the supplied timeout.",
  tabgoblin_type: "Type text at a referenced element in one workspace tab, bounded by the supplied timeout.",
  tabgoblin_keypress: "Send one keypress to a referenced element in one workspace tab, bounded by the supplied timeout.",
  tabgoblin_select: "Select bounded option values at a referenced control in one workspace tab, bounded by the supplied timeout.",
  tabgoblin_hover: "Hover a reference from a fresh snapshot in one workspace tab, bounded by the supplied timeout.",
  tabgoblin_scroll: "Scroll one workspace tab by bounded horizontal and vertical pixel deltas.",
  tabgoblin_drag: "Drag from one fresh snapshot reference to another in one workspace tab, bounded by the supplied timeout.",
  tabgoblin_wait: "Wait for a load event or bounded text condition in one workspace tab, bounded by the supplied timeout.",
  tabgoblin_text: "Extract bounded visible text from one workspace tab for inspection.",
  tabgoblin_screenshot: "Capture a PNG screenshot of one workspace tab as tool-result image content; it is not stored in activity history.",
  tabgoblin_logs: "Return a bounded set of sanitized console log entries for one workspace tab.",
  tabgoblin_network: "Return bounded, redacted network metadata only: method, URL, and status. URLs are redacted; no request or response bodies, headers, or cookies are available.",
  tabgoblin_upload: "Upload one bounded workspace-relative file to a referenced file control in one workspace tab.",
  tabgoblin_evaluate: "Evaluate a bounded expression in one workspace tab and return a bounded serialized result.",
};

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: unknown;
}

export function buildToolDefinitions(): ToolDefinition[] {
  return TOOL_NAMES.map((name) => ({
    name,
    description: descriptions[name],
    inputSchema: z.toJSONSchema(ToolInputSchemas[name]),
  }));
}
