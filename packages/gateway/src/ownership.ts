import {
  OWNERSHIP_DRAIN_TIMEOUT_MS,
  tabGoblinError,
  type OwnershipState,
  type TabGoblinError,
} from "@tab-goblin/protocol";

export interface Lease {
  generation: number;
  operationId: string;
  release(outcome: "ok" | "error"): void;
  abandonUncertain(): void;
}

export interface OwnershipSnapshot {
  state: OwnershipState;
  generation: number;
  owner: "agent" | "viewer" | null;
  ownerViewerSessionId: string | null;
}

interface ActiveLease {
  generation: number;
  operationId: string;
  token: symbol;
}

type DrainOutcome = "released" | "uncertain" | "timeout";

interface DrainWaiter {
  token: symbol;
  settle(outcome: DrainOutcome): void;
}

interface LifecycleIntent {
  state: "agent-ready" | "manual";
  ownerViewerSessionId: string | null;
}

export class OwnershipController {
  private state: OwnershipState = "agent-ready";
  private generation = 0;
  private owner: "agent" | "viewer" | null = null;
  private ownerViewerSessionId: string | null = null;
  private activeLease: ActiveLease | null = null;
  private drainWaiter: DrainWaiter | null = null;
  private lifecycleFenced = false;
  private lifecycleIntent: LifecycleIntent | null = null;
  private readonly generationListeners = new Set<(generation: number) => void>();
  private readonly drainTimeoutMs: number;

  constructor(options: { now?: () => number; drainTimeoutMs?: number } = {}) {
    const drainTimeoutMs = options.drainTimeoutMs ?? OWNERSHIP_DRAIN_TIMEOUT_MS;
    if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 0) {
      throw new RangeError("drainTimeoutMs must be a non-negative safe integer");
    }

    this.drainTimeoutMs = drainTimeoutMs;
  }

  snapshot(): OwnershipSnapshot {
    return {
      state: this.state,
      generation: this.generation,
      owner: this.owner,
      ownerViewerSessionId: this.ownerViewerSessionId,
    };
  }

  acquireAgentLease(operationId: string): Lease {
    if (this.state !== "agent-ready") {
      throw this.manualControlError();
    }
    if (this.lifecycleFenced) {
      throw tabGoblinError("busy", "The browser runtime is changing lifecycle state.");
    }
    if (this.activeLease) {
      throw tabGoblinError("busy", "Another browser operation is already in progress.");
    }

    const activeLease: ActiveLease = {
      generation: this.generation,
      operationId,
      token: Symbol(operationId),
    };
    this.activeLease = activeLease;
    this.owner = "agent";

    let settled = false;
    return {
      generation: activeLease.generation,
      operationId: activeLease.operationId,
      release: (_outcome) => {
        if (settled) return;
        settled = true;
        this.releaseLease(activeLease);
      },
      abandonUncertain: () => {
        if (settled) return;
        settled = true;
        this.abandonLease(activeLease);
      },
    };
  }

  async requestTakeControl(viewerSessionId: string): Promise<OwnershipSnapshot> {
    if (this.lifecycleFenced) {
      throw this.manualControlError();
    }
    if (this.state !== "agent-ready") {
      throw this.manualControlError();
    }

    this.state = "taking-control";
    this.owner = null;
    this.ownerViewerSessionId = null;

    const lease = this.activeLease;
    if (lease) {
      const outcome = await this.waitForDrain(lease);
      if (outcome !== "released") {
        this.enterNeedsAttention();
        throw tabGoblinError(
          "timeout_uncertain",
          "The in-flight browser operation could not be proven finished; restart the session before continuing.",
        );
      }
    }

    if (this.state !== "taking-control") {
      this.enterNeedsAttention();
      throw tabGoblinError(
        "timeout_uncertain",
        "The ownership transition could not be completed safely; restart the session before continuing.",
      );
    }

    this.advanceGeneration();
    this.state = "manual";
    this.owner = "viewer";
    this.ownerViewerSessionId = viewerSessionId;
    return this.snapshot();
  }

  async returnToAgent(): Promise<OwnershipSnapshot> {
    if (this.lifecycleFenced) {
      throw this.manualControlError();
    }
    if (this.state !== "manual") {
      throw this.manualControlError();
    }

    this.state = "returning-control";
    this.owner = null;
    this.ownerViewerSessionId = null;
    this.advanceGeneration();

    this.state = "agent-ready";
    return this.snapshot();
  }

  reclaim(viewerSessionId: string): OwnershipSnapshot {
    if (this.lifecycleFenced) {
      throw this.manualControlError();
    }
    if (this.state !== "manual") {
      throw this.manualControlError();
    }

    this.owner = null;
    this.ownerViewerSessionId = null;
    this.advanceGeneration();

    this.owner = "viewer";
    this.ownerViewerSessionId = viewerSessionId;
    return this.snapshot();
  }

  mayViewerSendInput(viewerSessionId: string): boolean {
    return !this.lifecycleFenced
      && this.state === "manual"
      && this.ownerViewerSessionId === viewerSessionId;
  }

  async beginRuntimeTransition(): Promise<void> {
    if (!this.lifecycleFenced) {
      const priorState = this.state;
      this.lifecycleIntent = priorState === "manual"
        ? { state: "manual", ownerViewerSessionId: this.ownerViewerSessionId }
        : { state: "agent-ready", ownerViewerSessionId: null };
      this.lifecycleFenced = true;
      this.advanceGeneration();
      if (priorState !== "agent-ready" && priorState !== "manual") {
        this.enterNeedsAttention();
        throw tabGoblinError(
          "timeout_uncertain",
          "The ownership transition could not be fenced safely; restart the session before continuing.",
        );
      }
    }

    const lease = this.activeLease;
    if (!lease) return;
    const outcome = await this.waitForDrain(lease);
    if (outcome !== "released") {
      this.enterNeedsAttention();
      throw tabGoblinError(
        "timeout_uncertain",
        "The in-flight browser operation could not be proven finished; restart the session before continuing.",
      );
    }
  }

  completeRuntimeTransition(): OwnershipSnapshot {
    if (!this.lifecycleFenced || !this.lifecycleIntent || this.activeLease) {
      this.enterNeedsAttention();
      throw tabGoblinError(
        "timeout_uncertain",
        "The browser runtime transition could not be completed safely.",
      );
    }

    const intent = this.lifecycleIntent;
    this.state = intent.state;
    this.owner = intent.state === "manual" ? "viewer" : null;
    this.ownerViewerSessionId = intent.ownerViewerSessionId;
    this.lifecycleIntent = null;
    this.lifecycleFenced = false;
    return this.snapshot();
  }

  onGenerationChange(listener: (generation: number) => void): () => void {
    this.generationListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.generationListeners.delete(listener);
    };
  }

  private releaseLease(lease: ActiveLease): void {
    if (this.activeLease?.token !== lease.token) return;

    this.activeLease = null;
    if (this.state === "agent-ready") {
      this.owner = null;
    }
    this.settleDrainWaiter(lease, "released");
  }

  private abandonLease(lease: ActiveLease): void {
    if (this.activeLease?.token !== lease.token) return;

    this.activeLease = null;
    this.enterNeedsAttention();
    this.settleDrainWaiter(lease, "uncertain");
  }

  private waitForDrain(lease: ActiveLease): Promise<DrainOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (outcome: DrainOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.drainWaiter?.token === lease.token) {
          this.drainWaiter = null;
        }
        if (outcome === "timeout") {
          if (this.activeLease?.token === lease.token) this.activeLease = null;
          this.enterNeedsAttention();
        }
        resolve(outcome);
      };
      const timer = setTimeout(() => settle("timeout"), this.drainTimeoutMs);
      this.drainWaiter = { token: lease.token, settle };
    });
  }

  private settleDrainWaiter(lease: ActiveLease, outcome: DrainOutcome): void {
    if (this.drainWaiter?.token === lease.token) {
      this.drainWaiter.settle(outcome);
    }
  }

  private advanceGeneration(): void {
    this.generation += 1;

    let listenerFailed = false;
    for (const listener of [...this.generationListeners]) {
      try {
        listener(this.generation);
      } catch {
        listenerFailed = true;
      }
    }
    if (listenerFailed) {
      this.enterNeedsAttention();
      throw tabGoblinError(
        "timeout_uncertain",
        "Browser references could not be invalidated safely; restart the session before continuing.",
      );
    }
  }

  private enterNeedsAttention(): void {
    this.state = "needs-attention";
    this.owner = null;
    this.ownerViewerSessionId = null;
  }

  private manualControlError(): TabGoblinError {
    return tabGoblinError(
      "manual_control",
      "Browser control is not available to agents during the current ownership state.",
    );
  }
}
