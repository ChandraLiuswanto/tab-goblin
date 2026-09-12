import { performance } from "node:perf_hooks";
import { tabGoblinError } from "@tab-goblin/protocol";

export interface Binding {
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
  now?: () => number;
}

interface StoredBinding {
  binding: Binding;
  expiresAt: number;
}

interface OpenSession {
  workspaceId: string | null;
  purpose: "interactive" | "history";
}

const DEFAULT_PENDING_TTL_MS = 30_000;
const DEFAULT_BINDING_TTL_MS = 12 * 60 * 60 * 1_000;
const POLL_INTERVAL_MS = 50;

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

export class EnrollmentRegistry {
  private readonly records = new Map<string, StoredBinding>();
  private readonly retired = new Set<string>();
  private readonly sessions = new Map<string, OpenSession>();
  private readonly ttlMs: number;
  private readonly bindingTtlMs: number;
  private readonly now: () => number;

  constructor(options: EnrollmentRegistryOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_PENDING_TTL_MS;
    this.bindingTtlMs = options.bindingTtlMs ?? DEFAULT_BINDING_TTL_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new TypeError("ttlMs must be positive");
    }
    if (!Number.isFinite(this.bindingTtlMs) || this.bindingTtlMs <= 0) {
      throw new TypeError("bindingTtlMs must be positive");
    }
  }

  record(enrollment: string, cwd: string): void {
    this.sweep();
    if (this.retired.has(enrollment)) {
      throw tabGoblinError("auth_failed", "Enrollment credential has expired or been revoked", false);
    }
    const existing = this.records.get(enrollment);
    if (existing) {
      // Hook delivery can be retried. It must never be able to move a credential
      // to a different cwd or reset an already-running credential's expiry.
      if (existing.binding.cwd === cwd) return;
      throw tabGoblinError("auth_failed", "Enrollment credential is already in use", false);
    }

    const createdAt = this.now();
    this.records.set(enrollment, {
      binding: {
        enrollment,
        cwd,
        agentId: null,
        workspaceId: null,
        purpose: "interactive",
        createdAt,
      },
      expiresAt: createdAt + this.ttlMs,
    });
  }

  bind(
    cwd: string,
    agentId: string,
    workspaceId: string | null,
  ): Binding | null {
    this.sweep();
    let selected: StoredBinding | undefined;
    for (const stored of this.records.values()) {
      if (stored.binding.cwd !== cwd || stored.binding.agentId !== null) continue;
      if (!selected || stored.binding.createdAt < selected.binding.createdAt) selected = stored;
    }
    if (!selected) return null;

    const session = this.sessions.get(agentId);
    selected.binding.agentId = agentId;
    selected.binding.workspaceId = workspaceId;
    selected.binding.purpose = session?.purpose ?? "interactive";
    selected.expiresAt = this.now() + this.bindingTtlMs;
    return copyBinding(selected.binding);
  }

  noteSessionOpen(
    agentId: string,
    workspaceId: string | null,
    purpose: "interactive" | "history",
  ): void {
    this.sessions.set(agentId, { workspaceId, purpose });

    for (const [enrollment, stored] of this.records) {
      if (stored.binding.agentId !== agentId) continue;
      if (
        purpose !== "interactive" ||
        workspaceId === null ||
        stored.binding.workspaceId !== workspaceId
      ) {
        // A history session or workspace reassignment must not allow a previous
        // interactive credential to become valid again on a later notification.
        this.retire(enrollment);
        continue;
      }
      stored.binding.purpose = purpose;
    }
  }

  async resolve(
    enrollment: string,
    waitMs = 20_000,
  ): Promise<Binding> {
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

  revokeAgent(agentId: string): void {
    for (const [enrollment, stored] of this.records) {
      if (stored.binding.agentId === agentId) this.retire(enrollment);
    }
    this.sessions.delete(agentId);
  }

  revokeWorkspace(workspaceId: string): void {
    for (const [enrollment, stored] of this.records) {
      if (stored.binding.workspaceId === workspaceId) this.retire(enrollment);
    }
    for (const [agentId, session] of this.sessions) {
      if (session.workspaceId === workspaceId) this.sessions.delete(agentId);
    }
  }

  sweep(): void {
    const now = this.now();
    for (const [enrollment, stored] of this.records) {
      if (stored.expiresAt <= now) this.retire(enrollment);
    }
  }

  private retire(enrollment: string): void {
    this.records.delete(enrollment);
    this.retired.add(enrollment);
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
    const session = this.sessions.get(binding.agentId);
    return (
      session?.purpose === "interactive" &&
      session.workspaceId === binding.workspaceId
    );
  }
}
