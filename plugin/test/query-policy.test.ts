import { focusManager, onlineManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { manualQueryPolicy, refreshAfterSuccessfulAction, refreshPanelQueries } from "../client/panel-model.js";

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
});

describe("manual panel refresh policy", () => {
  it("fetches initially but makes no idle RPCs on focus, reconnect, or elapsed fake time", async () => {
    expect(manualQueryPolicy).toEqual({
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchInterval: false,
    });
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const queryFn = vi.fn().mockResolvedValue({ ok: true });
    const observer = new QueryObserver(queryClient, { queryKey: ["tabgoblin", "status", "host", "ws"], queryFn, ...manualQueryPolicy });
    const unsubscribe = observer.subscribe(() => undefined);
    await tick();
    expect(queryFn).toHaveBeenCalledTimes(1);

    focusManager.setFocused(false);
    focusManager.setFocused(true);
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
    await tick();
    expect(queryFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await tick();
    expect(queryFn).toHaveBeenCalledTimes(1);

    observer.setOptions({ queryKey: ["tabgoblin", "status", "host", "ws-2"], queryFn, ...manualQueryPolicy });
    await tick();
    expect(queryFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(queryFn).toHaveBeenCalledTimes(2);

    await observer.refetch();
    expect(queryFn).toHaveBeenCalledTimes(3);
    unsubscribe();
    queryClient.clear();
  });

  it("explicit refresh rereads config, status, activity, then tabs only for a fresh ready status", async () => {
    const order: string[] = [];
    const refetchers = {
      config: vi.fn(async () => { order.push("config"); return {}; }),
      status: vi.fn(async () => { order.push("status"); return { isSuccess: true as const, data: { ok: true as const, status: { sessionState: "ready" } } }; }),
      tabs: vi.fn(async () => { order.push("tabs"); return {}; }),
      activity: vi.fn(async () => { order.push("activity"); return {}; }),
    };
    await refreshPanelQueries(refetchers);
    expect(refetchers.config).toHaveBeenCalledOnce();
    expect(refetchers.status).toHaveBeenCalledOnce();
    expect(refetchers.activity).toHaveBeenCalledOnce();
    expect(refetchers.tabs).toHaveBeenCalledOnce();
    expect(order.at(-1)).toBe("tabs");
  });

  it("does not fetch tabs when a failed status refetch retains stale ready data", async () => {
    const refetchers = {
      config: vi.fn(async () => ({})),
      status: vi.fn(async () => ({ isSuccess: false as const, data: { ok: true as const, status: { sessionState: "ready" } } })),
      tabs: vi.fn(async () => ({})),
      activity: vi.fn(async () => ({})),
    };
    await refreshPanelQueries(refetchers);
    expect(refetchers.status).toHaveBeenCalledOnce();
    expect(refetchers.tabs).not.toHaveBeenCalled();
  });

  it("rereads after successful mutations but never after a failed action", async () => {
    const refetchers = {
      config: vi.fn(async () => ({})),
      status: vi.fn(async () => ({ isSuccess: true as const, data: { ok: true as const, status: { sessionState: "stopped" } } })),
      tabs: vi.fn(async () => ({})),
      activity: vi.fn(async () => ({})),
    };
    await expect(refreshAfterSuccessfulAction({ ok: false }, refetchers)).resolves.toBe(false);
    expect(refetchers.status).not.toHaveBeenCalled();
    await expect(refreshAfterSuccessfulAction({ ok: true }, refetchers)).resolves.toBe(true);
    expect(refetchers.config).toHaveBeenCalledOnce();
    expect(refetchers.status).toHaveBeenCalledOnce();
    expect(refetchers.activity).toHaveBeenCalledOnce();
    expect(refetchers.tabs).not.toHaveBeenCalled();
  });
});
