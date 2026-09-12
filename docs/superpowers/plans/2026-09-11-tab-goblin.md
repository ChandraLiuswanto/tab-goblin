# TabGoblin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development through Paseo. Work is claimed using `bd ready --claim --json`; run `bd prime` first. Each bead is committed independently and closed only after spec-compliance and code-quality reviews.

**Spec:** [Approved design](../specs/2026-09-11-tab-goblin-design.md)

**Goal:** Deliver the approved frontend-only browser activity observer and native-browser agent skill.

**Architecture:** Pure allowlisted normalization feeds a bounded per-panel observation store. A client controller borrows the host SDK connection; native themed views and synchronous timeline registration consume presentation records, never execute browser actions.

**Tech Stack:** TypeScript, React 19.1, React Native 0.81.5, Zod 4, Paseo plugin 0.8.0, Vitest and React Test Renderer.

## Compatibility blocker — execution paused

Follow-up inspection confirmed the installed and published Paseo 0.8.0 SDK does not implement several newer documented contracts assumed below. The borrowed PaseoApi has no public connection-state access, directory subscriptions have no independent release, and timeline subscriptions lack the newer reconnect snapshot/error contract and `.release()`. Installed runtime files match published SDK files. Do not execute the observation/controller steps below until the target host exposes verified public contracts or the user approves reduced observation semantics. Updating plugin dependencies alone cannot fix the borrowed host object. No implementation beads have been dispatched.

A supported reduced scope could poll unsubscribed directory reads, explicitly label connection state unavailable and stale data, and use only verified 0.8.0 timeline behavior. That requires revising the approved spec and this plan; do not silently substitute it. Live acceptance additionally requires a connected desktop browser host, currently absent.

## Global constraints and initially inspected contracts

The linked spec is normative, particularly Compatibility, Safety and privacy, and Release acceptance. No server entry, private browser APIs, browser runtime, persistent activity, extra SDK connection, automatic host configuration changes, or push. Public docs: https://paseo.sh/docs/plugins/v0.8/reference.md, https://paseo.sh/docs/sdk/events.md and https://paseo.sh/docs/browser-tools.md.

Probe created with installed `paseo plugin init` in `/tmp/tab-goblin-sdk-probe`; it pins `@getpaseo/plugin` to `0.8.0`. Installed daemon reports 0.8.0; verify running app separately before asserting tested compatibility. Narrow manifest floor/range to the releases actually verified. SDK inspection:

- `@getpaseo/protocol/agent-types` exposes `ToolCallTimelineItem`: `{type:'tool_call', callId, name, detail, status, error}`; status includes running/completed/failed/canceled. `detail.type === 'unknown'` has `input` and `output`; other detail variants must not be guessed into browser payloads.
- `@getpaseo/plugin/client`: `addWorkspacePanel`, `addCommandCenterItem`, `addTimelineTransformer({query:{itemType:'tool_call'}, transform({item,phase})})`, `addTimelineRenderer({kind,version,schema,Component})`, `usePaseo`, required-selector `useWorkspace`; host and workspace IDs are panel props. Every registration returns cleanup.
- Borrow `usePaseo()`; never call `createPaseoClient`, connect, or close. Use public connection state/observation API only (verify installed declaration before implementation).
- `agents.list({scope, subscribe:{}})` provides owned `subscription.subscribe({snapshot,update,error})` and `release()`. Select workspace scope using installed SDK types, and defensively reject other workspace entries. Snapshot precedes updates and refreshes on reconnect.
- `agents.ref(id).timeline.subscribe(callback)` returns an unsubscribe with `.ready` and `.release()`. Initial history is separate. Await readiness then `refetch({direction:'before',limit:200,projection:'projected'})`. Buffer live updates across that read. A reconnect `snapshot` replaces history; `replacement` invalidates epoch and triggers refetch; error ends observation and needs explicit retry. Pages include epoch, entries with seqStart/seqEnd/item, and paging flags. Read the public events contract before coding; never append reconnect snapshots blindly.
- Tool names and result envelopes need provider evidence. Support exact native names and proven prefixes only; preserve native rendering for other shapes. Research findings must be recorded in the contract document, with synthetic rather than real sensitive payload fixtures.

## File ownership / dependency graph

| Task | Sole-owned paths | Depends on |
|---|---|---|
| A: safe core + tooling | package.json, package-lock.json, tsconfig.json, vitest.config.ts, .gitignore, shared/**, tests/core/**, docs/contracts.md | none |
| B: skill + public documentation + fixture | README.md, skills/tab-goblin/SKILL.md, tests/fixture/**, tests/docs/** | none |
| C: observation lifecycle | client/activity-controller.ts, client/use-activity.ts, tests/controller/** | A |
| D: native UI + registration | index.client.tsx, paseo-plugin.json, client/panel.tsx, client/activity-card.tsx, client/timeline.tsx, tests/ui/** | A |
| E: end-to-end verification + release evidence | tests/integration/**, docs/verification.md | B,C,D |

C and D remain parallel: their interface below is fixed. D may use a test mock of the controller hook until C lands; D's narrow tests must not import the incomplete hook implementation. A and B are independent initial heads. No worker writes another task's files. Any necessary later change becomes a fix bead with explicit ownership/dependencies. Workers stage explicit paths only and never fetch/pull/rebase/push.

## Shared interfaces

Task A defines these in `shared/activity.ts` (Zod schema exported as `activitySchema`; infer record type rather than duplicate schema/types):

```ts
type ActivityContext = { hostId: string; workspaceId: string; agentId: string };
type Activity = ActivityContext & {
  id: string; sourceId: string; action: string;
  status: 'pending' | 'completed' | 'failed' | 'canceled';
  browserId?: string; url?: string; title?: string;
  timestamp?: string; durationMs?: number;
  errorCode?: string; guidance?: string;
  unsupported: boolean; closed?: boolean;
};
type Normalized = { activity: Activity; transformable: boolean } | undefined;
function normalizeActivity(item: unknown, context: ActivityContext): Normalized;
function sanitizeUrl(value: unknown): string | undefined;
```

Export `TRANSFORM_CONTEXT = {hostId:'tab-goblin:transform', workspaceId:'tab-goblin:transform', agentId:'tab-goblin:transform'} as const`; it is a nonempty schema-valid sentinel reserved for transformer presentation only. Task A tests that normalizeActivity with this sentinel passes activitySchema. Task D uses exactly this constant, never inserts its records into the panel store, and renders the actual agent from renderer props.

Identity uses tuple-safe encoding of host/workspace/agent/callId, never display name or arrival order. Validate context and source identity. Only actual native code matches go in errorCode; unknown errors become generic failure text without copying error messages. Timestamp/duration only from evidenced supported fields, finite and nonnegative. Missing metadata remains absent. C may define its own chronological ordering metadata outside the display record.

Task A exports `ActivityStore` in `shared/activity-store.ts`: constructor(context without agentId, limit=200), `upsert(record)`, `replaceAgent(agentId, records)`, `removeAgent(agentId)`, `clear()`, `records(): readonly Activity[]`. Enforce host/workspace scope in every mutation. Replacement removes old records only for that agent; retain newest 200 globally with deterministic tie breaking and streaming replacement. No raw inputs/outputs retained.

C exports from `client/use-activity.ts`:

```ts
type ActivityView = {
  state: 'loading' | 'ready' | 'disconnected' | 'error';
  records: readonly Activity[];
  historyLimited: boolean;
  refresh(): void;
};
function useActivity(hostId: string, workspaceId: string): ActivityView;
```

C's controller accepts injected public `PaseoApi`, scope IDs and a callback and returns `{refresh():void, dispose():void}`. Internal raw timeline buffers are temporary, bounded and immediately normalized; cleanup drops them. UI does not know SDK event shapes. Missing public observation support produces a safe compatibility/error state, not invented browser health.

## Task A: safe core and runnable toolchain

**References:** spec Architecture / Timeline cards / Safety / Unit and contract tests.

- [ ] Copy only appropriate client scaffold settings from the SDK probe. Add pinned Paseo 0.8.0, React/React Native peer dev tooling, Zod, TypeScript, Vitest, react-test-renderer matching React and its types; direct public `@getpaseo/client`/protocol dependencies if imported. Scripts: `test` = `vitest run`, `typecheck` = `tsc --noEmit`. Set Vitest include explicitly to `tests/{core,controller,ui,integration}/**/*.test.{ts,tsx}` so the separately run node:test suites in tests/docs and tests/fixture are not collected. Use native component mocks only in UI tests, not runtime. Ignore node_modules, coverage, build and local bead data. Install dependencies without lifecycle scripts initially; commit lockfile.
- [ ] Write red contract tests with synthetic SDK-shaped fixtures, for example:

```ts
const ctx = {hostId:'host-a', workspaceId:'ws-a', agentId:'agent-a'};
const item = {type:'tool_call', callId:'call-a', name:'browser_fill',
  status:'completed', error:null,
  detail:{type:'unknown',input:{browserId:'tab-a',value:'SECRET'},output:{}}};
expect(JSON.stringify(normalizeActivity(item, ctx))).not.toContain('SECRET');
expect(sanitizeUrl('https://u:p@example.com/a?q=SECRET#token')).toBe('https://example.com/a');
expect(normalizeActivity({...item,name:'not_browser_fill'},ctx)).toBeUndefined();
```

Run `npx vitest run tests/core` and record expected missing-module failure before implementation.
- [ ] Implement exact recognition for the tools enumerated by browser-tools docs; add only evidenced provider namespace forms. Support evidenced structured output envelopes, with bounded parsing and no arbitrary recursive traversal. Metadata comes from allowlisted result fields (not invented from requested navigation). Preserve native rendering for screenshots/images/resource attachments and all unsupported/opaque output; panel may still show a generic recognized action. Do not interpret arbitrary evaluation/log/snapshot content as browser metadata. Do not stringify raw values to produce summaries. Zod validates presentation data; constrain lengths, finite timing values, safe URL schemes and unknown codes. Render cancellation honestly, not success. Mark close only when completed.
- [ ] Cover pending→complete replacement, failed recognized codes (all five spec codes), unknown failures, unsupported objects/strings, exact namespace matching, malformed URL, userinfo/query/fragment stripping, malicious title as text, rich payloads and unknown details. Add fixtures only for provenance-documented shapes. Avoid runtime Node imports.
- [ ] Test store tuple collision resistance, cross-host/workspace rejection, per-agent replacement, removal, clear, >200 trimming and duplicate updates. Implement minimal store and rerun `npx vitest run tests/core` plus `npm run typecheck` for available modules.
- [ ] Write `docs/contracts.md` with exact SDK paths/version, supported provider envelopes, synthetic examples, rejected shapes, rich-rendering preservation policy and evidence limitations. Record no blanket support for untested providers.
- [ ] Commit only owned paths after tests pass. Request spec then quality review before close.

## Task B: skill, docs and local integration fixture

**References:** spec Agent skill / Compatibility / Native capability mapping / Integration verification / Release acceptance.

- [ ] Read writing-skills skill before authoring `skills/tab-goblin/SKILL.md`. Write a native-tool-only skill with the seven interaction steps in the spec, latest same-tab refs, shared-profile warning, permission boundaries, uncertainty-before-retry recovery, workspace uploads, safe HTTP(S), bounded evaluation and task-owned-tab cleanup. No invented browser API or host-health inference from empty lists. Include exact error-code guidance.
- [ ] First write `tests/docs/skill.test.mjs` using node:test; assert no tab-goblin CLI/Playwright instructions and required tool lifecycle/recovery/privacy guidance. Run `node --test tests/docs/*.test.mjs` to see failure for missing skill, then implement and pass. This is executable without Task A's package install.
- [ ] Write README installation using verified `paseo plugin` CLI help, client-only architecture, native desktop prerequisites, consented enabling instructions, tested compatibility caveat pending verification, refresh/filter-only panel semantics, no authoritative tab inventory, shared profile/privacy limits, mobile prerequisites, no named profiles/headless/download guarantee, testing commands and explicit no-publish-without-command policy. Reference contracts and verification documents by intended final paths; no claims that future tests already passed.
- [ ] Add `tests/fixture/index.html` with accessible heading, labeled input, button that reveals a deterministic message, and link to a second in-page view. No external resources. Add `tests/fixture/serve.mjs` as a loopback-only Node HTTP fixture server, static known paths only, configurable port and graceful shutdown; this is test-only, not plugin runtime. Add node:test checks for fixture behavior/content and traversal rejection. Example expected DOM: input label `Name`, button `Greet`, output `Hello, Goblin!` after filling Goblin.
- [ ] Run `node --test tests/docs/*.test.mjs`, commit owned files only, obtain spec then quality review.

## Task C: scoped observation lifecycle

**References:** spec Activity adapter / Errors and recovery / Unit and contract tests; public SDK events and installed types.

- [ ] Write failing SDK-fake tests for initial subscription acknowledgement and refetch, live update arriving during read, newer update winning stale read, replacement with new epoch while fetch is pending, reconnect snapshot, directory add/remove, host/workspace switch during outstanding promises, history flags, 200 limit, cleanup before setup completes, failed setup, retry after stream error and disconnected status. Fake the public SDK surfaces, never private app internals.
- [ ] Implement controller borrowing injected public PaseoApi, owned workspace-scoped directory observation, per-agent timeline subscriptions and initial reads. Use generation/epoch checks for all asynchronous completions; normalize before retaining records. Buffer only necessary browser records during fetch with a bounded cap; overflow triggers safe fresh observation or limited-history labeling. Do not fabricate order/timing metadata. Defensive scope check each directory entry.
- [ ] Ensure directory snapshots reconcile membership and release removed agents; release late setup resources after disposal. Empty directory is ready/empty, not disabled browser. Observation read/subscription failures produce generic panel errors without leaking thrown messages. Use documented SDK connection state/events to show disconnected; if unavailable, explicitly document and display compatibility failure, not guessed live health.
- [ ] Refresh restarts failed observations safely and reads supported history only. It never executes/replays browser tools. Unload cleanup calls subscription release/unsubscribe but never closes borrowed SDK connection or any tabs.
- [ ] Implement useActivity using usePaseo and effect cleanup; scope IDs and API identity are dependencies. Avoid a render-frame leak of old host records when props change. Export ActivityView exactly as above.
- [ ] Run `npx vitest run tests/controller tests/core` and typecheck (coordinating incomplete parallel D imports without weakening config); commit only owned paths; request both review stages.

## Task D: native panel, timeline renderer and registration

**References:** spec Workspace panel / Timeline cards / Frontend tests.

- [ ] Add failing UI tests mocking only React Native and useActivity. Cover loading, empty, disconnected, observation error, generic unsupported data, activity, limited history, refresh button and agent/tab filters with absent browserId. Include compact/wide, light/dark theme props and accessible control labels. Tests assert no create/close/navigate/debug/lock buttons.
- [ ] Implement panel using View/Text/Pressable/ScrollView and host theme color/spacing tokens. Use useWorkspace(workspaceId, selector) for context without whole-state selection. Agent IDs provide source identity even if no safe display name exists. Filter records by available agent and browserId, including an explicit missing-tab option. All text uses theme colors, titles remain plain Text, URLs are already sanitized, never HTML or link execution. Explain that data is observed activity and native UI/agents own controls. Include setup and desktop-host messaging in empty/disconnected states without treating inactivity as disabled.
- [ ] Implement ActivityCard reused for panel and timeline. Display safe action label/status/source and optional known metadata/timing, closed observation marker, structured recovery guidance, and source-timeline explanation for rich/unsupported payloads. Do not expose secrets from unvalidated props.
- [ ] Implement synchronous `client/timeline.tsx` normalization and transform; no hooks/SDK actions in transformer. Because transform input has no host/workspace/agent, use presentation-only neutral context for pure normalization and do not insert transformer output into panel store; actual agent comes from renderer props. Return undefined for unrelated/unsupported/rich items. Validate via activitySchema; renderer version 1 and stable kind `browser-activity`. Preserve screenshot native rendering even if status/metadata were parseable.
- [ ] Register workspace panel `activity`, workspace Command Center action opening it, transformer and renderer in `index.client.tsx`; return combined cleanup in reverse order. Use installed plugin entry/export convention. Manifest declares client-only runtime, narrow tested Paseo compatibility; no server file. Cover registration/unload with mocked context, including no browser calls/close.
- [ ] Run `npx vitest run tests/ui tests/core`; after C exists run full `npm run typecheck`. Commit owned paths and obtain both review stages.

## Task E: integration and release verification

**References:** every Testing and acceptance criterion and release criterion in the spec.

- [ ] Add integration harness tests combining normalizer, controller and registrations with synthetic SDK events. Verify running→complete only one card, failed codes, reconnect history replacement, unknown provider preserving native row, image preservation, 200 bounds, mobile panel props and unload without closing tabs. Start with failing assertions, implement harness, pass.
- [ ] Run `npm test`, `node --test tests/docs/*.test.mjs`, `npm run typecheck`, import-boundary checks for client/shared and `paseo plugin validate` if offered by installed CLI. Verify no Node/browser/Playwright imports, server entry, persistent payload storage or custom automation endpoint in runtime sources. Test fixture server is explicitly outside runtime.
- [ ] Inspect installed CLI for local plugin install/enable/reload/status commands. Install this local plugin for acceptance testing without editing host browser settings or publishing. Verify both daemon and app version/capability, actual running client-only status and frontend error logs. If no attached compatible app/browser host exists, report a concrete blocker rather than claim acceptance.
- [ ] Start loopback fixture in managed terminal. Dispatch a fresh Paseo agent following only included skill to list/create/navigate/snapshot/click/fill/extract/screenshot/close its own tab with native tools; preserve pre-existing tabs. Agent must report browser IDs and observed outcome, never raw secrets. Verify actual panel reflects supported activity, UI labels/filter/refresh and compact layout. No production form submissions. Inspect original screenshot result access.
- [ ] Use safe mocks for stale refs, no-host, denial, unknown payload, host disconnect/reconnect, refresh errors and reload teardown where disrupting the active host is unsafe. Clearly distinguish mocked from live evidence. Verify reload removes observations and does not close native tabs. Stop fixture resources on completion.
- [ ] Write `docs/verification.md` listing commands/results, actual app/daemon/SDK/provider versions, supported fixture provenance, live versus mock coverage, screenshots/status evidence references and any outstanding acceptance blocker. Do not claim a browser session alone proves panel integration.
- [ ] Commit test/evidence paths, then spec-compliance and code-quality review. Findings affecting another owner's files become fix beads, not silent cross-task edits.

## Review and finish orchestration

After all beads pass their two-stage review, run one fresh implementation reviewer against the approved spec. Critical/Important findings become fix beads, reviewed and then re-reviewed globally; stop if a finding survives two fix rounds. After clean global review, dispatch exactly one fresh high-reasoning Fable reviewer (or strongest discovered suitable model); route important findings through reviewed fix beads without a second Fable pass. Run full verification again. Use finishing-a-development-branch to present integration options and wait. Do not merge, squash, fetch, pull, rebase, publish or push during autopilot.

## Plan self-review

Coverage: A covers privacy, contracts, identity, rich fallback and bounds; B covers native interaction and documented limits; C covers observation, isolation and cleanup; D covers native UI/cards and plugin registration; E covers runtime verification and release evidence. Shared types have one owner; C/D consume the fixed ActivityView interface and are parallel. Initial A/B are disjoint. The plan distinguishes supported SDK observation from nonexistent plugin browser controls and distinguishes test-only Node fixture code from runtime client code.
