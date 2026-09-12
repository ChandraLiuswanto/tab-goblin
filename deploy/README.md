# TabGoblin runtime deployment

## Build and verify

Use one stable checkout at `~/paseo-plugins/tab-goblin` for both the gateway user
service and the Paseo plugin. The service starts
`packages/gateway/dist/main.js`, and the plugin derives its MCP bridge from that
same checkout's `packages/mcp-bridge/dist/index.js`. Do not install the plugin as an
independent copy without its sibling `packages/` directory.

From a fresh checkout, install dependencies and build every generated artifact before
loading the plugin or enabling the service. `dist/` is intentionally not committed.

```bash
cd ~/paseo-plugins/tab-goblin
npm ci
npm run build
./deploy/build-image.sh
./deploy/test-image.sh
```

Configure Paseo to load `~/paseo-plugins/tab-goblin/plugin` from this checkout.
Paseo 0.8 compiles server plugins to a cached CJS bundle, so a bundled module filename
cannot identify that checkout. Set this required, absolute path in the environment of
the **Paseo server/daemon process** before loading or reloading the plugin:

```bash
export TABGOBLIN_INSTALL_ROOT="$HOME/paseo-plugins/tab-goblin"
```

Persist the same variable in the service manager, desktop launcher, or shell profile
that starts your Paseo daemon, then restart that daemon and reload TabGoblin. The
plugin validates that this path contains `plugin/paseo-plugin.json` and the built
`packages/mcp-bridge/dist/index.js`; it fails with an actionable error rather than
launching an unusable MCP command. If the checkout moves, rebuild it and update
`TABGOBLIN_INSTALL_ROOT`, the Paseo plugin location, and the gateway service
`WorkingDirectory` together.

The smoke test uses a dedicated temporary Podman volume and publishes CDP and RFB only
on `127.0.0.1`; it removes its test container and volume when it exits. It does not
contact a real account or mount a personal browser profile.

The image runs Chromium as an unprivileged container user with its browser sandbox
intact. Do not add `--no-sandbox`, privileged flags, host networking, or relaxed
seccomp options to make it start. If Chromium cannot start rootlessly, report the
specific Podman/Chromium failure as a deployment blocker.

The runtime expects a persistent per-workspace profile volume at `/profile` and a
separate staging volume at `/staging`, both mounted with SELinux-compatible labels
(such as `:Z`). CDP (9222) and RFB (5900) listen inside the container; publish both
only to host loopback. The gateway, not an exposed raw port, is the viewer boundary.
`TG_SCREEN` defaults to `1280x800x24`. Set `TG_VNC_PASSWORD_FILE` only to a readable
path inside the container when an additional VNC password is required.

Fedora Chromium keeps its DevTools socket on container loopback. Chromium therefore
uses private `127.0.0.1:9223`; a supervised in-container Nginx relay listens on
container port 9222, forwards HTTP/WebSocket CDP traffic, and rewrites discovery URLs
to Podman's loopback-published host port. This does not create a host listener beyond
Podman's explicit `127.0.0.1` publish rule. PID 1 stops the container if Chromium, the
relay, Xvfb, or VNC exits, rather than reporting a partially functioning runtime. On a
normal container stop, PID 1 asks Chromium's private CDP endpoint to close, waits a
bounded interval for its profile flush, and only then tears down the display.

## Gateway user service

Copy `tabgoblin-gateway.service` to `~/.config/systemd/user/`, reload user units,
then an operator may install and start it with:

```bash
install -Dm0644 deploy/tabgoblin-gateway.service ~/.config/systemd/user/tabgoblin-gateway.service
systemctl --user daemon-reload
systemctl --user enable --now tabgoblin-gateway.service
```

This is an operator action; the build and smoke-test scripts never enable services.
Confirm that the gateway itself listens only on loopback before exposing it through
Tailscale.

## Private Tailscale viewer (operator consent required)

Before changing Tailscale Serve, record the existing configuration:

```bash
tailscale serve status
```

**Before enabling Serve**, set the gateway's allowed and advertised viewer origin to
the exact HTTPS MagicDNS URL that Tailscale will provide (replace the placeholder;
do not include a trailing slash). This is required for the viewer's origin checks and
must match the URL configured in the TabGoblin plugin connection settings.

```bash
systemctl --user edit tabgoblin-gateway.service
# Add this drop-in content:
# [Service]
# Environment=TABGOBLIN_VIEWER_ORIGIN=https://your-host.your-tailnet.ts.net
systemctl --user daemon-reload
systemctl --user restart tabgoblin-gateway.service
```

In the TabGoblin plugin panel, set **Viewer URL** to that same
`https://your-host.your-tailnet.ts.net` origin. Only with explicit operator consent,
publish the loopback gateway privately to the tailnet:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8931
```

Never run that command as an implementer or use Tailscale Funnel. To restore the
previous configuration, use the saved `tailscale serve status` output and the
operator-approved Tailscale Serve command appropriate to that prior configuration;
do not guess or overwrite a deployment's existing Serve routes.

## Profile-data warning

A profile volume contains cookies and other login material. Filesystem permissions
are not encryption at rest, and backups of the volume contain authenticated session
data. Use encrypted host storage where required, keep volumes owner-restricted, and
never mount, import, delete, or use a personal browser profile. The runtime holds an
exclusive file lock for its full lifetime. Do not start a second Podman container with
an active profile volume: its `:Z` mount can relabel that volume to the second
container's private MCS label before the runtime reaches the file-lock check. The
supervisor must prevent duplicate runs for an active volume. After a hard kill, the
next lock holder removes stale Chromium singleton links only after acquiring that lock.
