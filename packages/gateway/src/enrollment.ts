import { performance } from "node:perf_hooks";
import { tabGoblinError } from "@tab-goblin/protocol";

export interface LifecycleGenerations {
  agentGeneration: number;
  workspaceGeneration: number;
}

export interface Binding extends LifecycleGenerations {
  enrollment: string;
  cwd: string;
  agentId: string | null;
  workspaceId: string | null;
  purpose: "interactive" | "history";
  createdAt: number;
}

export interface EnrollmentRegistryOptions {
  /** Maximum time an enrollment may wait for agent.created. */
  ttlMs?: number;
  /** Maximum idle time for an already-bound credential. */
  bindingTtlMs?: number;
  /**
   * Process-lifetime cap for admitted credential identities. Retired identities
   * are never evicted because doing so would permit credential replay. Capacity
   * exhaustion requires a deliberate gateway restart with newly issued credentials.
   */
  maxEnrollmentIdentities?: number;
  /** Independent cap for currently open agent sessions. */
  maxOpenSessions?: number;
  /** Independent cap for remembered agent IDs and workspace IDs. */
  maxLifecycleIdentities?: number;
  now?: () => number;
}

interface StoredBinding {
  binding: Binding;
  expiresAt: number;
}

interface OpenSession extends LifecycleGenerations {
  workspaceId: string | null;
  purpose: "interactive" | "history";
}

interface LifecycleState {
  generation: number;
  enabled: boolean;
}

const DEFAULT_PENDING_TTL_MS = 30_000;
const DEFAULT_BINDING_TTL_MS = 12 * 60 * 60 * 1_000;
const DEFAULT_REGISTRY_CAPACITY = 65_536;
const POLL_INTERVAL_MS = 50;
const INITIAL_GENERATIONS: LifecycleGenerations = {
  agentGeneration: 0,
  workspaceGeneration: 0,
};

function notEnrolled() {
  return tabGoblinError(
    "not_enrolled",
    "TabGoblin is not enabled for this agent's workspace",
    false,
  );
}

function copyBinding(binding: Binding): Binding {
  return { ...binding };
}

function capacityExceeded(): ReturnType<typeof tabGoblinError> {
  return tabGoblinError(
    "busy",
    "Enrollment registry capacity is exhausted; restart the gateway and issue new credentials",
    false,
  );
}

function lifecycleRejected(): ReturnType<typeof tabGoblinError> {
  return tabGoblinError(
    "auth_failed",
    "The lifecycle notification is stale or its target is revoked",
    false,
  );
}

function validateGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 0) throw lifecycleRejected();
}

export class EnrollmentRegistry {
  private readonly records = new Map<string, StoredBinding>();
  // This process-lifetime set is deliberately never evicted: forgetting a retired
  // UUID would let a replayed record notification resurrect its authority.
  private readonly seenEnrollments = new Set<string>();
  private readonly sessions = new Map<string, OpenSession>();
  // Revocation states are also process-lifetime tombstones. Explicit reset advances
  // the generation; it never deletes a tombstone or makes old lifecycle events valid.
  private readonly agentLifecycles = new Map<string, LifecycleState>();
  private readonly workspaceLifecycles = new Map<string, LifecycleState>();
  private readonly ttlMs: number;
  private readonly bindingTtlMs: number;
  private readonly maxEnrollmentIdentities: number;
  private readonly maxOpenSessions: number;
  private readonly maxLifecycleIdentities: number;
  private readonly now: () => number;

  constructor(options: EnrollmentRegistryOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_PENDING_TTL_MS;
    this.bindingTtlMs = options.bindingTtlMs ?? DEFAULT_BINDING_TTL_MS;
    this.maxEnrollmentIdentities =
      options.maxEnrollmentIdentities ?? DEFAULT_REGISTRY_CAPACITY;
    this.maxOpenSessions = options.maxOpenSessions ?? DEFAULT_REGISTRY_CAPACITY;
    this.maxLifecycleIdentities =
      options.maxLifecycleIdentities ?? DEFAULT_REGISTRY_CAPACITY;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new TypeError("ttlMs must be positive");
    }
    if (!Number.isFinite(this.bindingTtlMs) || this.bindingTtlMs <= 0) {
      throw new TypeError("bindingTtlMs must be positive");
    }
    if (!Number.isSafeInteger(this.maxEnrollmentIdentities) || this.maxEnrollmentIdentities <= 0) {
      throw new TypeError("maxEnrollmentIdentities must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxOpenSessions) || this.maxOpenSessions <= 0) {
      throw new TypeError("maxOpenSessions must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxLifecycleIdentities) || this.maxLifecycleIdentities <= 0) {
      throw new TypeError("maxLifecycleIdentities must be a positive safe integer");
    }
  }

  record(
    enrollment: string,
    cwd: string,
    workspaceId: string,
    workspaceGeneration = 0,
  ): void {
    validateGeneration(workspaceGeneration);
    this.requireLifecycleGeneration(
      this.workspaceLifecycles,
      workspaceId,
      workspaceGeneration,
    );
    this.sweep();
    const existing = this.records.get(enrollment);
    if (existing) {
      // Hook delivery can be retried. It must never be able to move a credential,
      // change its workspace or generation, or reset its expiry.
      if (
        existing.binding.cwd === cwd &&
        existing.binding.workspaceId === workspaceId &&
        existing.binding.workspaceGeneration === workspaceGeneration
      ) {
        return;
      }
      throw tabGoblinError("auth_failed", "Enrollment credential is already in use", false);
    }
    if (this.seenEnrollments.has(enrollment)) {
      throw tabGoblinError("auth_failed", "Enrollment credential has expired or been revoked", false);
    }
    // The active map and process-lifetime anti-replay set are independently
    // guarded by the same hard bound. Never evict an identity to make room.
    if (
      this.records.size >= this.maxEnrollmentIdentities ||
      this.seenEnrollments.size >= this.maxEnrollmentIdentities
    ) {
      throw capacityExceeded();
    }
    this.ensureLifecycleCapacity(this.workspaceLifecycles, workspaceId);

    const createdAt = this.now();
    if (!this.workspaceLifecycles.has(workspaceId)) {
      this.workspaceLifecycles.set(workspaceId, { generation: 0, enabled: true });
    }
    this.seenEnrollments.add(enrollment);
    this.records.set(enrollment, {
      binding: {
        enrollment,
        cwd,
        agentId: null,
        workspaceId,
        purpose: "interactive",
        createdAt,
        agentGeneration: 0,
        workspaceGeneration,
      },
      expiresAt: createdAt + this.ttlMs,
    });
  }

  bind(
    enrollment: string,
    cwd: string,
    agentId: string,
    workspaceId: string | null,
    generations: LifecycleGenerations = INITIAL_GENERATIONS,
  ): Binding | null {
    this.validateLifecycleEvent(agentId, workspaceId, generations);
    this.sweep();
    const selected = this.records.get(enrollment);
    if (
      !selected ||
      selected.binding.agentId !== null ||
      selected.binding.cwd !== cwd ||
      selected.binding.workspaceId !== workspaceId ||
      selected.binding.workspaceGeneration !== generations.workspaceGeneration
    ) {
      return null;
    }

    this.admitLifecycleTargets(agentId, workspaceId);
    const session = this.sessions.get(agentId);
    selected.binding.agentId = agentId;
    selected.binding.purpose = session?.purpose ?? "interactive";
    selected.binding.agentGeneration = generations.agentGeneration;
    selected.expiresAt = this.now() + this.bindingTtlMs;
    return copyBinding(selected.binding);
  }

  noteSessionOpen(
    agentId: string,
    workspaceId: string | null,
    purpose: "interactive" | "history",
    generations: LifecycleGenerations = INITIAL_GENERATIONS,
  ): void {
    this.validateLifecycleEvent(agentId, workspaceId, generations);
    this.admitLifecycleTargets(agentId, workspaceId);
    if (!this.sessions.has(agentId) && this.sessions.size >= this.maxOpenSessions) {
      throw capacityExceeded();
    }
    this.sessions.set(agentId, { workspaceId, purpose, ...generations });

    for (const [enrollment, stored] of this.records) {
      if (stored.binding.agentId !== agentId) continue;
      if (
        purpose !== "interactive" ||
        workspaceId === null ||
        stored.binding.workspaceId !== workspaceId ||
        stored.binding.agentGeneration !== generations.agentGeneration ||
        stored.binding.workspaceGeneration !== generations.workspaceGeneration
      ) {
        // A history session, workspace reassignment, or generation mismatch must
        // not allow a previous interactive credential to become valid again.
        this.retire(enrollment);
        continue;
      }
      stored.binding.purpose = purpose;
    }
  }

  async resolve(enrollment: string, waitMs = 20_000): Promise<Binding> {
    const deadline = performance.now() + Math.max(0, waitMs);
    while (true) {
      this.sweep();
      const stored = this.records.get(enrollment);
      if (stored && this.isInteractiveBinding(stored.binding)) {
        stored.expiresAt = this.now() + this.bindingTtlMs;
        return copyBinding(stored.binding);
      }

      const remaining = deadline - performance.now();
      if (remaining <= 0) throw notEnrolled();
      await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
    }
  }

  async authorize(enrollment: string): Promise<Binding> {
    this.sweep();
    const stored = this.records.get(enrollment);
    if (!stored || !this.isInteractiveBinding(stored.binding)) throw notEnrolled();
    stored.expiresAt = this.now() + this.bindingTtlMs;
    return copyBinding(stored.binding);
  }

  revokeAgent(agentId: string): number {
    const generation = this.advanceLifecycle(this.agentLifecycles, agentId, false);
    for (const [enrollment, stored] of this.records) {
      if (stored.binding.agentId === agentId) this.retire(enrollment);
    }
    this.sessions.delete(agentId);
    return generation;
  }

  revokeWorkspace(workspaceId: string): number {
    const generation = this.advanceLifecycle(this.workspaceLifecycles, workspaceId, false);
    for (const [enrollment, stored] of this.records) {
      if (stored.binding.workspaceId === workspaceId) this.retire(enrollment);
    }
    for (const [agentId, session] of this.sessions) {
      if (session.workspaceId === workspaceId) this.sessions.delete(agentId);
    }
    return generation;
  }

  /**
   * Deliberately re-enable an agent ID. T12 must persist and attach the returned
   * generation to future bind/session notifications; generation zero is stale.
   */
  resetAgent(agentId: string): number {
    const generation = this.advanceLifecycle(this.agentLifecycles, agentId, true);
    for (const [enrollment, stored] of this.records) {
      if (stored.binding.agentId === agentId) this.retire(enrollment);
    }
    this.sessions.delete(agentId);
    return generation;
  }

  /**
   * Deliberately re-enable a workspace. T12 must issue new credentials tagged
   * with the returned generation; queued notifications from older generations fail.
   */
  resetWorkspace(workspaceId: string): number {
    const generation = this.advanceLifecycle(this.workspaceLifecycles, workspaceId, true);
    for (const [enrollment, stored] of this.records) {
      if (stored.binding.workspaceId === workspaceId) this.retire(enrollment);
    }
    for (const [agentId, session] of this.sessions) {
      if (session.workspaceId === workspaceId) this.sessions.delete(agentId);
    }
    return generation;
  }

  sweep(): void {
    const now = this.now();
    for (const [enrollment, stored] of this.records) {
      if (stored.expiresAt <= now) this.retire(enrollment);
    }
  }

  private validateLifecycleEvent(
    agentId: string,
    workspaceId: string | null,
    generations: LifecycleGenerations,
  ): void {
    validateGeneration(generations.agentGeneration);
    validateGeneration(generations.workspaceGeneration);
    this.requireLifecycleGeneration(
      this.agentLifecycles,
      agentId,
      generations.agentGeneration,
    );
    if (workspaceId === null) {
      if (generations.workspaceGeneration !== 0) throw lifecycleRejected();
      return;
    }
    this.requireLifecycleGeneration(
      this.workspaceLifecycles,
      workspaceId,
      generations.workspaceGeneration,
    );
  }

  private requireLifecycleGeneration(
    states: Map<string, LifecycleState>,
    id: string,
    generation: number,
  ): void {
    const state = states.get(id);
    if (state) {
      if (!state.enabled || state.generation !== generation) throw lifecycleRejected();
      return;
    }
    if (generation !== 0) throw lifecycleRejected();
  }

  private admitLifecycleTargets(agentId: string, workspaceId: string | null): void {
    this.ensureLifecycleCapacity(this.agentLifecycles, agentId);
    if (workspaceId !== null) this.ensureLifecycleCapacity(this.workspaceLifecycles, workspaceId);
    if (!this.agentLifecycles.has(agentId)) {
      this.agentLifecycles.set(agentId, { generation: 0, enabled: true });
    }
    if (workspaceId !== null && !this.workspaceLifecycles.has(workspaceId)) {
      this.workspaceLifecycles.set(workspaceId, { generation: 0, enabled: true });
    }
  }

  private ensureLifecycleCapacity(states: Map<string, LifecycleState>, id: string): void {
    if (!states.has(id) && states.size >= this.maxLifecycleIdentities) {
      throw capacityExceeded();
    }
  }

  private advanceLifecycle(
    states: Map<string, LifecycleState>,
    id: string,
    enabled: boolean,
  ): number {
    this.ensureLifecycleCapacity(states, id);
    const current = states.get(id)?.generation ?? 0;
    if (current >= Number.MAX_SAFE_INTEGER) throw capacityExceeded();
    const generation = current + 1;
    states.set(id, { generation, enabled });
    return generation;
  }

  private retire(enrollment: string): void {
    this.records.delete(enrollment);
  }

  private isInteractiveBinding(
    binding: Binding,
  ): binding is Binding & { agentId: string; workspaceId: string } {
    if (
      binding.agentId === null ||
      binding.workspaceId === null ||
      binding.purpose !== "interactive"
    ) {
      return false;
    }
    const agentLifecycle = this.agentLifecycles.get(binding.agentId);
    const workspaceLifecycle = this.workspaceLifecycles.get(binding.workspaceId);
    if (
      agentLifecycle?.enabled !== true ||
      agentLifecycle.generation !== binding.agentGeneration ||
      workspaceLifecycle?.enabled !== true ||
      workspaceLifecycle.generation !== binding.workspaceGeneration
    ) {
      return false;
    }
    const session = this.sessions.get(binding.agentId);
    return (
      session?.purpose === "interactive" &&
      session.workspaceId === binding.workspaceId &&
      session.agentGeneration === binding.agentGeneration &&
      session.workspaceGeneration === binding.workspaceGeneration
    );
  }
}
