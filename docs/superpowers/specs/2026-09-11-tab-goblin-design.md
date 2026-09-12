# TabGoblin Design

## Summary

TabGoblin is a frontend-first Paseo plugin that makes agent browser activity easier to follow. Agents use Paseo's existing `browser_*` MCP tools; Paseo owns browser hosting, tab routing, browser state, and action execution. TabGoblin provides a responsive workspace activity panel, readable browser-tool timeline cards, and an agent skill. It does not build a second browser automation service.

This revision replaces the original server-side Playwright, local API, and CLI architecture. Reusing Paseo deliberately changes the first-release scope: browsers require a connected Paseo desktop app, use Paseo's shared browser profile, and are addressed by workspace-scoped tab IDs rather than TabGoblin sessions.

## Goals

- Reuse existing Paseo browser tools for navigation, inspection, interaction, extraction, screenshots, and uploads.
- Focus implementation on themed, mobile-compatible frontend activity and error presentation.
- Teach agents the native tool workflow without introducing a competing CLI or workflow engine.
- Distinguish observed activity from live browser state and make unsupported capabilities explicit.
- Publish source as `ChandraLiuswanto/tab-goblin` only on the user's explicit publication instruction.

## Non-goals

- Owning Playwright, browser processes, browser profiles, locks, queues, or artifact storage.
- A custom localhost API, bearer token, discovery file, browser MCP server, or CLI.
- Headless daemon-only browsing, named persistent profiles, or isolated browser contexts.
- Embedding another browser viewport or replacing Paseo's native browser UI.
- A download manager or declarative JSON batch-workflow runtime.
- Guaranteeing exclusive control of a tab shared by agents or a human.
- Adding private Paseo API dependencies to obtain missing browser controls.

## Compatibility and verified capability boundary

Target the Paseo v0.8 plugin API. Set `requirements.paseo` to the actual tested release range, explicitly including beta versions when applicable. Validate both app and daemon compatibility; do not infer browser or plugin features from the version label alone.

References checked for this revision:

- [Browser architecture and prerequisites](https://paseo.sh/docs/browser.md)
- [Browser tools and errors](https://paseo.sh/docs/browser-tools.md)
- [Plugin reference](https://paseo.sh/docs/plugins/v0.8/reference.md)
- [SDK reference](https://paseo.sh/docs/sdk/reference.md)

Paseo documents these constraints:

- Browser tools and Paseo MCP tools must be enabled for the agent's host. Existing agents may need reloading.
- The daemon brokers operations to a connected desktop browser host; it does not run a browser itself.
- Tabs are workspace-scoped. Listing aggregates connected browser hosts, and tab actions route by `browserId`.
- Tabs share Paseo browser profile state, including logins. This is not named-profile isolation or a TabGoblin persistence guarantee.
- Element refs come from the latest snapshot of the same tab and expire when the page changes.
- Upload paths must be inside the agent's workspace.

The browser MCP tools available to agents are not automatically callable functions inside a plugin frontend. The documented plugin SDK does not establish a browser-control API equivalent to these tools. First release therefore uses supported agent timeline access for observation and leaves browser execution to agents and Paseo's native UI.

Before implementing the activity adapter, verify the installed SDK's timeline types and representative browser-tool payloads. If a provider omits structured browser results, show a generic activity card rather than inventing metadata. If supported timeline access cannot support the panel at all, report a compatibility blocker rather than adding a browser backend.

## Approaches and decision

1. **Frontend observer plus native MCP tools — selected.** Smallest implementation and no duplicated automation infrastructure. Direct panel browser controls and custom profiles are not promised.
2. **Thin adapter to a supported Paseo browser API — deferred.** Appropriate only if an actual public plugin-callable contract is verified. Tool names alone are not sufficient evidence.
3. **Independent Playwright backend — rejected for this release.** Would retain headless and custom-profile features but duplicate the machinery this revision aims to remove.

## Architecture

### Paseo-owned execution

The execution path remains:

`agent → Paseo MCP → daemon browser broker → connected desktop browser host → tab`

TabGoblin does not intercept, proxy, schedule, or replay these calls. Existing Paseo permission and workspace boundaries remain authoritative.

### Client-only plugin

Use `index.client.tsx`, `client/`, and pure shared contracts/helpers under `shared/`. No server entry is required for the selected first-release design. No Playwright dependency, Node imports in client code, extra connection, or standalone MCP client is introduced.

Register a workspace panel with `addWorkspacePanel` and a Command Center action that opens it. Use `usePaseo()` to borrow the selected host's connection and supported workspace/agent selectors to establish context.

A small activity adapter reads and subscribes to supported agent timelines for the selected workspace. It normalizes recognized native browser-tool calls into presentation records. Records are keyed by host, workspace, agent, and source timeline item identity, so streaming updates replace existing records rather than duplicate them. Handle timeline replacement, reconnect, workspace changes, and subscription cleanup according to the SDK contract.

Keep at most the latest 200 normalized activity records per active workspace in memory. Do not persist raw tool payloads or build an independent historical database. Unavailable or truncated history is labeled as such.

### Workspace panel

Display:

- observed browser actions, grouped or filterable by agent and tab when identifiers are available;
- action name, source agent, pending/completed/failed state, and available timing information;
- last observed URL/title and `browserId`, only when present in supported results;
- a compact action summary and recognized structured error with recovery guidance;
- setup guidance and explicit empty, loading, disconnected, unsupported-payload, and error states.

All metadata is labeled as observed activity, not an authoritative live tab inventory. A successfully observed close action may mark a tab closed; disappearance from a timeline does not. Lack of activity does not prove browser tools are disabled or no browser host is connected.

Panel actions are limited to refreshing available activity and filtering it. It must not display nonfunctional create-tab, close-tab, navigate, stale-lock-release, or debug-session buttons. Users control tabs in Paseo's native browser UI or ask an agent to use the existing tools.

Screenshots remain available through Paseo's original tool result. Inline previews or links may be added only when the public result and attachment APIs support them; otherwise retain the original timeline entry as the place to inspect the image. Never assume screenshots return daemon-local file paths.

Use React Native primitives, theme tokens for every text color, accessible labels, and compact layouts. Mobile can display the panel but does not itself satisfy the desktop browser-host requirement.

### Timeline cards

Use `addTimelineTransformer` for `tool_call` items and `addTimelineRenderer` for validated TabGoblin presentation records. Recognize exact browser-tool names and verified provider namespace forms, not arbitrary substring matches.

Transform only payload shapes the adapter understands. Leave unrelated or unsupported items unchanged. Preserve original rendering for image-bearing or otherwise rich results that cannot be represented without losing access to their content. Transformers are synchronous, deterministic, and side-effect-free; panel subscriptions are separate from rendering.

### Optional backend rule

A server entry is permitted in a future approved revision only for a concrete plugin-specific requirement that cannot run client-side. Any adapter must use a verified public API and preserve host/workspace scoping. Missing browser APIs are not permission to recreate Playwright, expose a new local service, scrape private app state, or drive a hidden agent as a control proxy.

## Native capability mapping

| Need | Existing Paseo tools / first-release treatment |
| --- | --- |
| List, open, close tabs | `browser_list_tabs`, `browser_new_tab`, `browser_close_tab` |
| Navigate and history | `browser_navigate`, `browser_back`, `browser_forward`, `browser_reload` |
| Inspect and wait | `browser_snapshot`, `browser_wait` |
| Click and enter text | `browser_click`, `browser_fill`, `browser_type`, `browser_keypress` |
| Other interaction | `browser_hover`, `browser_select`, `browser_drag`, `browser_scroll` |
| Extract page information | Snapshot first; bounded `browser_evaluate` when necessary |
| Visual verification | `browser_screenshot`, `browser_resize` |
| Debugging | `browser_logs` |
| Upload files | `browser_upload`, subject to workspace-path restrictions |
| Download management | No documented dedicated browser download tool; out of scope |
| Batch workflows | Agent executes ordinary ordered MCP calls; no new workflow interpreter |
| Named profiles / headless sessions | Not supplied by the documented native tools; out of scope |

## Agent skill and interaction flow

The repository includes a skill that teaches agents to:

1. Verify browser tools are available. Explain setup or no-host failures without changing host configuration automatically.
2. Call `browser_list_tabs` before reusing a tab, or `browser_new_tab` to create one. Use the returned `browserId`, never an invented identifier.
3. Snapshot the intended tab and act using refs from that tab's latest snapshot.
4. Re-snapshot after page changes or `browser_stale_ref`; do not blindly repeat a mutating action after an uncertain result.
5. Prefer accessibility snapshots and native actions over page evaluation. Use evaluation only when needed for bounded page inspection or extraction.
6. Capture screenshots and logs through Paseo when verifying a result.
7. Close only tabs the agent created for the task, unless the user asks to retain them. Do not close pre-existing user or other-agent tabs without permission.

Sequential tool calls replace CLI workflows. Shared tabs can be modified by another agent or the human between actions; there is no exclusive session lock. Use separate tabs where appropriate, while documenting that separate tabs still share profile state.

## Safety and privacy

Paseo plugins are trusted code, and browser tools can operate authenticated pages. Users must enable these capabilities only for agents and plugins they trust.

TabGoblin introduces no new credentials or transport. It does not read profile directories or deliberately extract cookies, storage values, credentials, or authorization headers. It cannot claim the underlying tools prevent all sensitive access: evaluation, screenshots, and page content may expose authenticated data.

Activity cards use an allowlist of metadata. Do not copy typed/fill values, arbitrary evaluation source/results, raw snapshots, or console payloads into summaries or logs. Display URLs with userinfo, query, and fragment removed. Render page titles as untrusted plain text, and avoid logging them. Retain original sensitive content only where Paseo already renders it; TabGoblin does not create an additional persistent copy.

Use native HTTP(S) navigation and workspace upload restrictions. Do not claim stronger isolation than Paseo supplies. Switching hosts must not fall through to another connected host.

## Errors and recovery

Preserve recognized native codes rather than replacing them with a new automation error taxonomy:

- `browser_disabled`: explain enabling Browser tools and Paseo tools, with user consent.
- `browser_no_host`: explain that a connected desktop browser host is required.
- `browser_stale_ref`: instruct the agent to take a fresh snapshot.
- `browser_timeout`: show failure and recommend inspecting current state before another action.
- `browser_denied`: show the denial without attempting a bypass.

Unknown failures receive a safe generic summary while the original timeline result remains available. Panel read/subscription errors have their own UI state and must not be reported as browser execution failures. Reconnecting refreshes observation only; it never replays browser actions. Plugin unload removes subscriptions and registrations but does not close Paseo-owned tabs.

## Testing and acceptance criteria

### Unit and contract tests

- Normalize representative supported browser-tool timeline payloads, including streaming completion, failure, and unknown shapes.
- Verify exact tool recognition, safe fallback, metadata redaction, URL sanitization, and rich-result preservation.
- Verify stable identity, duplicate prevention, timeline replacement, record limits, workspace/host isolation, and subscription cleanup.
- Verify no activity is mislabeled as a live tab inventory or definitive browser health check.

### Frontend tests

- Panel loading, empty, activity, disconnected, failure, and unsupported-data states.
- Refresh and agent/tab filters, including missing tab metadata.
- Wide and compact layouts, accessible controls, and light/dark theme colors.
- Timeline cards update without duplicate entries or losing original screenshot access.
- Import boundaries and typechecking against the tested Paseo plugin SDK.

### Integration verification

Use a local fixture website and a connected Paseo desktop browser host. An agent following only the included skill must list/create a tab, navigate, snapshot, click, fill, extract page text, capture a screenshot, and close its own tab using native MCP tools. Verify the panel reflects supported observed activity.

Exercise stale refs, a missing browser host, host disconnect/reconnect, plugin reload, and unknown provider payloads. Verify cleanup does not close native tabs and unsupported data does not crash the UI. Use mocks for failure paths unsafe or impractical to induce in the active development host.

### Release acceptance

1. Typechecking and automated tests pass.
2. The installed client plugin is running without a required TabGoblin server entry or browser subprocess.
3. Agent browser actions use existing Paseo MCP tools, with no custom browser API, CLI, or automation runtime.
4. Panel and timeline presentation work for the documented tested provider payloads; unsupported shapes preserve native rendering.
5. The panel behaves correctly on desktop and compact/mobile layouts, including its desktop-host prerequisite messaging.
6. Documentation explicitly states shared profile behavior and excludes headless execution, named profiles, guaranteed download handling, and direct panel browser controls.
7. No raw form values, credentials, or browser payloads are added to TabGoblin logs or persistent storage.
8. Publishing or pushing the public repository requires the user's explicit command after implementation and verification.
