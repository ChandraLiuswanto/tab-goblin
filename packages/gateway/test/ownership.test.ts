import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnershipController } from "../src/ownership.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("agent leases", () => {
  it("starts agent-ready at generation 0 with no active owner", () => {
    expect(new OwnershipController().snapshot()).toEqual({
      state: "agent-ready",
      generation: 0,
      owner: null,
      ownerViewerSessionId: null,
    });
  });

  it("exposes the operation identity and current generation on a lease", () => {
    const controller = new OwnershipController();
    const lease = controller.acquireAgentLease("op-1");

    expect(lease).toMatchObject({ operationId: "op-1", generation: 0 });
    expect(controller.snapshot().owner).toBe("agent");
  });

  it("serializes agents with a retryable busy error instead of queueing", () => {
    const controller = new OwnershipController();
    controller.acquireAgentLease("op-1");

    expect(() => controller.acquireAgentLease("op-2")).toThrow(
      expect.objectContaining({ code: "busy", retryable: true }),
    );
  });

  it("allows the next command after release and makes release idempotent", () => {
    const controller = new OwnershipController();
    const first = controller.acquireAgentLease("op-1");
    first.release("ok");
    const second = controller.acquireAgentLease("op-2");

    first.release("error");
    expect(() => controller.acquireAgentLease("op-3")).toThrow(
      expect.objectContaining({ code: "busy" }),
    );
    second.release("error");
    expect(controller.snapshot().owner).toBeNull();
  });

  it("fails closed when an operation's completion is uncertain", () => {
    const controller = new OwnershipController();
    const lease = controller.acquireAgentLease("op-1");

    lease.abandonUncertain();

    expect(controller.snapshot()).toMatchObject({ state: "needs-attention", owner: null });
    expect(() => controller.acquireAgentLease("op-2")).toThrow(
      expect.objectContaining({ code: "manual_control", retryable: false }),
    );
    lease.release("ok");
    expect(controller.snapshot().state).toBe("needs-attention");
  });
});

describe("taking control", () => {
  it("blocks new agents and preserves the active lease generation until drain completes", async () => {
    const controller = new OwnershipController();
    const generations: number[] = [];
    controller.onGenerationChange((generation) => generations.push(generation));
    const lease = controller.acquireAgentLease("op-1");

    const takeover = controller.requestTakeControl("viewer-1");
    expect(controller.snapshot()).toMatchObject({
      state: "taking-control",
      generation: lease.generation,
      owner: null,
    });
    expect(generations).toEqual([]);
    expect(() => controller.acquireAgentLease("op-2")).toThrow(
      expect.objectContaining({ code: "manual_control", retryable: false }),
    );
    expect(controller.mayViewerSendInput("viewer-1")).toBe(false);

    lease.release("ok");
    await expect(takeover).resolves.toMatchObject({
      state: "manual",
      generation: lease.generation + 1,
      owner: "viewer",
    });
    expect(generations).toEqual([lease.generation + 1]);
    expect(controller.mayViewerSendInput("viewer-1")).toBe(true);
  });

  it("does not let a racing takeover replace the viewer currently draining", async () => {
    const controller = new OwnershipController();
    const lease = controller.acquireAgentLease("op-1");
    const firstTakeover = controller.requestTakeControl("viewer-1");

    await expect(controller.requestTakeControl("viewer-2")).rejects.toMatchObject({
      code: "manual_control",
      retryable: false,
    });
    lease.release("ok");
    await firstTakeover;

    expect(controller.mayViewerSendInput("viewer-1")).toBe(true);
    expect(controller.mayViewerSendInput("viewer-2")).toBe(false);
  });

  it("times out to needs-attention and never resumes after a late release", async () => {
    vi.useFakeTimers();
    const controller = new OwnershipController({ drainTimeoutMs: 25, now: () => Date.now() });
    const lease = controller.acquireAgentLease("op-1");
    const takeover = controller.requestTakeControl("viewer-1");
    const rejection = expect(takeover).rejects.toMatchObject({
      code: "timeout_uncertain",
      retryable: false,
    });

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(controller.snapshot()).toMatchObject({ state: "needs-attention", owner: null });
    expect(controller.mayViewerSendInput("viewer-1")).toBe(false);

    lease.release("ok");
    await vi.runAllTimersAsync();
    expect(controller.snapshot().state).toBe("needs-attention");
    expect(() => controller.acquireAgentLease("op-2")).toThrow(
      expect.objectContaining({ code: "manual_control" }),
    );
    await expect(controller.returnToAgent()).rejects.toMatchObject({ code: "manual_control" });
  });

  it("does not extend the configured drain timeout when the wall clock rolls backward", async () => {
    vi.useFakeTimers();
    const clockReadings = [1_000, -999_000];
    const controller = new OwnershipController({
      drainTimeoutMs: 15_000,
      now: () => clockReadings.shift() ?? -999_000,
    });
    controller.acquireAgentLease("op-1");
    const rejection = controller.requestTakeControl("viewer-1").catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(15_000);

    expect(controller.snapshot().state).toBe("needs-attention");
    await expect(rejection).resolves.toMatchObject({ code: "timeout_uncertain" });
  });

  it("fails the takeover immediately if the draining lease becomes uncertain", async () => {
    const controller = new OwnershipController({ drainTimeoutMs: 60_000 });
    const lease = controller.acquireAgentLease("op-1");
    const takeover = controller.requestTakeControl("viewer-1");

    lease.abandonUncertain();

    await expect(takeover).rejects.toMatchObject({ code: "timeout_uncertain" });
    expect(controller.snapshot().state).toBe("needs-attention");
  });
});

describe("manual control", () => {
  it("allows only the owning viewer to send input", async () => {
    const controller = new OwnershipController();
    await controller.requestTakeControl("viewer-1");

    expect(controller.mayViewerSendInput("viewer-1")).toBe(true);
    expect(controller.mayViewerSendInput("viewer-2")).toBe(false);
    expect(() => controller.acquireAgentLease("op-9")).toThrow(
      expect.objectContaining({ code: "manual_control", retryable: false }),
    );
  });

  it("requires explicit reclaim and immediately revokes the prior viewer", async () => {
    const controller = new OwnershipController();
    await controller.requestTakeControl("viewer-1");

    expect(controller.reclaim("viewer-2")).toMatchObject({
      state: "manual",
      ownerViewerSessionId: "viewer-2",
    });
    expect(controller.mayViewerSendInput("viewer-1")).toBe(false);
    expect(controller.mayViewerSendInput("viewer-2")).toBe(true);
  });

  it("does not silently return control without an explicit API call", async () => {
    vi.useFakeTimers();
    const controller = new OwnershipController();
    await controller.requestTakeControl("viewer-1");

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);

    expect(controller.snapshot()).toMatchObject({
      state: "manual",
      owner: "viewer",
      ownerViewerSessionId: "viewer-1",
    });
  });
});

describe("generation changes", () => {
  it("advances and notifies before publishing each takeover, reclaim, and return authority", async () => {
    const controller = new OwnershipController();
    const observed: Array<{
      generation: number;
      state: string;
      ownerViewerSessionId: string | null;
    }> = [];
    controller.onGenerationChange((generation) => {
      const snapshot = controller.snapshot();
      observed.push({
        generation,
        state: snapshot.state,
        ownerViewerSessionId: snapshot.ownerViewerSessionId,
      });
    });

    const takeover = await controller.requestTakeControl("viewer-1");
    const reclaim = controller.reclaim("viewer-2");
    const returned = await controller.returnToAgent();

    expect([takeover.generation, reclaim.generation, returned.generation]).toEqual([1, 2, 3]);
    expect(takeover).toMatchObject({
      state: "manual",
      owner: "viewer",
      ownerViewerSessionId: "viewer-1",
    });
    expect(reclaim).toMatchObject({
      state: "manual",
      owner: "viewer",
      ownerViewerSessionId: "viewer-2",
    });
    expect(returned).toMatchObject({
      state: "agent-ready",
      owner: null,
      ownerViewerSessionId: null,
    });
    expect(observed).toEqual([
      { generation: 1, state: "taking-control", ownerViewerSessionId: null },
      { generation: 2, state: "manual", ownerViewerSessionId: null },
      { generation: 3, state: "returning-control", ownerViewerSessionId: null },
    ]);
  });

  it("fails closed if a takeover generation listener fails", async () => {
    const controller = new OwnershipController();
    const laterListener = vi.fn();
    controller.onGenerationChange(() => {
      throw new Error("listener failed");
    });
    controller.onGenerationChange(laterListener);

    await expect(controller.requestTakeControl("viewer-1")).rejects.toMatchObject({
      code: "timeout_uncertain",
      retryable: false,
    });

    expect(laterListener).toHaveBeenCalledWith(1);
    expect(controller.snapshot()).toMatchObject({
      state: "needs-attention",
      generation: 1,
      owner: null,
      ownerViewerSessionId: null,
    });
    expect(controller.mayViewerSendInput("viewer-1")).toBe(false);
  });

  it("fails closed if a reclaim generation listener fails", async () => {
    const controller = new OwnershipController();
    await controller.requestTakeControl("viewer-1");
    controller.onGenerationChange(() => {
      throw new Error("listener failed");
    });

    expect(() => controller.reclaim("viewer-2")).toThrow(
      expect.objectContaining({ code: "timeout_uncertain", retryable: false }),
    );

    expect(controller.snapshot()).toMatchObject({
      state: "needs-attention",
      generation: 2,
      owner: null,
      ownerViewerSessionId: null,
    });
    expect(controller.mayViewerSendInput("viewer-1")).toBe(false);
    expect(controller.mayViewerSendInput("viewer-2")).toBe(false);
  });

  it("preserves fail-closed return behavior if a generation listener fails", async () => {
    const controller = new OwnershipController();
    await controller.requestTakeControl("viewer-1");
    controller.onGenerationChange(() => {
      throw new Error("listener failed");
    });

    await expect(controller.returnToAgent()).rejects.toMatchObject({
      code: "timeout_uncertain",
      retryable: false,
    });

    expect(controller.snapshot()).toMatchObject({
      state: "needs-attention",
      generation: 2,
      owner: null,
      ownerViewerSessionId: null,
    });
    expect(() => controller.acquireAgentLease("op-2")).toThrow(
      expect.objectContaining({ code: "manual_control" }),
    );
  });

  it("supports unsubscribing generation listeners", async () => {
    const controller = new OwnershipController();
    const listener = vi.fn();
    const unsubscribe = controller.onGenerationChange(listener);
    unsubscribe();
    unsubscribe();

    await controller.requestTakeControl("viewer-1");
    await controller.returnToAgent();

    expect(listener).not.toHaveBeenCalled();
  });
});
