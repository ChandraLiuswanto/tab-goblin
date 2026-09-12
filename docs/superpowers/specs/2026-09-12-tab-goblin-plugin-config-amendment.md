# TabGoblin plugin durable configuration amendment

## Approved server-owned configuration

TabGoblin configuration is owned by the plugin server, not Paseo host settings. It is stored in a dedicated app-owned directory with mode `0700` and a single regular JSON file with mode `0600`. The implementation must reject symbolic links, bound every string/list/map, serialize updates, write through a private same-directory temporary file and atomically rename it. Configuration is loaded before lifecycle hooks register and remains the single source of truth across plugin-process restart without a client connection.

Defaults fail closed. The only eligible provider is `claude`; an editable allowlist must not enable another provider. Durable state includes the workspace opt-in set, gateway/bridge settings, and agent/workspace lifecycle generations. A configuration change that changes the gateway socket retires the old client only after new requests can use the replacement.

The plugin RPC handler validates a requested workspace ID and CWD against `context.paseo.workspaces.list()`. Paseo 0.8 handler context has no invoking panel/workspace identity, so this is host-owned single-user validation, not per-panel authorization; the implementation must not claim otherwise.

## Credential and revocation requirements

Static `agent.create` MCP configuration contains only the bridge executable configuration and never an enrollment, bearer, socket path, or other scoped credential. Enrollment is created fresh at session opening and recorded with the authoritative workspace ID and durable workspace generation. Bind and session-open notifications include durable agent and workspace generations.

On workspace opt-out, workspace/agent archive, reset, reconfiguration, and all plugin cleanup, the plugin revokes affected gateway identities and advances/persists the corresponding durable generation. Cleanup is deliberately safe for both reload and disable because Paseo supplies no cleanup reason: it revokes authority but never stops the browser or deletes its profile. A fresh later session must reset and receive a new generation before it can enroll.

## Platform gate

Paseo 0.8 documents `agent.session_open.env` as a non-persisted provider launch override, but does not document that Claude Code propagates it to an MCP stdio child. Claude Code `2.1.267` is installed locally, but proving inheritance requires an isolated live Claude/MCP launch, which is outside the current no-live-service/config unit-work authorization. Therefore the credential injection path is a blocker until that provider behavior is established by an approved isolated test or an explicit provider contract. No implementation may place the credential back in persisted `mcpServers.env` as a workaround.

## Gateway transport requirements

The Unix-socket client bounds response **bytes** (not JavaScript string length) and uses an absolute wall-clock deadline independent of response activity. Transport failures return the existing structured `runtime_unavailable` response.
