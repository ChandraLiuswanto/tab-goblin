# Tab Goblin Tailscale viewer origin

## Intent

Use `https://fedora.saga-skink.ts.net` for this installation's user-facing Tab Goblin viewer links, including access from other tailnet devices. The user confirmed that internal browser connections must remain private on loopback.

## Approach

Use the existing gateway viewer-origin setting and plugin Viewer URL configuration, with private Tailscale Serve terminating HTTPS and proxying to the loopback viewer server. Prefer deployment configuration over changing application defaults or hardcoding this machine's hostname into portable source.

Alternatives rejected: globally replacing loopback addresses would expose or break internal connections; direct TLS and tailnet-interface binding would duplicate Tailscale Serve's existing function.

## Requirements

1. Configure this installation's gateway advertised/allowed viewer origin as `https://fedora.saga-skink.ts.net` and the plugin Viewer URL to the same origin.
2. Enable private Tailscale Serve HTTPS on port 443 forwarding to `http://127.0.0.1:8931`. Spec approval authorizes this specific deployment change and the necessary gateway restart, not Funnel, firewall changes, or unrelated service changes.
3. Keep gateway listening, Chromium/CDP, VNC, container port publishing, and local IPC private as currently designed. Preserve pairing, authentication, and origin validation.
4. Inspect and record existing configuration before modifying it. Current read-only discovery reports DNS `fedora.saga-skink.ts.net.` and no Serve configuration. If a conflicting route appears, do not overwrite it silently.
5. Preserve existing uncommitted edits in gateway browser/runtime source and tests and the untracked local installer. Do not bundle unrelated changes into commits.
6. Keep deployment instructions reproducible and machine-specific values out of portable application defaults. Make source changes only if existing configuration cannot meet these requirements.

## Success criteria

- Gateway and plugin configuration agree on the exact HTTPS origin, without a trailing slash.
- Private Serve forwards the HTTPS viewer to the existing loopback listener; internal browser ports remain loopback-only.
- Generated viewer links use the Tailscale hostname, and HTTPS serves the viewer with authentication/origin protections intact.
- Relevant automated tests pass for any changed source or deployment logic.
- Report live checks separately from remote-device checks; do not claim phone/tailnet-client validation unless actually performed.

## Failure handling and boundaries

Record prior settings and provide rollback instructions. Missing Tailscale permissions, HTTPS provisioning, inaccessible plugin settings, or conflicting live routes are deployment blockers to report rather than reasons to weaken security. Do not reset user profiles, cookies, pairing state, or unrelated settings. Do not merge or push without the user's integration choice.

## Self-review

Checked scope, configuration alignment, exposure boundaries, existing-work preservation, deployment authorization, testability, and rollback. No new browser transport or DNS discovery feature is required.
