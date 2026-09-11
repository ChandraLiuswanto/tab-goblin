# TabGoblin Design

## Summary

TabGoblin is a public Paseo v0.8 plugin that lets Paseo agents operate server-side Playwright browsers through an agent skill and a machine-readable CLI. The Paseo daemon-side plugin owns browser processes, named persistent profiles, queues, and artifacts. A responsive Paseo workspace panel lets humans observe and control sessions without becoming a full embedded browser.

## Goals

- Give agents general browser actions: navigation, inspection, clicking, typing, extraction, screenshots, and downloads.
- Support individual CLI commands and batched JSON workflows.
- Store authenticated browser state in named persistent profiles.
- Support isolated sessions and intentionally shared sessions.
- Serialize independent controllers that target the same persistent profile.
- Run headless by default and offer an explicit visible debug mode.
- Provide a themed, mobile-compatible Paseo status panel.
- Publish the source as the public GitHub repository `ChandraLiuswanto/tab-goblin`.

## Non-goals

- Embedding a live browser viewport in Paseo.
- Providing a complete manual browser controller in the first release.
- Isolating named profiles from other trusted local Paseo agents.
- Exposing the browser service over LAN or the public internet.
- Automating website-specific workflows in the core plugin.
- Returning cookies, local storage, credentials, or sensitive headers to agents.

## Target and compatibility

TabGoblin targets the Paseo v0.8 beta plugin API and declares the appropriate `requirements.paseo` range in `paseo-plugin.json`. It uses separate client and server entry points. The README will state that Paseo v0.8 is beta and plugin contracts may change.

The plugin source lives at `~/paseo-plugins/tab-goblin`. Runtime profiles and artifacts live under the effective Paseo daemon home, outside the Git checkout.

## Architecture

### Paseo server plugin

The server entry starts and stops TabGoblin's localhost browser API with the plugin lifecycle. It owns Playwright browser processes, persistent profile directories, session metadata, profile queues, and artifact storage. Cleanup closes browsers, rejects or resolves queued work with structured shutdown errors, and releases locks.

### Local browser API

The API binds only to `127.0.0.1` on an available port. It requires a generated bearer token stored in a daemon-user-readable discovery file. That file contains the endpoint and token so the local CLI can discover the current plugin process after reloads. Files are created with restrictive permissions.

The API provides operations for session lifecycle, page lifecycle, browser actions, batch workflows, artifacts, health, and administrative status. Inputs and outputs use versioned JSON schemas. Responses have a consistent envelope containing success or error status, relevant session/page identifiers, current URL and title when available, result data or artifact paths, and a stable error code with retryability.

### CLI

The `tab-goblin` CLI discovers the plugin endpoint locally and emits JSON by default. It supports individual commands including:

- `session create`, `session status`, `session list`, and `session close`
- `open`
- `inspect`
- `click`
- `type`
- `extract`
- `screenshot`
- `download`
- `run <workflow.json>`

Human-readable output may be selected explicitly, but agent documentation always uses JSON. Selectors follow Playwright conventions and support role/text-oriented targeting. Commands require explicit session identifiers after session creation.

### Agent skill and scripts

The repository includes a TabGoblin skill that teaches agents to:

1. Confirm service health.
2. Create or join the intended session.
3. Inspect the current page before acting.
4. Prefer accessible role, label, and text selectors over fragile CSS.
5. Execute individual actions or a bounded JSON workflow.
6. inspect structured failures and retry only retryable errors.
7. Close sessions they created when work is complete.

Companion scripts provide health checks and representative workflows without duplicating browser logic. The plugin remains the sole owner of Playwright.

### Paseo frontend

A workspace panel registered by the client entry displays:

- named profiles;
- active and queued sessions;
- current URL and title;
- headless or visible mode;
- session owner metadata;
- queue position and elapsed time;
- recent screenshots and artifact paths;
- structured errors and browser health.

The panel supports refreshing status, stopping a session, opening a new visible debug session, and releasing a stale lock only after the server verifies it is stale. It opens artifacts through supported Paseo capabilities where available and otherwise copies or displays their path.

The panel uses React Native primitives, Paseo theme tokens, and compact layouts. It contains no browser runtime or Node imports. Client/server communication uses schema-validated plugin RPCs.

## Sessions and profiles

A named persistent profile maps to one Playwright user-data directory. Any trusted local Paseo agent with the profile name and local service credentials may request it. This is an explicit trust model, not profile-level authorization.

A session is either:

- **isolated:** a newly created controller with its own session identifier; or
- **shared:** multiple agents intentionally use the same session identifier and therefore the same pages and state.

Only one independently controlled session may hold a named profile at a time. Requests for that profile enter a FIFO queue. Queue requests have configurable deadlines and are removed on cancellation, client disconnect where detectable, or expiry. Shared access to an existing session bypasses profile acquisition because it uses the current controller.

Profiles persist until manually removed outside the first-release API. Closing a session closes its browser context and releases the profile to the next queued request without deleting profile data.

## Interaction flow

1. An agent runs `tab-goblin session create --profile <name>` with optional `--visible`.
2. The CLI reads the protected discovery file and authenticates to the localhost API.
3. The service acquires the profile or reports its queue state until acquisition or timeout.
4. The CLI returns a session identifier and initial page metadata.
5. Subsequent actions reference that session and a page identifier when necessary.
6. Screenshots and downloads are stored beneath a per-session artifact directory and returned as paths with metadata.
7. `tab-goblin session close` closes resources and releases the profile lock.

A JSON workflow declares a schema version, session options or an existing session, bounded ordered actions, and failure behavior. The server validates the whole workflow before execution. First release workflows execute sequentially and stop on the first failure unless an action explicitly permits continuation.

## Safety and trust

Paseo plugins are trusted, unsandboxed code. TabGoblin's backend can access the daemon machine with the daemon user's privileges. The documentation warns users to inspect the source and protect named profiles because they may contain authenticated sessions.

Controls include:

- localhost-only binding;
- generated bearer authentication and restrictive discovery-file permissions;
- no normal API for cookies, storage values, credential fields, or raw sensitive headers;
- redaction of authorization headers and form values in logs;
- navigation, action, workflow, and queue timeouts;
- limits on workflow action count, request size, extracted text, and response size;
- safe artifact filenames and containment beneath the configured artifact root;
- URL validation that allows normal public browsing but rejects non-HTTP browser navigation schemes by default;
- explicit visible-mode selection;
- graceful shutdown and stale-lock verification.

Because all local agents are trusted equally, TabGoblin does not claim to prevent one local agent from using another agent's named profile.

## Errors and recovery

Errors have stable codes, human-readable messages, optional details safe for agents, and a `retryable` boolean. Expected classes include invalid input, authentication failure, unknown session/page, profile busy or queue timeout, selector not found, action timeout, navigation failure, browser crash, artifact failure, and plugin shutdown.

On a browser crash, the service records a sanitized error, terminates remaining resources, releases the profile lock, preserves profile data, and returns a retryable browser-crash error. It does not silently replay mutating actions. Stale locks are removed only after confirming no live owning session or process exists.

## Persistence and configuration

Configuration covers profile root, artifact root, default headless mode, browser executable override, action timeout, navigation timeout, queue timeout, maximum workflow actions, extraction/response limits, and artifact retention. Defaults are safe and usable without configuration.

The authentication token and endpoint discovery data are runtime state, not committed configuration. Logs never include the token. Profile and artifact directories are ignored by Git.

## Testing and acceptance criteria

### Unit tests

- Schema validation and response envelopes.
- FIFO profile queue behavior, cancellation, expiry, and stale-lock checks.
- Session/page registries and lifecycle cleanup.
- Error classification and redaction.
- Path containment and request/response limits.

### Integration tests

A local fixture website verifies navigation, accessible selectors, clicking, typing, extraction, screenshots, downloads, multiple pages, and action timeouts without relying on external sites.

### Persistence and concurrency tests

- State written in a profile survives session closure and reopening.
- A second independent session for the same profile queues.
- Different profiles run concurrently.
- Agents sharing one session observe the same pages.
- Crash and shutdown paths release locks without deleting profile state.

### CLI tests

- Every individual command emits valid machine-readable JSON.
- JSON workflows are validated before execution and obey stop/continue behavior.
- Discovery, authentication, unavailable-service, and retryable errors have stable exit codes.

### Plugin and frontend tests

- Typecheck client/server import boundaries against Paseo v0.8.
- Verify plugin startup, reload, cleanup, and subprocess termination.
- Verify the workspace panel in wide and compact layouts and light/dark themes.
- Verify panel status, stop, stale-release, and visible-debug actions through RPCs.

### Release acceptance

The release is complete when:

1. `npm run typecheck` and all automated tests pass.
2. The installed plugin reports `running` in `paseo plugin ls`.
3. An agent using only the included skill can create a persistent session, navigate the fixture site, interact, extract text, capture a screenshot, close, reopen, and observe persisted state.
4. Concurrent requests serialize per profile while different profiles run concurrently.
5. The Paseo panel accurately displays and controls sessions on desktop and compact/mobile layouts.
6. No sensitive profile state or authentication token appears in normal output or logs.
7. The repository is published publicly as `ChandraLiuswanto/tab-goblin` only after implementation and verification are complete.
