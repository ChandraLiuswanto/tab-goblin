# Tab Goblin Tailscale DNS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development, with the sol-git-gud shared-workspace and agent-reuse overrides.

**Goal:** Deploy the approved Tailscale viewer origin using existing configuration.

**Architecture:** Tailscale Serve terminates HTTPS and forwards to the loopback gateway. The plugin and gateway use the same configured origin; portable application defaults remain unchanged.

**Tech Stack:** systemd user service, Tailscale Serve, Paseo plugin settings, TypeScript/Vitest.

**Spec:** [Approved design](../specs/2026-09-14-tab-goblin-tailscale-dns-design.md)

## Global Constraints

Follow all six requirements and failure boundaries in the spec. Canonical checkout `/home/chandraliuswanto/paseo-plugins/tab-goblin`, workspace `wks_eac82e4a93b86099`. Preserve the existing dirty source/tests and untracked installer. No branches, worktrees, pushes, or base-branch integration. Existing checkout is already on main; report that at Finish, do not perform a merge.

## Ownership and dependency map

- Task A owns live deployment settings, private rollback snapshots, and `docs/acceptance/2026-09-14-tailscale-dns.md`.
- Task B owns `deploy/README.md` only and runs in parallel with A. It documents a portable procedure, not A's live results.
- Coordinator owns spec and plan. Shared git mutations are serialized: B waits for coordinator commit authorization; A commits afterward. Both tasks get independent spec and quality review before closing.

### Task A: Configure and verify the live viewer

**Interfaces:** consumes existing `TABGOBLIN_VIEWER_ORIGIN` in `packages/gateway/src/main.ts` and plugin `updateConnection` in `plugin/server/handlers.ts`; produces a verified deployment and sanitized evidence.

- [ ] Run `bd prime`, claim only assigned ready bead. Record `git status --short` and checksums of pre-existing dirty files. Inspect existing runtime before changing anything:

```bash
systemctl --user cat tabgoblin-gateway.service
tailscale serve status --json
ss -ltn
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8931/
```

- [ ] Record a failing desired-state check (origin absent from service, plugin origin missing/different, or private Serve absent). Store prior live configuration in a mode-0700 local temporary backup directory; never commit credentials or full unrelated plugin settings.
- [ ] Read gateway origin validation and plugin updateConnection implementation. Locate the active plugin's settings using supported Paseo UI or plugin settings APIs. Use a targeted viewerUrl update with the existing socketPath unchanged, preserving all other settings. Do not edit a live settings database or reset pairing state. If no supported settings path is available, report a blocker.
- [ ] Recheck Serve for conflicting routes. Add only a dedicated systemd drop-in `~/.config/systemd/user/tabgoblin-gateway.service.d/50-tailscale-viewer.conf` (back up any existing same-named file), containing:

```ini
[Service]
Environment=TABGOBLIN_VIEWER_ORIGIN=https://fedora.saga-skink.ts.net
```

- [ ] Apply the approved deployment commands (do not build or replace existing dist unless investigation establishes it is required):

```bash
systemctl --user daemon-reload
systemctl --user restart tabgoblin-gateway.service
tailscale serve --bg --https=443 http://127.0.0.1:8931
```

Bound commands with timeouts. If HTTPS provisioning requires external action, preserve evidence and report the blocker. Never use Funnel or silently overwrite conflicting routes.
- [ ] Verify service active, effective origin, persisted plugin Viewer URL, Serve route, and `ss -ltn` loopback-only internal ports. Use `curl --max-time 20 https://fedora.saga-skink.ts.net/` without disabling certificate validation. Inspect generated viewer link through the plugin's existing status path. Confirm existing auth/origin safeguards using the viewer tests; do not mint or publish credentials in evidence.
- [ ] Run `npm test` and `npm run typecheck` if present in package scripts. Do not race build-generated output with another worker. Report pre-existing failures distinctly; do not edit user-owned files to fix them.
- [ ] Write sanitized evidence with exact checks/results, prior-state summary, private backup location, and exact rollback operations restoring the drop-in, plugin origin and only this Serve endpoint. Note remote-client checks not performed.
- [ ] After coordinator authorization, stage only the evidence file and commit `chore: record private Tailscale viewer deployment`. Wait for independent spec and quality reviews; close bead only after both pass.

### Task B: Document portable DNS deployment and rollback

**Files:** modify `deploy/README.md` only.
**Interfaces:** consumes existing deployment section and approved spec; produces portable instructions independently of Task A live execution.

- [ ] Run `bd prime`, claim only assigned ready bead. Read the existing Private Tailscale viewer section.
- [ ] Identify missing reproducibility checks and rollback guidance before editing (documentation task: no artificial unit test required).
- [ ] Document discovery of the host's DNS name via `tailscale status --json` Self.DNSName, removing its trailing dot for the HTTPS origin. Keep examples portable, not hardcoded to this machine.
- [ ] Explain matching gateway origin and plugin Viewer URL, dedicated backed-up drop-in, approved service restart and private Serve operation. Preserve explicit operator consent, conflict inspection, loopback-only internal transports and no-Funnel boundaries.
- [ ] Provide validation commands for service/Serve/HTTPS and rollback instructions distinguishing an initially absent endpoint from a prior configuration. Do not recommend broad Serve reset or unrelated settings replacement.
- [ ] Run `git diff --check`; inspect command syntax and cross-check against gateway origin handling. Report the documentation diff for review.
- [ ] After coordinator authorizes the shared Git mutation, stage only `deploy/README.md`, commit `docs: clarify Tailscale DNS viewer deployment`, and wait for both independent reviews before closing bead.

## Review and finish

- [ ] One plan reviewer checks this plan against the spec; address Issues only before creating beads.
- [ ] Create A and B without dependencies; first `bd ready` must show both. Delegate deployment to Sol/Opus and documentation to a simple-tier worker.
- [ ] Reuse one independent reviewer for separate spec-compliance and quality turns per bead, then whole-deployment final review. Owners fix findings in fix beads; same reviewer re-reviews.
- [ ] Run one fresh Fable gate after final review is clean; route important findings to owners and normal two-stage review, no repeated Fable gate.
- [ ] Delete keep-warm heartbeat, verify tests and repository status, present integration options and wait. Main was the initial branch; no automatic merge or push.

## Plan self-review

Spec requirements 1–4 map to A and portable instructions in B; requirement 5 maps to both ownership constraints and A checksum checks; requirement 6 maps to configuration-only A and B. Live and remote checks are explicitly separated. A and B are disjoint parallel heads; no shared-file dependency is needed. No new application interfaces or source implementation are planned.
