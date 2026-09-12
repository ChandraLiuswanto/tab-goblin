import { describe, expect, it } from "vitest";
import { ActivityRecordSchema } from "@tab-goblin/protocol";
import { ActivityFeed } from "../src/activity-feed.js";

describe("ActivityFeed", () => {
  it("replaces a streaming record by operation identity instead of appending", () => {
    const feed = new ActivityFeed();
    feed.begin({ operationId: "op-1", source: "agent:a1", tabId: "t1", action: "click" });
    feed.finish("op-1", { status: "ok" });

    expect(feed.list()).toHaveLength(1);
    expect(feed.list()[0]).toMatchObject({ status: "ok", operationId: "op-1" });
  });

  it("returns records newest-first and caps even a requested oversized limit at 200", () => {
    const feed = new ActivityFeed(500);
    for (let index = 0; index < 250; index += 1) {
      feed.begin({
        operationId: "op-" + index,
        source: "agent:a1",
        tabId: null,
        action: "navigate",
      });
      feed.finish("op-" + index, { status: "ok" });
    }

    const list = feed.list();
    expect(list).toHaveLength(200);
    expect(list[0].operationId).toBe("op-249");
    expect(list.at(-1)?.operationId).toBe("op-50");
    expect(list.some((record) => record.operationId === "op-49")).toBe(false);
  });

  it("redacts URL credentials/query/fragment and bounds Unicode titles safely", () => {
    const feed = new ActivityFeed();
    feed.begin({ operationId: "op-1", source: "agent:a1", tabId: "t1", action: "navigate" });
    feed.finish("op-1", {
      status: "ok",
      url: "https://user:pw@example.com/a?token=abc#fragment",
      title: "x".repeat(198) + "😀tail\u0000\ud800",
    });

    const record = feed.list()[0];
    expect(record.url).toBe("https://example.com/a");
    expect(record.title).toHaveLength(199);
    expect(record.title).toBe("x".repeat(198) + "…");
    expect(record.title).not.toMatch(/[\u0000\ud800-\udfff]/u);
    expect(ActivityRecordSchema.parse(record)).toEqual(record);
  });

  it("rejects oversized raw metadata before sanitization can shrink it", () => {
    const feed = new ActivityFeed();
    feed.begin({ operationId: "op-1", source: "agent:a1", tabId: "t1", action: "navigate" });

    expect(() =>
      feed.finish("op-1", {
        status: "ok",
        url: "https://example.com/?secret=" + "x".repeat(4096),
      }),
    ).toThrow();
    expect(() =>
      feed.finish("op-1", {
        status: "ok",
        title: "x".repeat(4097),
      }),
    ).toThrow();
    expect(feed.list()[0]).toMatchObject({ status: "running", url: null, title: null });
  });

  it("strictly rejects unexpected begin fields rather than storing sensitive data", () => {
    const feed = new ActivityFeed();
    const unsafe = {
      operationId: "op-1",
      source: "agent:a1",
      tabId: "t1",
      action: "fill",
      value: "top-secret",
    };

    expect(() => feed.begin(unsafe)).toThrow();
    expect(feed.list()).toEqual([]);
    expect(JSON.stringify(feed.list())).not.toContain("top-secret");
  });

  it("records only the structured failure code and ignores unknown completions", () => {
    const feed = new ActivityFeed();
    feed.finish("missing", {
      status: "error",
      code: "stale_ref",
      title: "must not create a record",
    });
    feed.begin({ operationId: "op-1", source: "agent:a1", tabId: "t1", action: "click" });
    feed.finish("op-1", { status: "error", code: "stale_ref" });

    expect(feed.list()).toHaveLength(1);
    expect(feed.list()[0]).toMatchObject({ status: "error", code: "stale_ref" });
  });

  it("returns defensive record copies and can be cleared", () => {
    const feed = new ActivityFeed();
    feed.begin({ operationId: "op-1", source: "agent:a1", tabId: null, action: "tabs" });
    const listed = feed.list();
    listed[0].action = "tampered";

    expect(feed.list()[0].action).toBe("tabs");
    feed.clear();
    expect(feed.list()).toEqual([]);
  });

  it("validates custom limits", () => {
    expect(() => new ActivityFeed(-1)).toThrow(RangeError);
    expect(() => new ActivityFeed(1.5)).toThrow(RangeError);

    const disabled = new ActivityFeed(0);
    disabled.begin({ operationId: "op-1", source: "agent:a1", tabId: null, action: "tabs" });
    expect(disabled.list()).toEqual([]);
  });
});
