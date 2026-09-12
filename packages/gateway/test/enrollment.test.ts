import { describe, expect, it } from "vitest";
import { EnrollmentRegistry } from "../src/enrollment.js";

const NONCE = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";

function bindInteractive(
  registry: EnrollmentRegistry,
  enrollment = NONCE,
  cwd = "/w/one",
  agentId = "agent-1",
  workspaceId = "ws-1",
) {
  registry.record(enrollment, cwd, workspaceId);
  const binding = registry.bind(cwd, agentId, workspaceId);
  registry.noteSessionOpen(agentId, workspaceId, "interactive");
  return binding;
}

describe("EnrollmentRegistry", () => {
  it("resolves a nonce only after agent and interactive session binding", async () => {
    const registry = new EnrollmentRegistry();
    const binding = bindInteractive(registry);

    expect(binding).toMatchObject({
      enrollment: NONCE,
      cwd: "/w/one",
      agentId: "agent-1",
      workspaceId: "ws-1",
      purpose: "interactive",
    });
    await expect(registry.resolve(NONCE, 10)).resolves.toMatchObject({
      agentId: "agent-1",
      workspaceId: "ws-1",
    });
  });

  it("waits for an in-flight agent.created binding, but fails closed for unknown or unbound nonces", async () => {
    const registry = new EnrollmentRegistry();
    registry.record(NONCE, "/w/one", "ws-1");
    const resolving = registry.resolve(NONCE, 100);
    setTimeout(() => {
      registry.bind("/w/one", "agent-1", "ws-1");
      registry.noteSessionOpen("agent-1", "ws-1", "interactive");
    }, 5);

    await expect(resolving).resolves.toMatchObject({ agentId: "agent-1", workspaceId: "ws-1" });
    await expect(registry.resolve(SECOND, 1)).rejects.toMatchObject({ code: "not_enrolled" });

    const unbound = new EnrollmentRegistry();
    unbound.record(NONCE, "/w/one", "ws-1");
    await expect(unbound.resolve(NONCE, 1)).rejects.toMatchObject({ code: "not_enrolled" });
  });

  it("refuses history sessions and workspace-mismatched session notifications", async () => {
    const history = new EnrollmentRegistry();
    history.record(NONCE, "/w/one", "ws-1");
    history.bind("/w/one", "agent-1", "ws-1");
    history.noteSessionOpen("agent-1", "ws-1", "history");
    await expect(history.resolve(NONCE, 1)).rejects.toMatchObject({ code: "not_enrolled" });

    const mismatch = new EnrollmentRegistry();
    mismatch.record(NONCE, "/w/one", "ws-1");
    mismatch.bind("/w/one", "agent-1", "ws-1");
    mismatch.noteSessionOpen("agent-1", "ws-2", "interactive");
    await expect(mismatch.resolve(NONCE, 1)).rejects.toMatchObject({ code: "not_enrolled" });
  });

  it("binds the oldest unbound nonce for the exact cwd", () => {
    const registry = new EnrollmentRegistry();
    registry.record(NONCE, "/w/one", "ws-1");
    registry.record(SECOND, "/w/one", "ws-1");
    registry.record(THIRD, "/w/two", "ws-1");

    expect(registry.bind("/w/one", "agent-1", "ws-1")?.enrollment).toBe(NONCE);
    expect(registry.bind("/w/one", "agent-2", "ws-1")?.enrollment).toBe(SECOND);
    expect(registry.bind("/w/missing", "agent-3", "ws-1")).toBeNull();
  });

  it("expires pending enrollments and inactive bound credentials", async () => {
    let clock = 0;
    const pending = new EnrollmentRegistry({ ttlMs: 1_000, now: () => clock });
    pending.record(NONCE, "/w/one", "ws-1");
    clock = 1_001;
    pending.sweep();
    expect(pending.bind("/w/one", "agent-1", "ws-1")).toBeNull();

    clock = 0;
    const bound = new EnrollmentRegistry({
      ttlMs: 1_000,
      bindingTtlMs: 2_000,
      now: () => clock,
    });
    bindInteractive(bound);
    clock = 2_001;
    bound.sweep();
    await expect(bound.authorize(NONCE)).rejects.toMatchObject({ code: "not_enrolled" });
  });

  it("bounds process-lifetime identities without evicting replay tombstones", () => {
    let clock = 0;
    const registry = new EnrollmentRegistry({
      ttlMs: 1,
      maxEnrollmentIdentities: 3,
      now: () => clock,
    });
    const enrollments = [NONCE, SECOND, THIRD];
    for (const enrollment of enrollments) registry.record(enrollment, "/w/one", "ws-1");

    expect(() => registry.record(NONCE, "/w/one", "ws-1")).not.toThrow();
    expect(() => registry.record(
      "44444444-4444-4444-8444-444444444444",
      "/w/one",
      "ws-1",
    )).toThrow(
      expect.objectContaining({ code: "busy" }),
    );

    clock = 2;
    registry.sweep();
    for (const enrollment of enrollments) {
      expect(() => registry.record(enrollment, "/w/one", "ws-1")).toThrow(
        expect.objectContaining({ code: "auth_failed" }),
      );
    }
    expect(() => registry.record(
      "55555555-5555-4555-8555-555555555555",
      "/w/one",
      "ws-1",
    )).toThrow(
      expect.objectContaining({ code: "busy" }),
    );
  });

  it("bounds open sessions independently and permits capacity reuse only after explicit revocation", () => {
    const registry = new EnrollmentRegistry({
      maxEnrollmentIdentities: 2,
      maxOpenSessions: 2,
    });
    registry.noteSessionOpen("agent-1", "ws-1", "interactive");
    registry.noteSessionOpen("agent-2", "ws-2", "interactive");

    expect(() => registry.noteSessionOpen("agent-3", "ws-3", "interactive")).toThrow(
      expect.objectContaining({ code: "busy" }),
    );

    registry.revokeAgent("agent-1");
    expect(() => registry.noteSessionOpen("agent-3", "ws-3", "interactive")).not.toThrow();
  });

  it("uses the credential binding as the authoritative agent, workspace, and cwd", async () => {
    const registry = new EnrollmentRegistry();
    bindInteractive(registry);

    const first = await registry.authorize(NONCE);
    first.cwd = "/tampered";
    first.workspaceId = "ws-other";

    await expect(registry.authorize(NONCE)).resolves.toMatchObject({
      cwd: "/w/one",
      agentId: "agent-1",
      workspaceId: "ws-1",
    });
  });

  it("never migrates a pending nonce between workspaces sharing cwd and generation", async () => {
    const registry = new EnrollmentRegistry();
    registry.record(NONCE, "/w/shared", "ws-a", 0);

    registry.revokeWorkspace("ws-a");
    expect(registry.bind(
      "/w/shared",
      "agent-b",
      "ws-b",
      { agentGeneration: 0, workspaceGeneration: 0 },
    )).toBeNull();
    registry.noteSessionOpen(
      "agent-b",
      "ws-b",
      "interactive",
      { agentGeneration: 0, workspaceGeneration: 0 },
    );

    await expect(registry.authorize(NONCE)).rejects.toMatchObject({ code: "not_enrolled" });
  });

  it("rejects delayed workspace lifecycle events until an explicit reset generation", async () => {
    const registry = new EnrollmentRegistry();
    registry.record(NONCE, "/w/one", "ws-1", 0);

    expect(registry.revokeWorkspace("ws-1")).toBe(1);
    expect(() => registry.record(SECOND, "/w/one", "ws-1", 0)).toThrow(
      expect.objectContaining({ code: "auth_failed" }),
    );
    expect(() => registry.bind(
      "/w/one",
      "agent-1",
      "ws-1",
      { agentGeneration: 0, workspaceGeneration: 0 },
    )).toThrow(expect.objectContaining({ code: "auth_failed" }));
    expect(() => registry.noteSessionOpen(
      "agent-1",
      "ws-1",
      "interactive",
      { agentGeneration: 0, workspaceGeneration: 0 },
    )).toThrow(expect.objectContaining({ code: "auth_failed" }));
    await expect(registry.authorize(NONCE)).rejects.toMatchObject({ code: "not_enrolled" });

    const workspaceGeneration = registry.resetWorkspace("ws-1");
    expect(workspaceGeneration).toBe(2);
    registry.record(THIRD, "/w/one", "ws-1", workspaceGeneration);
    expect(() => registry.bind(
      "/w/one",
      "agent-1",
      "ws-1",
      { agentGeneration: 0, workspaceGeneration: 0 },
    )).toThrow(expect.objectContaining({ code: "auth_failed" }));
    registry.bind(
      "/w/one",
      "agent-1",
      "ws-1",
      { agentGeneration: 0, workspaceGeneration },
    );
    registry.noteSessionOpen(
      "agent-1",
      "ws-1",
      "interactive",
      { agentGeneration: 0, workspaceGeneration },
    );
    await expect(registry.authorize(SECOND)).rejects.toMatchObject({ code: "not_enrolled" });
    await expect(registry.authorize(THIRD)).resolves.toMatchObject({ workspaceGeneration });
  });

  it("rejects delayed agent lifecycle events and bounds lifecycle tombstones", async () => {
    const registry = new EnrollmentRegistry({ maxLifecycleIdentities: 3 });
    registry.record(NONCE, "/w/one", "ws-1", 0);
    expect(registry.revokeAgent("agent-1")).toBe(1);
    expect(() => registry.bind(
      "/w/one",
      "agent-1",
      "ws-1",
      { agentGeneration: 0, workspaceGeneration: 0 },
    )).toThrow(expect.objectContaining({ code: "auth_failed" }));
    expect(() => registry.noteSessionOpen(
      "agent-1",
      "ws-1",
      "interactive",
      { agentGeneration: 0, workspaceGeneration: 0 },
    )).toThrow(expect.objectContaining({ code: "auth_failed" }));

    const agentGeneration = registry.resetAgent("agent-1");
    expect(agentGeneration).toBe(2);
    registry.bind(
      "/w/one",
      "agent-1",
      "ws-1",
      { agentGeneration, workspaceGeneration: 0 },
    );
    registry.noteSessionOpen(
      "agent-1",
      "ws-1",
      "interactive",
      { agentGeneration, workspaceGeneration: 0 },
    );
    await expect(registry.authorize(NONCE)).resolves.toMatchObject({ agentGeneration });

    registry.revokeAgent("agent-2");
    registry.revokeAgent("agent-3");
    expect(() => registry.revokeAgent("agent-4")).toThrow(
      expect.objectContaining({ code: "busy" }),
    );
    registry.revokeWorkspace("ws-2");
    registry.revokeWorkspace("ws-3");
    expect(() => registry.revokeWorkspace("ws-4")).toThrow(
      expect.objectContaining({ code: "busy" }),
    );
  });

  it("revokes already-bound agent credentials without affecting another agent", async () => {
    const registry = new EnrollmentRegistry();
    bindInteractive(registry);
    bindInteractive(registry, SECOND, "/w/two", "agent-2", "ws-2");

    registry.revokeAgent("agent-1");

    await expect(registry.authorize(NONCE)).rejects.toMatchObject({ code: "not_enrolled" });
    await expect(registry.resolve(NONCE, 1)).rejects.toMatchObject({ code: "not_enrolled" });
    expect(() => registry.record(NONCE, "/w/one", "ws-1")).toThrow(
      expect.objectContaining({ code: "auth_failed" }),
    );
    await expect(registry.authorize(SECOND)).resolves.toMatchObject({ agentId: "agent-2" });
  });

  it("revokes every already-bound credential for a workspace and leaves other workspaces scoped", async () => {
    const registry = new EnrollmentRegistry();
    bindInteractive(registry);
    bindInteractive(registry, SECOND, "/w/one", "agent-2", "ws-1");
    bindInteractive(registry, THIRD, "/w/two", "agent-3", "ws-2");

    registry.revokeWorkspace("ws-1");

    await expect(registry.authorize(NONCE)).rejects.toMatchObject({ code: "not_enrolled" });
    await expect(registry.authorize(SECOND)).rejects.toMatchObject({ code: "not_enrolled" });
    await expect(registry.authorize(THIRD)).resolves.toMatchObject({ workspaceId: "ws-2" });
  });
});
