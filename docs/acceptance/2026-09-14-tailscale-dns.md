# TabGoblin private Tailscale viewer deployment — 2026-09-14

## Disposition

PASS for host-local deployment acceptance. This installation now advertises and allows the exact credential-free origin `https://fedora.saga-skink.ts.net`; the TabGoblin plugin uses the same Viewer URL; and private Tailscale Serve terminates HTTPS 443 and proxies only to `http://127.0.0.1:8931`.

This evidence does **not** claim validation from a second tailnet device or persistence across a host reboot. Neither check was performed.

## Scope and prior state

Before mutation:

- `tabgoblin-gateway.service` was active and the loopback viewer returned HTTP 200 on `127.0.0.1:8931`.
- The effective service environment did not contain `TABGOBLIN_VIEWER_ORIGIN`.
- The dedicated drop-in did not exist. This absence was recorded as the expected failing desired-state check.
- The plugin Viewer URL was empty. Its gateway socket was `/run/user/1000/tabgoblin/gateway.sock` and was preserved unchanged.
- `tailscale serve status --json` returned `{}`. It was checked again immediately before configuration, so no conflicting route was overwritten.
- Tailscale reported this node's DNS name as `fedora.saga-skink.ts.net.`; the configured HTTPS origin removes the trailing dot.

A private rollback snapshot was written to:

`/home/chandraliuswanto/.local/state/tabgoblin/deployment-backups/20260914T041752Z-tailscale-dns`

The directory mode is `0700`; its four files are mode `0600`. The snapshot contains only the prior Serve state, prior plugin connection settings, prior gateway unit definition, and the prior absent/present state of the dedicated drop-in. It is not committed.

## Applied configuration

- Used the supported TabGoblin plugin panel to set only the Viewer URL to `https://fedora.saga-skink.ts.net`; the existing socket path remained unchanged.
- Added `~/.config/systemd/user/tabgoblin-gateway.service.d/50-tailscale-viewer.conf`:

  ```ini
  [Service]
  Environment=TABGOBLIN_VIEWER_ORIGIN=https://fedora.saga-skink.ts.net
  ```

- Ran a bounded user-systemd daemon reload and gateway restart.
- Configured private Serve with `tailscale serve --bg --https=443 http://127.0.0.1:8931`.
- Did not enable Funnel, alter firewall rules, change portable source defaults, replace built artifacts, or expose a browser transport directly.

## Live verification

| Check | Result |
|---|---|
| Gateway service | `active` |
| Effective gateway origin | Exact `TABGOBLIN_VIEWER_ORIGIN=https://fedora.saga-skink.ts.net` |
| Effective drop-in | Dedicated `50-tailscale-viewer.conf` listed by systemd |
| Plugin connection settings | Authoritative panel reread showed exact Viewer URL and unchanged Unix socket; save became disabled after persistence |
| Generated/status viewer URL | Fresh plugin status showed `Browser ready` with live-viewer actions enabled; the same status request returned exact `https://fedora.saga-skink.ts.net` and `agent-ready` |
| Serve route | HTTPS 443 with `/` proxy to `http://127.0.0.1:8931` |
| Funnel | Disabled; Serve JSON contained no enabled `AllowFunnel` entry |
| DNS | `fedora.saga-skink.ts.net` resolved to `100.88.18.84`, matching this node's Tailscale IPv4 |
| HTTPS viewer | HTTP 200, certificate verification result `0`, remote address `100.88.18.84`; certificate checks were not disabled |
| Viewer bind | Only `127.0.0.1:8931`, not a wildcard or tailnet-interface listener |
| Browser transports while temporarily started | Podman published VNC and CDP ephemeral host ports only on `127.0.0.1`; the browser was stopped after verification |
| Final browser state | Stopped, with no running TabGoblin browser container; the persistent profile was retained |
| Local IPC | Plugin continued using `/run/user/1000/tabgoblin/gateway.sock` |

### Authentication, host, and origin gates

No pairing credential, session cookie, CSRF token, or full plugin settings are included in this evidence.

- Loopback request with the configured Host: HTTP 200.
- Loopback request with an unconfigured Host: HTTP 403.
- Pair request with the configured Origin and a deliberately invalid dummy code: HTTP 401.
- Pair request with an unconfigured Origin: HTTP 403.
- WebSocket upgrade with the configured Origin but no authenticated session: HTTP 401.
- WebSocket upgrade with an unconfigured Origin: HTTP 403.
- Status request without session/CSRF authority: HTTP 403.

These results confirm that Serve reachability did not bypass the viewer's existing host, pairing, session, CSRF, or WebSocket-origin boundaries.

## Automated checks

- First `npm test` under the live production shell environment: **1 failed, 346 passed, 11 skipped**. The sole failure was the existing unit expectation that a missing explicit installation root must throw; this shell intentionally exports `TABGOBLIN_INSTALL_ROOT` for the live plugin, so the tested value was not missing. No source was changed in response.
- Hermetic rerun with only that production variable removed from the test process, `env -u TABGOBLIN_INSTALL_ROOT npm test`: **347 passed, 11 skipped** across 32 files (one file skipped).
- `npm run typecheck`: **passed** for protocol, fixture site, gateway, MCP bridge, viewer, and plugin.

## Preservation of pre-existing work

The repository was already dirty. SHA-256 values taken before deployment and recomputed after all checks matched exactly:

| Pre-existing path | SHA-256 |
|---|---|
| `packages/gateway/src/browser.ts` | `6736fe7838cbe8162e58ee59b2d5cd56d8c8baf5946fa651f3d6fe3ef848d051` |
| `packages/gateway/src/runtime.ts` | `26c90c73ff841a03ee6674613e71c79c40f328dd85e79c0fd786f1a99090cc17` |
| `packages/gateway/test/browser.test.ts` | `2b7e2d442d05d6d3091fe6b40fc85ae8605944e4177ae7bf8908943fd14bbc72` |
| `packages/gateway/test/runtime.test.ts` | `839a078f3460013b7ec2e48683267ff41cb30e687e192ecd8da544c833f072d1` |
| `deploy/install-local.sh` | `1733114c744b18a72155220de300c5a58a20024b337661fc9a76bc8773037a9d` |

After deployment verification, repository status still showed only those four pre-existing modified files, the pre-existing untracked installer, and this acceptance file. No application source/default was changed for this deployment.

## Exact rollback

The snapshot proves that the prior plugin Viewer URL was empty, the dedicated drop-in was absent, and Serve had no configuration. Roll back only this deployment as follows:

1. Recheck `tailscale serve status --json`. If another operator has since added or changed configuration, stop and preserve it rather than applying the old empty snapshot broadly.
2. Remove only this node's HTTPS 443 Serve endpoint:

   ```bash
   tailscale serve --https=443 off
   ```

   Confirm that the `fedora.saga-skink.ts.net:443` web handler and TCP 443 HTTPS entry are absent. Do **not** use `tailscale serve reset`, because that can remove unrelated concurrent routes.
3. In the TabGoblin plugin panel, leave Gateway socket path as `/run/user/1000/tabgoblin/gateway.sock`, clear only **External viewer address**, and select **Save connection settings**. Do not replace unrelated settings or reset profiles, cookies, enrollment, or pairing state.
4. Because the prior dedicated drop-in was absent, remove only it, reload user systemd, and restart only the gateway:

   ```bash
   rm -- "$HOME/.config/systemd/user/tabgoblin-gateway.service.d/50-tailscale-viewer.conf"
   systemctl --user daemon-reload
   systemctl --user restart tabgoblin-gateway.service
   ```

5. Verify `systemctl --user is-active tabgoblin-gateway.service`, confirm `TABGOBLIN_VIEWER_ORIGIN` is absent from the effective service environment, confirm the plugin Viewer URL is empty with its socket unchanged, and confirm only this Serve endpoint was removed.

The private backup is recovery evidence, not a command to overwrite current settings wholesale.
