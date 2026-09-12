import { describe, expect, it, vi } from "vitest";
import { createAdminServer } from "../src/admin-server.js";
import { EnrollmentRegistry } from "../src/enrollment.js";
import { createWorkspaceServices } from "../src/main.js";
import { PairingCodes } from "../src/pairing.js";

const enrollmentNonce = "11111111-1111-4111-8111-111111111111";

const endpoints = {
  containerName: "tabgoblin-ws",
  volumeName: "tabgoblin-profile-ws",
  cdpUrl: "http://127.0.0.1:9222",
  vncHost: "127.0.0.1",
  vncPort: 5900,
};

function runtimeHarness() {
  let state: "stopped" | "ready" = "stopped";
  const runtime = {
    state: vi.fn(() => state),
    endpoints: vi.fn(() => state === "ready" ? endpoints : null),
    start: vi.fn(async () => {
      state = "ready";
      return endpoints;
    }),
    stop: vi.fn(async () => {
      state = "stopped";
    }),
    stageFile: vi.fn(),
  };
  return { runtime, setState(value: "stopped" | "ready") { state = value; } };
}

function fakeSession() {
  return {
    invalidateRefs: vi.fn(),
    close: vi.fn(async () => undefined),
  };
}

describe("workspace runtime lifecycle", () => {
  it("reattaches after stop and ready even when CDP reuses the same URL", async () => {
    const { runtime } = runtimeHarness();
    const sessions = [fakeSession(), fakeSession()];
    const attachBrowser = vi.fn(async () => sessions[attachBrowser.mock.calls.length - 1] as never);
    const services = createWorkspaceServices({
      runtime: runtime as never,
      pairing: new PairingCodes(),
      viewerUrl: null,
      attachBrowser,
    });

    await services.start("ws-1");
    const first = await services.browser("ws-1");
    await services.stop("ws-1");
    await services.start("ws-1");
    const second = await services.browser("ws-1");

    expect(first).not.toBe(second);
    expect(attachBrowser).toHaveBeenCalledTimes(2);
    expect(attachBrowser).toHaveBeenNthCalledWith(1, endpoints.cdpUrl);
    expect(attachBrowser).toHaveBeenNthCalledWith(2, endpoints.cdpUrl);
    expect(sessions[0].close).toHaveBeenCalledOnce();
  });

  it("rejects and closes an attachment that resolves after its lifecycle was fenced", async () => {
    const { runtime } = runtimeHarness();
    let finishAttach!: (session: ReturnType<typeof fakeSession>) => void;
    const attaching = new Promise<ReturnType<typeof fakeSession>>((resolve) => { finishAttach = resolve; });
    const session = fakeSession();
    const services = createWorkspaceServices({
      runtime: runtime as never,
      pairing: new PairingCodes(),
      viewerUrl: null,
      attachBrowser: vi.fn(() => attaching as never),
    });
    await services.start("ws-1");

    const pendingBrowser = services.browser("ws-1");
    await services.stop("ws-1");
    finishAttach(session);

    await expect(pendingBrowser).rejects.toThrow(/lifecycle|ready/i);
    await vi.waitFor(() => expect(session.close).toHaveBeenCalledOnce());
  });

  it("fails closed when stop races a dispatched mutation that cannot prove completion", async () => {
    vi.useFakeTimers();
    const { runtime } = runtimeHarness();
    const session = {
      ...fakeSession(),
      act: vi.fn(() => new Promise<void>(() => undefined)),
    };
    const services = createWorkspaceServices({
      runtime: runtime as never,
      pairing: new PairingCodes(),
      viewerUrl: null,
      attachBrowser: vi.fn(async () => session as never),
    });
    const enrollment = new EnrollmentRegistry();
    enrollment.record(enrollmentNonce, "/workspace", "ws-1");
    enrollment.bind(enrollmentNonce, "/workspace", "agent-1", "ws-1");
    enrollment.noteSessionOpen("agent-1", "ws-1", "interactive");
    const admin = createAdminServer({ services, enrollment, socketPath: "/tmp/unused-workspace.sock" });

    try {
      await services.start("ws-1");
      const mutation = admin.handle({
        op: "tool",
        enrollment: enrollmentNonce,
        workspaceId: "ws-1",
        source: "test",
        name: "tabgoblin_click",
        input: { tabId: "t1", ref: "r1-e0" },
      });
      await vi.waitFor(() => expect(session.act).toHaveBeenCalledOnce());
      const stopping = admin.handle({ op: "stop", workspaceId: "ws-1" });

      await vi.advanceTimersByTimeAsync(15_000);
      await expect(stopping).resolves.toMatchObject({
        ok: false,
        error: { code: "timeout_uncertain", retryable: false },
      });
      expect(runtime.stop).toHaveBeenCalledWith("ws-1");
      expect(services.ownership("ws-1").snapshot().state).toBe("needs-attention");

      await vi.advanceTimersByTimeAsync(5_000);
      await expect(mutation).resolves.toMatchObject({
        ok: false,
        error: { code: "timeout_uncertain", retryable: false },
      });

      await services.start("ws-1");
      expect(services.ownership("ws-1").snapshot().state).toBe("agent-ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks an unproven concurrent lease uncertain, stops, and requires explicit restart recovery", async () => {
    vi.useFakeTimers();
    const { runtime } = runtimeHarness();
    const session = fakeSession();
    const services = createWorkspaceServices({
      runtime: runtime as never,
      pairing: new PairingCodes(),
      viewerUrl: null,
      attachBrowser: vi.fn(async () => session as never),
    });

    try {
      await services.start("ws-1");
      await services.browser("ws-1");
      const ownership = services.ownership("ws-1");
      const staleLease = ownership.acquireAgentLease("mutation-1");
      const stopping = services.stop("ws-1");
      await vi.advanceTimersByTimeAsync(15_000);

      await expect(stopping).rejects.toMatchObject({ code: "timeout_uncertain" });
      expect(runtime.stop).toHaveBeenCalledWith("ws-1");
      expect(ownership.snapshot().state).toBe("needs-attention");
      expect(() => ownership.acquireAgentLease("mutation-2")).toThrow();

      staleLease.release("ok");
      expect(ownership.snapshot().state).toBe("needs-attention");

      await services.start("ws-1");
      expect(ownership.snapshot().state).toBe("agent-ready");
      const recovered = ownership.acquireAgentLease("mutation-3");
      recovered.release("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks manual viewer input throughout stop and preserves the owner for a fresh start", async () => {
    const { runtime, setState } = runtimeHarness();
    let finishStop!: () => void;
    runtime.stop.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishStop = () => {
        setState("stopped");
        resolve();
      };
    }));
    const services = createWorkspaceServices({
      runtime: runtime as never,
      pairing: new PairingCodes(),
      viewerUrl: null,
      attachBrowser: vi.fn(async () => fakeSession() as never),
    });
    await services.start("ws-1");
    const ownership = services.ownership("ws-1");
    await ownership.requestTakeControl("viewer-1");

    const stopping = services.stop("ws-1");
    await vi.waitFor(() => expect(runtime.stop).toHaveBeenCalledOnce());
    expect(ownership.snapshot().ownerViewerSessionId).toBe("viewer-1");
    expect(ownership.mayViewerSendInput("viewer-1")).toBe(false);

    finishStop();
    await stopping;
    expect(ownership.mayViewerSendInput("viewer-1")).toBe(false);

    await services.start("ws-1");
    expect(ownership.snapshot().ownerViewerSessionId).toBe("viewer-1");
    expect(ownership.mayViewerSendInput("viewer-1")).toBe(true);
  });
});
