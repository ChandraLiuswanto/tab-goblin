import { PROTOCOL_VERSION, type AdminResponse } from "@tab-goblin/protocol";
import type { ConfigStore } from "./config-store.js";
import type { GatewayClient, GatewayManager } from "./gateway-client.js";

type Pending = { kind: "agent" | "workspace"; id: string };
type Session = { agentId: string; workspaceId: string; cwd: string; purpose: "interactive" | "history"; enrollment: string };
type SessionScope = { socketPath: string; agentGeneration: number; workspaceGeneration: number };

function pendingKey(pending: Pending): string { return `${pending.kind}:${pending.id}`; }
function revocationPending(body: Parameters<GatewayClient["request"]>[0]): Pending | undefined {
  if (body.op === "revoke-agent") return { kind: "agent", id: body.agentId };
  if (body.op === "revoke-workspace") return { kind: "workspace", id: body.workspaceId };
  return undefined;
}

function isGeneration(response: AdminResponse | undefined): response is AdminResponse & { ok: true; lifecycleGeneration: number } {
  if (!response?.ok) return false;
  const generation = response.lifecycleGeneration;
  return generation !== undefined && Number.isSafeInteger(generation) && generation >= 0;
}

/**
 * The sole writer for lifecycle authority. Gateway acknowledgements and durable
 * generation changes share one queue so an older asynchronous response cannot
 * overwrite later authority state.
 */
export function createLifecycleCoordinator(settings: ConfigStore, gateway: GatewayClient) {
  let tail = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const authorityTargets = () => {
    const current = settings.read();
    const targets = [...current.pendingRevocations, ...current.activeAgentIds.map((id) => ({ kind: "agent" as const, id })), ...Object.keys(current.workspaceGenerations).map((id) => ({ kind: "workspace" as const, id }))];
    return targets.filter((item, index) => targets.findIndex((candidate) => candidate.kind === item.kind && candidate.id === item.id) === index);
  };
  const commitRevocations = async (pending: Pending[], responses: readonly AdminResponse[], connection?: { socketPath: string; viewerUrl: string; gatewayInstanceId?: null }) => {
    if (responses.length !== pending.length || responses.some((response) => !isGeneration(response))) throw new Error("socket revocation was not acknowledged");
    await settings.update((value) => ({
      ...value,
      ...(connection ?? {}),
      pendingRevocations: value.pendingRevocations.filter((item) => !pending.some((candidate) => candidate.kind === item.kind && candidate.id === item.id)),
      activeAgentIds: value.activeAgentIds.filter((id) => !pending.some((item) => item.kind === "agent" && item.id === id)),
      agentGenerations: Object.fromEntries([...Object.entries(value.agentGenerations), ...pending.flatMap((item, index) => item.kind === "agent" && isGeneration(responses[index]) ? [[item.id, responses[index].lifecycleGeneration] as const] : [])]),
      workspaceGenerations: Object.fromEntries([...Object.entries(value.workspaceGenerations), ...pending.flatMap((item, index) => item.kind === "workspace" && isGeneration(responses[index]) ? [[item.id, responses[index].lifecycleGeneration] as const] : [])]),
      revokedAgentIds: [...new Set([...value.revokedAgentIds, ...pending.filter((item) => item.kind === "agent").map((item) => item.id)])],
      revokedWorkspaceIds: [...new Set([...value.revokedWorkspaceIds, ...pending.filter((item) => item.kind === "workspace").map((item) => item.id)])],
    }));
  };
  const synchronizeSocket = async (timeoutMs?: number): Promise<Map<string, AdminResponse>> => {
    const manager = gateway as Partial<GatewayManager>;
    if (typeof manager.switchSocketPath !== "function" || typeof manager.socketPath !== "function" || manager.socketPath() === settings.read().socketPath) return new Map();
    const pending = authorityTargets();
    const revocations = pending.map((item) => item.kind === "agent" ? { op: "revoke-agent" as const, agentId: item.id } : { op: "revoke-workspace" as const, workspaceId: item.id });
    const result = await manager.switchSocketPath(settings.read().socketPath, revocations, {
      beforeRevocations: async () => { for (const item of pending) await remember(item); },
      commit: (responses) => commitRevocations(pending, responses),
    }, timeoutMs);
    // A failed probe or old-socket revoke keeps the old client and every old-origin
    // intent. No response may be replayed against the candidate.
    if (!result.ok) return new Map();
    return new Map(pending.map((item, index) => [pendingKey(item), result.responses[index]]));
  };
  const request = async (body: Parameters<GatewayClient["request"]>[0], timeoutMs?: number): Promise<AdminResponse | undefined> => {
    try {
      const synchronized = await synchronizeSocket(timeoutMs);
      const pending = revocationPending(body);
      // A revoke acknowledged by the old socket during switching must not be
      // retried against the new socket. Return its original acknowledgement.
      return pending ? synchronized.get(pendingKey(pending)) ?? await gateway.request(body, timeoutMs) : await gateway.request(body, timeoutMs);
    } catch { return undefined; }
  };
  const remember = async (pending: Pending) => settings.update((current) => {
    if (current.pendingRevocations.some((item) => item.kind === pending.kind && item.id === pending.id)) return current;
    if (current.pendingRevocations.length >= 512) throw new Error("too many pending authority revocations");
    return { ...current, pendingRevocations: [...current.pendingRevocations, pending] };
  });
  /**
   * A gateway restart forgets its in-memory lifecycle registry. Its fresh process
   * identity authorizes this one-time reconciliation; a generation by itself
   * never does. Tombstones are replayed as revocations, while previously enabled
   * IDs receive a fresh, gateway-issued generation for this new identity.
   */
  const reconcileGatewayInstance = async (): Promise<boolean> => {
    let health: AdminResponse;
    try { health = await gateway.request({ op: "health" }); }
    catch { return false; }
    if (!health.ok || health.protocolVersion !== PROTOCOL_VERSION || !health.gatewayInstanceId) return false;
    // Capture the validated optional protocol field before awaits and the
    // durable-store callback, where TypeScript correctly stops narrowing it.
    const gatewayInstanceId = health.gatewayInstanceId;
    const current = settings.read();
    if (current.gatewayInstanceId === gatewayInstanceId) return true;

    const pending = new Set(current.pendingRevocations.map(pendingKey));
    const revokedAgents = new Set([...current.revokedAgentIds, ...current.pendingRevocations.filter((item) => item.kind === "agent").map((item) => item.id)]);
    const revokedWorkspaces = new Set([...current.revokedWorkspaceIds, ...current.pendingRevocations.filter((item) => item.kind === "workspace").map((item) => item.id)]);
    const agents = new Set([...Object.keys(current.agentGenerations), ...current.activeAgentIds, ...revokedAgents]);
    const workspaces = new Set([...Object.keys(current.workspaceGenerations), ...revokedWorkspaces]);
    const acknowledged: Array<{ kind: Pending["kind"]; id: string; generation: number; revoked: boolean }> = [];
    for (const id of agents) {
      const revoked = revokedAgents.has(id);
      const response = await gateway.request(revoked ? { op: "revoke-agent", agentId: id } : { op: "reset-agent", agentId: id });
      if (!isGeneration(response)) return false;
      acknowledged.push({ kind: "agent", id, generation: response.lifecycleGeneration, revoked });
    }
    for (const id of workspaces) {
      const revoked = revokedWorkspaces.has(id);
      const response = await gateway.request(revoked ? { op: "revoke-workspace", workspaceId: id } : { op: "reset-workspace", workspaceId: id });
      if (!isGeneration(response)) return false;
      acknowledged.push({ kind: "workspace", id, generation: response.lifecycleGeneration, revoked });
    }
    await settings.update((value) => ({
      ...value,
      gatewayInstanceId,
      pendingRevocations: value.pendingRevocations.filter((item) => !pending.has(pendingKey(item))),
      activeAgentIds: value.activeAgentIds.filter((id) => !revokedAgents.has(id)),
      agentGenerations: {
        ...value.agentGenerations,
        ...Object.fromEntries(acknowledged.filter((item) => item.kind === "agent").map((item) => [item.id, item.generation])),
      },
      workspaceGenerations: {
        ...value.workspaceGenerations,
        ...Object.fromEntries(acknowledged.filter((item) => item.kind === "workspace").map((item) => [item.id, item.generation])),
      },
      revokedAgentIds: [...new Set([...value.revokedAgentIds, ...acknowledged.filter((item) => item.kind === "agent" && item.revoked).map((item) => item.id)])],
      revokedWorkspaceIds: [...new Set([...value.revokedWorkspaceIds, ...acknowledged.filter((item) => item.kind === "workspace" && item.revoked).map((item) => item.id)])],
    }));
    return true;
  };
  const revoke = async (pending: Pending, timeoutMs?: number): Promise<boolean> => {
    // Persist intent before I/O: a reload can replay an interrupted cleanup safely.
    await remember(pending);
    const response = await request(pending.kind === "agent" ? { op: "revoke-agent", agentId: pending.id } : { op: "revoke-workspace", workspaceId: pending.id }, timeoutMs);
    if (!isGeneration(response)) return false;
    await settings.update((current) => ({
      ...current,
      pendingRevocations: current.pendingRevocations.filter((item) => item.kind !== pending.kind || item.id !== pending.id),
      activeAgentIds: pending.kind === "agent" ? current.activeAgentIds.filter((id) => id !== pending.id) : current.activeAgentIds,
      agentGenerations: pending.kind === "agent" && isGeneration(response) ? { ...current.agentGenerations, [pending.id]: response.lifecycleGeneration } : current.agentGenerations,
      workspaceGenerations: pending.kind === "workspace" && isGeneration(response) ? { ...current.workspaceGenerations, [pending.id]: response.lifecycleGeneration } : current.workspaceGenerations,
      revokedAgentIds: pending.kind === "agent" ? [...new Set([...current.revokedAgentIds, pending.id])] : current.revokedAgentIds,
      revokedWorkspaceIds: pending.kind === "workspace" ? [...new Set([...current.revokedWorkspaceIds, pending.id])] : current.revokedWorkspaceIds,
    }));
    return true;
  };
  return {
    settings: settings.read,
    replayPending: () => serialize(async () => {
      const deadline = Date.now() + 2_000;
      for (const pending of settings.read().pendingRevocations) { const remaining = deadline - Date.now(); if (remaining <= 0) break; await revoke(pending, remaining); }
    }),
    revokeAgent: (agentId: string) => serialize(() => revoke({ kind: "agent", id: agentId })),
    revokeWorkspace: (workspaceId: string) => serialize(() => revoke({ kind: "workspace", id: workspaceId })),
    setGlobalEnabled: (enabled: boolean) => serialize(async () => {
      const current = settings.read();
      if (enabled) {
        if (current.enabled) return { ok: true as const };
        const deadline = Date.now() + 2_000;
        for (const pending of current.pendingRevocations) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) return { ok: false as const };
          try { if (!await revoke(pending, remaining)) return { ok: false as const }; }
          catch { return { ok: false as const }; }
        }
        if (settings.read().pendingRevocations.length > 0) return { ok: false as const };
        await settings.update((value) => ({ ...value, enabled: true }));
        return { ok: true as const };
      }
      const candidates: Pending[] = [
        ...current.pendingRevocations,
        ...Object.keys(current.workspaceGenerations)
          .filter((id) => !current.revokedWorkspaceIds.includes(id))
          .map((id) => ({ kind: "workspace" as const, id })),
        ...current.activeAgentIds
          .filter((id) => !current.revokedAgentIds.includes(id))
          .map((id) => ({ kind: "agent" as const, id })),
      ];
      const targets = candidates.filter((item, index) => candidates.findIndex((candidate) => candidate.kind === item.kind && candidate.id === item.id) === index);
      if (targets.length > 512) return { ok: false as const };
      // Persist both the closed admission gate and every cleanup intent atomically.
      // A crash at any later point can only leave replayable revocations behind.
      await settings.update((value) => ({ ...value, enabled: false, pendingRevocations: targets }));
      let acknowledged = true;
      const deadline = Date.now() + 2_000;
      for (const target of targets) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) { acknowledged = false; break; }
        try { if (!await revoke(target, remaining)) acknowledged = false; }
        catch { acknowledged = false; }
      }
      return { ok: acknowledged };
    }),
    updateConnection: (connection: { socketPath: string; viewerUrl: string }) => serialize(async () => {
      const current = settings.read();
      if (current.socketPath === connection.socketPath) {
        await settings.update((value) => ({ ...value, viewerUrl: connection.viewerUrl }));
        return { ok: true as const };
      }
      const manager = gateway as Partial<GatewayManager>;
      if (typeof manager.switchSocketPath !== "function" || typeof manager.socketPath !== "function") return { ok: false as const };
      const pending = authorityTargets();
      const revocations = pending.map((item) => item.kind === "agent" ? { op: "revoke-agent" as const, agentId: item.id } : { op: "revoke-workspace" as const, workspaceId: item.id });
      try {
        const result = await manager.switchSocketPath(connection.socketPath, revocations, {
          beforeRevocations: async () => { for (const item of pending) await remember(item); },
          commit: (responses) => commitRevocations(pending, responses, { ...connection, gatewayInstanceId: null }),
        });
        return { ok: result.ok && manager.socketPath() === connection.socketPath };
      } catch {
        return { ok: false as const };
      }
    }),
    enableWorkspace: (workspaceId: string, cwd: string) => serialize(async () => {
      const response = await request({ op: "reset-workspace", workspaceId });
      if (!isGeneration(response)) return { ok: false as const };
      await settings.update((current) => ({
        ...current,
        enabledWorkspaceCwds: [...new Set([...current.enabledWorkspaceCwds, cwd])],
        workspaceGenerations: { ...current.workspaceGenerations, [workspaceId]: response.lifecycleGeneration },
        revokedWorkspaceIds: current.revokedWorkspaceIds.filter((id) => id !== workspaceId),
      }));
      return { ok: true as const };
    }),
    disableWorkspace: (workspaceId: string, cwd: string) => serialize(async () => {
      if (!await revoke({ kind: "workspace", id: workspaceId })) return { ok: false as const };
      await settings.update((current) => ({
        ...current,
        enabledWorkspaceCwds: current.enabledWorkspaceCwds.filter((item) => item !== cwd),
        // The revocation's acknowledged generation was persisted by revoke().
      }));
      return { ok: true as const };
    }),
    openSession: (session: Session) => serialize(async (): Promise<SessionScope | undefined> => {
      const current = settings.read();
      if (!current.enabled || !current.enabledWorkspaceCwds.includes(session.cwd)) return undefined;
      // A restart may only recover durable state after the new gateway proves a
      // distinct process identity. No persisted generation is accepted alone.
      if (!await reconcileGatewayInstance()) return undefined;
      const reconciled = settings.read();
      // Archived/opted-out identities are tombstones. Session opening is never an
      // approval to reset them; enableWorkspace is the explicit workspace reset.
      if (reconciled.revokedAgentIds.includes(session.agentId) || reconciled.revokedWorkspaceIds.includes(session.workspaceId)) return undefined;
      const agentGeneration = reconciled.agentGenerations[session.agentId] ?? 0;
      const workspaceGeneration = reconciled.workspaceGenerations[session.workspaceId] ?? 0;
      const recorded = await request({ op: "record-enrollment", enrollment: session.enrollment, cwd: session.cwd, workspaceId: session.workspaceId, workspaceGeneration });
      if (!recorded?.ok) return undefined;
      const bound = await request({ op: "bind-enrollment", cwd: session.cwd, agentId: session.agentId, workspaceId: session.workspaceId, agentGeneration, workspaceGeneration });
      if (!bound?.ok) return undefined;
      await settings.update((value) => ({ ...value, activeAgentIds: [...new Set([...value.activeAgentIds, session.agentId])] }));
      const opened = await request({ op: "session-open", agentId: session.agentId, workspaceId: session.workspaceId, purpose: session.purpose, agentGeneration, workspaceGeneration });
      return opened?.ok ? { socketPath: settings.read().socketPath, agentGeneration, workspaceGeneration } : undefined;
    }),
    cleanup: () => serialize(async () => {
      const current = settings.read();
      const pending = [...current.pendingRevocations, ...current.activeAgentIds.map((id) => ({ kind: "agent" as const, id })), ...Object.keys(current.agentGenerations).map((id) => ({ kind: "agent" as const, id })), ...Object.keys(current.workspaceGenerations).map((id) => ({ kind: "workspace" as const, id }))];
      const unique = pending.filter((item, index) => pending.findIndex((candidate) => candidate.kind === item.kind && candidate.id === item.id) === index);
      // First make every revocation replayable, then use a bounded window for I/O.
      for (const item of unique) await remember(item);
      const deadline = Date.now() + 2_000;
      for (const item of unique) { const remaining = deadline - Date.now(); if (remaining <= 0) break; await revoke(item, remaining); }
    }),
  };
}
export type LifecycleCoordinator = ReturnType<typeof createLifecycleCoordinator>;
