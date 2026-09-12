import type { AdminResponse } from "@tab-goblin/protocol";
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
  const synchronizeSocket = async (timeoutMs?: number): Promise<Map<string, AdminResponse>> => {
    const manager = gateway as Partial<GatewayManager>;
    if (typeof manager.switchSocketPath !== "function" || typeof manager.socketPath !== "function" || manager.socketPath() === settings.read().socketPath) return new Map();
    const current = settings.read();
    const targets = [...current.pendingRevocations, ...current.activeAgentIds.map((id) => ({ kind: "agent" as const, id })), ...Object.keys(current.workspaceGenerations).map((id) => ({ kind: "workspace" as const, id }))];
    const pending = targets.filter((item, index) => targets.findIndex((candidate) => candidate.kind === item.kind && candidate.id === item.id) === index);
    // A socket replacement is a lifecycle boundary: make old-socket cleanup replayable first.
    for (const item of pending) await remember(item);
    const revocations = pending.map((item) => item.kind === "agent" ? { op: "revoke-agent" as const, agentId: item.id } : { op: "revoke-workspace" as const, workspaceId: item.id });
    const responses = await manager.switchSocketPath(settings.read().socketPath, revocations, timeoutMs);
    // The manager retains its old socket when any revoke fails. Keep every intent
    // durable too: none may be replayed against the replacement socket.
    if (responses.length !== pending.length || responses.some((response) => !isGeneration(response))) return new Map();
    await settings.update((value) => ({
      ...value,
      pendingRevocations: value.pendingRevocations.filter((item) => !pending.some((candidate) => candidate.kind === item.kind && candidate.id === item.id)),
      activeAgentIds: value.activeAgentIds.filter((id) => !pending.some((item) => item.kind === "agent" && item.id === id)),
      agentGenerations: Object.fromEntries([...Object.entries(value.agentGenerations), ...pending.flatMap((item, index) => item.kind === "agent" && isGeneration(responses[index]) ? [[item.id, responses[index].lifecycleGeneration] as const] : [])]),
      workspaceGenerations: Object.fromEntries([...Object.entries(value.workspaceGenerations), ...pending.flatMap((item, index) => item.kind === "workspace" && isGeneration(responses[index]) ? [[item.id, responses[index].lifecycleGeneration] as const] : [])]),
      revokedAgentIds: [...new Set([...value.revokedAgentIds, ...pending.filter((item) => item.kind === "agent").map((item) => item.id)])],
      revokedWorkspaceIds: [...new Set([...value.revokedWorkspaceIds, ...pending.filter((item) => item.kind === "workspace").map((item) => item.id)])],
    }));
    return new Map(pending.map((item, index) => [pendingKey(item), responses[index]]));
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
      let agentGeneration = current.agentGenerations[session.agentId] ?? 0;
      let workspaceGeneration = current.workspaceGenerations[session.workspaceId] ?? 0;
      // A known ID was revoked earlier. The reset acknowledgement is durable before it is reused.
      if (current.revokedAgentIds.includes(session.agentId)) {
        const reset = await request({ op: "reset-agent", agentId: session.agentId });
        if (!isGeneration(reset)) return undefined;
        agentGeneration = reset.lifecycleGeneration;
        await settings.update((value) => ({ ...value, agentGenerations: { ...value.agentGenerations, [session.agentId]: agentGeneration }, revokedAgentIds: value.revokedAgentIds.filter((id) => id !== session.agentId) }));
      }
      // A cleanup/archival revocation never implicitly revives an opted-out workspace.
      if (current.revokedWorkspaceIds.includes(session.workspaceId)) {
        const reset = await request({ op: "reset-workspace", workspaceId: session.workspaceId });
        if (!isGeneration(reset)) return undefined;
        workspaceGeneration = reset.lifecycleGeneration;
        await settings.update((value) => ({ ...value, workspaceGenerations: { ...value.workspaceGenerations, [session.workspaceId]: workspaceGeneration }, revokedWorkspaceIds: value.revokedWorkspaceIds.filter((id) => id !== session.workspaceId) }));
      }
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
