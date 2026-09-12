import { describe, expect, it, vi } from "vitest";
import { cleanupPlugin } from "../index.server.js";

describe("plugin shutdown", () => {
  it("returns the cleanup promise and closes the gateway only after delayed cleanup settles", async () => {
    let resolve!: () => void;
    const delayed = new Promise<void>((done) => { resolve = done; });
    const cleanupHooks = vi.fn(); const lifecycle = { cleanup: vi.fn(() => delayed) }; const gateway = { close: vi.fn() };

    const completion = cleanupPlugin(cleanupHooks, lifecycle as never, gateway);
    expect(completion).toBeInstanceOf(Promise);
    expect(cleanupHooks).toHaveBeenCalledOnce();
    expect(gateway.close).not.toHaveBeenCalled();
    resolve();
    await completion;
    expect(gateway.close).toHaveBeenCalledOnce();
  });
});
