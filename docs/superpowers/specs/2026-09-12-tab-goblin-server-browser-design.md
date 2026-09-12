# TabGoblin: persistent server browser over Tailscale

## Status and supersession

This is the proposed replacement for [the frontend-observer design](2026-09-11-tab-goblin-design.md). It reflects the subsequent user decisions: run the browser on Fedora, operate from Paseo web/mobile/desktop, support both agent automation and live manual interaction, persist website logins, use Tailscale, pause agent browser actions during manual control, and accept opening the live viewer in the device's browser when in-app embedding is unsupported.

The old implementation plan is not executable for this revision. Its native-browser-only, client-only, no-backend restrictions are explicitly superseded by this design. Approval applies to this document before a new implementation plan is written. No merge, push, publication, or host security-setting change is implied by spec approval.

## Goal

From a phone, web browser, or desktop, the user can direct an agent to use a persistent browser on their Fedora machine, watch the same browser live, take over to click/type/log in, and return control. The Fedora machine remains on and reachable through Tailscale; a connected Paseo Desktop browser host is not required.

### Release outcomes

- A responsive TabGoblin panel works through supported Paseo plugin APIs on web, desktop, and compact/mobile layouts.
- A touch-capable web viewer provides the actual live browser display and manual input on those devices. Opening it outside Paseo is a supported first-class path, not a failure.
- Agents use TabGoblin-specific MCP tools connected to the same browser session visible to the user.
- Server-enforced ownership prevents agent actions and manual input from interleaving during a manual-control session.
- Browser profiles survive process/container and Fedora restarts without putting credentials in source control.
- Remote control is private to the user's tailnet and additionally authenticated at the application layer.

## Options and chosen approach

1. **Rootless container browser plus TabGoblin gateway — recommended.** Chromium runs with a virtual graphical display on Fedora. Playwright automates it; a browser-based remote-desktop viewer displays the same session. A gateway owns authentication, workspace scope, activity and control arbitration. This meets phone-only operation without depending on Paseo's desktop browser host. Cost: a browser container and gateway must be installed and maintained.
2. **Native Fedora browser service.** The same architecture installed directly on Fedora avoids a container, but couples browser/display dependencies, updates, filesystem access and process cleanup to the host. Defer this second deployment mode.
3. **Paseo's built-in browser tools.** Smallest integration, but a connected desktop browser host is required and server-only operation is not supplied. This does not meet the revised goal and is rejected for this release.

Use rootless Podman as the Fedora deployment target. Supply an OCI container definition and user-service deployment instructions; do not require Docker, privileged containers, host networking, disabling SELinux, or mounting the user's entire home directory.

## System boundaries

### 1. Browser runtime

Each active workspace has its own persistent browser profile and isolated browser runtime/display, created on demand. Tabs in that workspace share its profile and logins. Different workspaces do not silently share profiles, tabs, viewers or credentials. This is operational separation for trusted users, not a security boundary against agents with unrestricted host shell access.

Use headed Chromium on a virtual display such as Xvfb, with a minimal window manager and a maintained remote-desktop transport. Playwright attaches to that same browser, not a second headless instance. The runtime container exposes no raw VNC, display or Chrome DevTools port to the tailnet or public network. Any internal browser-control endpoint is reachable only by the gateway over the private runtime transport.

A session start must produce a ready browser before reporting ready. Bounded startup/action/shutdown timeouts, idempotent stop, and clear startup failures are required. Stop releases compute and display processes but retains the profile. Starting it again retains login state where the website permits it; restoration of every open tab is not guaranteed. Never run two Chromium processes against the same profile directory. Profile-in-use failures must not delete lock files while a live owner exists.

Initial deployment targets one trusted owner and their agents, with independent workspace sessions. Arbitrarily named profile management, profile sharing/import, multi-tenant hosting and automatic session migration are out of scope.

### 2. Gateway and automation

A TabGoblin backend owns browser lifecycle, scoped identifiers, ownership state, native browser actions, viewer authorization and a bounded activity feed. It runs independently of the Paseo client and survives a client closing. The plugin server accesses it locally using authenticated, bounded requests. Agents access it through a dedicated stdio MCP bridge; the viewer accesses only its authenticated Tailscale HTTPS endpoints.

All browser automation and manual-input paths pass through gateway authorization and the same workspace ownership checks. Agent tools never receive the raw Playwright/CDP endpoint, profile path, runtime administrator credential or arbitrary workspace selector. Credentials bind the agent identity, selected Paseo host and workspace; an identifier in a request cannot override that scope.

Expose a distinct `tabgoblin_*` tool namespace. Do not impersonate or replace Paseo's `browser_*` tools and do not claim that TabGoblin sessions appear in Paseo's native tab inventory.

Required agent capabilities:

- Start/status a workspace session, list/open/close tabs, navigate/back/forward/reload.
- Read an accessibility-oriented snapshot with same-tab, revision-scoped element refs.
- Click, fill, type, keypress, select, hover, scroll and drag; wait for a bounded condition.
- Read bounded page text, capture a screenshot, and inspect bounded console/network diagnostics.
- Upload workspace-local files through a validated staging path.
- Perform bounded page evaluation only as a documented escape hatch, never as the default interaction method.

Every tool validates its input, scoped session/tab identity, current ownership generation and timeout. Page changes, manual takeover/return, browser restart and tab closure invalidate refs as appropriate. Unknown or stale identifiers fail safely; never silently select a different tab or workspace. Evaluation is subject to the same ownership gate even when described as read-only, because it can mutate a page.

Navigation accepts HTTP(S), not file/data/javascript schemes. Uploads must resolve inside the calling workspace, reject traversal and symlink escapes, and be copied into a controlled staging area rather than mounting the whole workspace into the browser. No general host-file picker, download manager or clipboard/file-transfer tunnel is exposed to the remote viewer in this release.

### 3. Paseo plugin

Use a client entry for the native panel and a server entry for plugin-specific RPC and lifecycle integration. Native components use React Native primitives, host theme tokens, accessibility labels and compact layouts. Host/workspace selectors establish context; requests never fall through to a different connected Paseo host.

Panel controls: start/stop workspace browser, open live viewer, refresh, Take control, Return to agent, and activity filters. Panel Take control directs the user to the authenticated viewer; ownership is acquired there so the gateway can identify the input session. Panel Return to agent is an authenticated workspace-scoped RPC which revokes the owning viewer's input before resuming automation. Stop warns that running browsing will end but logins are retained. Display session state, selected workspace, ownership state, live-view access guidance, last successful observation and safe errors. Refresh observes state only; it never repeats a failed browser action.

Use plugin-owned RPC polling for the panel's session state and recent activity. Poll only while mounted/active, use bounded intervals/backoff, and discard stale responses on host/workspace change or unmount. There is no dependency on owned agent-directory observation or connection-state methods missing from Paseo 0.8.0's borrowed SDK. A failed RPC is labeled **status unavailable / data may be stale**, not an authoritative claim that the entire Paseo host or browser is disconnected. A gateway-confirmed stopped/crashed state can be shown as such.

The server bridge uses verified public lifecycle/configuration hooks to register TabGoblin MCP configuration where supported, preserving unrelated configuration and requiring user opt-in. Where a provider cannot support this through public hooks, document explicit MCP setup and agent reload rather than using private APIs or hidden agents. Bind credentials using verified agent/workspace context; if that context cannot be established, fail closed. History-only sessions must not start browsers or receive interactive capabilities unnecessarily.

Use the gateway activity feed as the authoritative source for TabGoblin execution records. Timeline cards are optional presentation over verified TabGoblin tool payloads; unrelated, unknown or rich/image-bearing results retain native rendering. Screenshots remain available in their original tool result even when an activity summary is shown.

### 4. Live web viewer

Provide a responsive web page served by the gateway, using a maintained browser remote-desktop client such as noVNC. It displays the same virtual desktop/browser the agent controls and provides touch pointer input, keyboard entry, scrolling and appropriate viewport scaling. Include mobile-friendly access to the keyboard and Take control / Return to agent controls.

The external HTTPS viewer is the baseline on phone, desktop and web. The Paseo panel offers its trusted configured address and, where supported, an open/copy action. Selectable address text is an acceptable fallback if the installed plugin SDK lacks an opener/clipboard API. No token appears in this address. Embedding is a progressive enhancement only when supported public host APIs and browser security policies permit it; iframe/WebView support is not a release requirement.

Remote-desktop file transfer, host clipboard synchronization and unrestricted desktop access are disabled. The displayed desktop contains the workspace browser, not the Fedora user's ordinary desktop or terminal. Viewer sessions are workspace-scoped and initially view-only.

## Manual and agent control contract

The gateway maintains an ownership generation and states: **agent-ready**, **taking-control**, **manual**, **returning-control**, and **needs-attention**. Session stopped/starting/failed is tracked separately.

- In agent-ready, one agent command at a time may acquire the workspace execution lock. Concurrent agents receive a busy response rather than interleaving browser actions. There is no unbounded command queue.
- Selecting Take control immediately prevents new agent browser commands from starting. An in-flight command is allowed to reach a bounded safe completion before manual input is enabled. The UI shows taking-control during this transition; it must not claim instant cancellation of an already submitted action.
- If an in-flight command cannot be proven finished, transition to needs-attention, reject further automation and manual input, and offer an explicit session stop/restart with an uncertainty warning. Do not give simultaneous control or pretend a timed-out mutation was rolled back.
- In manual, only the owning authenticated viewer can send pointer/keyboard input. Other viewers remain view-only. TabGoblin agent browser commands fail promptly with a recognizable manual-control error; they are not silently queued. Agents may still perform unrelated coding work.
- The gateway enforces viewer input gating at the transport/session layer, not merely by hiding buttons or trusting the viewer's JavaScript. A forged WebSocket client cannot inject input without ownership. Raw display/control ports are inaccessible to it.
- Return to agent first disables and drains/rejects manual input under the same serialization boundary, advances the generation and invalidates cached refs. Only then is agent-ready published. An agent must obtain a fresh snapshot before further element actions.
- Closing the app, losing the viewer connection, timing out authentication or restarting the gateway never silently returns control to an agent. Manual ownership remains manual/needs-attention until the authenticated user explicitly resumes or stops it. Do not persist viewer bearer tokens to remember this state.
- A second authenticated device belonging to the trusted owner may explicitly reclaim manual control after confirmation; doing so revokes the previous viewer's input permission. It cannot silently become a second concurrent controller.

The pause guarantee applies to TabGoblin-mediated browser operations. It cannot stop a trusted agent deliberately using unrestricted shell access or unrelated automation services. Document that boundary plainly.

## Network access and authentication

Tailscale is the only supported remote access path. Bind the gateway's host listener to loopback and publish the viewer through Tailscale Serve HTTPS to the tailnet, subject to the user's ACLs/grants. No Tailscale Funnel, public listener, router port-forward, public ingress or automatic firewall weakening. Access from a phone requires that device's Tailscale connection.

Tailscale access alone is not a viewer credential. Pair a viewer using a short-lived, one-use code issued through the authenticated Paseo panel for the chosen workspace. Submit the code over HTTPS in a request body, exchange it for a bounded HttpOnly/Secure/SameSite session cookie, and never put it in a URL, access log or analytics event. Rate-limit pairing failures; expired or used codes fail. Viewer cookies authorize only the paired workspace and do not grant MCP or gateway administration access.

Validate WebSocket Origin and cookie authentication; enforce CSRF protection for state-changing HTTP actions and reject cross-origin requests by default. Pairing and view/control authorization remain required even for another tailnet device. Support explicit viewer sign-out/revocation. A gateway restart may invalidate viewer authentication and require re-pairing; website login persistence is separate.

Keep MCP/runtime credentials out of public viewer responses, repository files, generated screenshots, process arguments and normal logs. Use owner-readable credential files or scoped environment/IPC mechanisms suitable for the verified provider bridge. Rotate/revoke scoped bridge credentials on explicit disable or reconfiguration; never reveal a global secret through an agent tool result.

Installing dependencies, creating Podman services/volumes and enabling Tailscale Serve are explicit deployment steps. Existing tailscale routes, serve configuration and firewall policy must be inspected before proposing changes and never overwritten silently. If system changes need separate consent, implementation can produce scripts and tests without applying those changes.

## Persistence and privacy

Store Chromium profile data in a rootless, owner-restricted persistent Podman volume per workspace, with Fedora SELinux-compatible labeling. Container replacement and machine restarts reuse it. Keep service credentials separate from browser profiles. The volume contains sensitive cookies and login material; filesystem permissions are not encryption at rest. Recommend encrypted host storage and warn that backups contain authenticated session data.

Do not promise that every website stays logged in forever: sites may expire sessions, demand MFA or reject browser environments. Do not bypass CAPTCHA, MFA, access controls or anti-automation policies. Login happens interactively in the browser; no password-vault feature or import of the user's existing personal browser profile is included.

Store only safe session configuration and ownership safety state outside Chromium. Keep a maximum of 200 sanitized activity records per active workspace in memory, replacing streaming updates by stable operation identity. On restart, clearly label history as unavailable rather than reconstructing it from browser profile contents.

Activity records include operation ID, source agent, tab ID, safe action name, timestamps/status and structured recovery code. Display URLs stripped of userinfo, query and fragment; titles are bounded untrusted plain text. Do not persist typed/fill values, evaluation code/results, raw snapshots, console bodies, credentials, pairing codes or screenshots in TabGoblin logs/activity storage. The live viewer and original agent tool responses can expose authenticated page data by design; communicate this trust boundary.

Stopping a session, closing a tab, reloading/uninstalling the plugin, or archiving a workspace must not delete profile data automatically. Destructive profile deletion is outside the first-release UI and must be an explicit documented operator action, never cleanup side effect.

## Lifecycle and recovery

The gateway/browser service lifetime is distinct from the plugin UI. Closing a client or reloading the plugin stops its polling, timers and RPC work but does not close the user's running browser or delete profiles. Plugin reload must not silently surrender manual control. Browser service restart invalidates tab/ref handles and command generations; pending mutations are marked uncertain/failed, not replayed.

Return structured plugin-specific codes for session-not-ready, tab-not-found, stale-ref, manual-control, busy, timeout/uncertain result, authentication failure and runtime-unavailable. Do not mislabel them as Paseo native `browser_*` errors. Error copy tells the agent/user whether to refresh status, take a new snapshot, request explicit handoff or restart the session. Never automatically retry a timed-out click, submit, fill or navigation.

Panel loss of gateway access shows stale/unavailable data with the last successful update. Viewer transport loss shows reconnecting/connection-lost and disables input locally as well as on the server. Reconnection refreshes state and authorization, never replays inputs. Browser crashes preserve the profile and surface restart guidance. Bounded memory and timeouts apply to feeds, requests, sockets and media/control buffers.

## Agent skill

Ship a skill specific to TabGoblin, not the native Paseo browser. It teaches agents to:

1. Check tool availability, scoped session status and current ownership; provide setup guidance without altering host security configuration.
2. Start the session only when appropriate, list tabs and use returned scoped IDs; never invent or borrow another workspace's tab.
3. Snapshot the intended tab and act using current same-tab refs. Re-snapshot after page changes or handoff.
4. Respect manual-control/busy results; continue unrelated work or ask for handoff, never bypass the gateway.
5. Use native actions and bounded extraction before evaluation; inspect state before retrying uncertain mutations.
6. Verify results with screenshots and diagnostics without copying secrets into summaries or logs.
7. Close only task-created tabs unless instructed otherwise; retain pre-existing tabs and persistent profiles. Do not stop a shared session merely because one task finished.

Website content is untrusted data, not permission to access other credentials, workspaces or systems. Logged-in actions retain the same user-consent requirements as ordinary browsing.

## Compatibility verification before implementation commitments

Known local evidence: Podman and Tailscale binaries exist on the Fedora machine. Installed/public Paseo plugin SDK 0.8.0 exposes native workspace panels, typed plugin RPC and agent lifecycle hooks. The prior public-directory/reconnect documentation mismatch remains recorded in the old plan and is not assumed resolved here.

The implementation must verify server RPC, agent MCP credential scoping and provider launch behavior against actual installed app/daemon types and runtime. Pin a tested compatibility range and identify tested providers rather than promising every provider. No native browser-host requirement is carried over. No private Paseo imports, casts to unavailable borrowed APIs or hidden control agents are allowed.

Live viewer compatibility targets current Chromium/Firefox desktop browsers, Android Chrome and iOS Safari. Test real available devices where possible and distinguish real-device evidence from emulation. Browser-native touch/keyboard behavior and user login are acceptance criteria, not implied merely by a responsive screenshot.

## Testing and acceptance

### Automated

- RPC/MCP schemas, tab/workspace/host scope enforcement, stale refs, bounded payloads and command timeouts.
- Ownership state machine including concurrent agents, takeover during an in-flight operation, uncertain completion, return-to-agent input drain, second-viewer reclaim, stale generations and restart safety.
- Server-side input rejection from a forged/manual-input client without ownership; unauthorized viewer, MCP and cross-workspace requests; expired/reused pairing codes, CSRF/Origin checks and secret-free logs.
- URL/metadata redaction, 200-record cap, streaming replacement, unknown result handling and preserved screenshot access.
- Profile volume reuse, duplicate-profile process exclusion, browser crash recovery, plugin reload cleanup and session stop retaining profile data.
- Native panel states/actions on compact and wide layouts with light/dark theme tokens, accessible controls and unavailable-state honesty.
- Viewer touch/keyboard controls, view-only enforcement, transport reconnect and external-viewer fallback.
- Host/client/server import boundaries, typechecking and dependency/security review; no raw control ports or world-readable credentials in supplied deployment configuration.

### Live integration

Use a local fixture website with a reversible login/session cookie, labeled input, navigation and button actions. Do not use a real account merely to demonstrate persistence.

1. Deploy on Fedora with rootless Podman and SELinux enforcing; no privileged flags or disabled browser sandbox as an unexplained workaround.
2. Access the viewer privately over Tailscale HTTPS from another available device. Pair through Paseo; verify an unpaired device cannot control the browser and no public/raw control endpoint is exposed.
3. Run an agent using only the included skill/tools: open, navigate, snapshot, fill, click, extract, screenshot and close only its own tab. Observe the same page live.
4. Take manual control, log into the fixture and interact. Verify automated browser actions are blocked while unrelated agent work remains possible. Return control; verify a fresh snapshot is required and the agent sees manual changes.
5. Restart browser/container and gateway, then verify the fixture login persists while stale control/ref tokens fail and no unsafe automatic handoff occurs. Verify service configuration supports reboot persistence; claim actual reboot verification only if performed with consent.
6. Exercise multi-viewer contention, workspace separation, plugin reload and loss/recovery of viewer/gateway access. Use mocks for disruptive host/network failure paths and identify those separately.
7. Verify Paseo web/desktop/compact panel behavior and the external phone viewer path. Record which device/browser tests were live, emulated or unavailable; do not claim untested platforms passed.

Release requires passing automated checks, actual Fedora server-browser operation without a connected desktop browser host, enforced handoff and authentication, demonstrated fixture-login persistence, and documented compatibility/evidence. Missing prerequisites are reported as blockers, not replaced with unsafe networking or unsupported APIs.

## Explicit non-goals

Public internet hosting; Tailscale Funnel; arbitrary remote desktops; multi-user SaaS; guaranteed in-app browser embedding; audio/video conferencing or streaming-quality guarantees; anti-bot evasion; personal-profile import; password management; download management; arbitrary host file/clipboard transfer; native Paseo tab integration; custom JSON workflow engines; automatic merging, publishing or pushing.

## Self-review

- **Completeness:** goals, components, authenticated data flow, ownership transitions, persistence, deployment, recovery, skill and acceptance are specified without placeholders.
- **Consistency:** external viewing is the baseline; all clients observe the same server browser; no native desktop host or unavailable directory subscription is required. Persistent site logins are distinct from short-lived viewer/agent authorization.
- **Scope:** one vertical product consisting of runtime/gateway, scoped MCP bridge, plugin panel and viewer. Each is independently testable; the implementation plan must separate ownership and dependencies rather than combine them in one task. Deferred features are explicitly listed.
- **Ambiguity:** takeover blocks new commands before draining existing work; uncertainty fails closed; closing a phone never silently resumes agents; per-workspace profiles are retained; network changes require explicit deployment consent; platform test evidence is not overstated.
