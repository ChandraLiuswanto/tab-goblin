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
  it("blocks new agent commands synchronously before an in-flight lease drains", async () => {
    const controller = new OwnershipController();
    const lease = controller.acquireAgentLease("op-1");

    const takeover = controller.requestTakeControl("viewer-1");
    expect(controller.snapshot()).toMatchObject({ state: "taking-control", owner: null });
    expect(() => controller.acquireAgentLease("op-2")).toThrow(
      expect.objectContaining({ code: "manual_control", retryable: false }),
    );
    expect(controller.mayViewerSendInput("viewer-1")).toBe(false);

    lease.release("ok");
    await expect(takeover).resolves.toMatchObject({ state: "manual", owner: "viewer" });
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
  it("revokes viewer input and notifies listeners before publishing agent-ready", async () => {
    const controller = new OwnershipController();
    const observed: Array<{ generation: number; state: string; viewerMayInput: boolean }> = [];
    controller.onGenerationChange((generation) => {
      observed.push({
        generation,
        state: controller.snapshot().state,
        viewerMayInput: controller.mayViewerSendInput("viewer-1"),
      });
    });
    await controller.requestTakeControl("viewer-1");
    const before = controller.snapshot().generation;

    const result = await controller.returnToAgent();

    expect(result).toMatchObject({
      state: "agent-ready",
      generation: before + 1,
      owner: null,
      ownerViewerSessionId: null,
    });
    expect(observed).toEqual([
      { generation: before + 1, state: "returning-control", viewerMayInput: false },
    ]);
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
