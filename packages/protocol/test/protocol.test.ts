import { describe, expect, it } from "vitest";
import {
  ACTIVITY_LIMIT,
  ActivityRecordSchema,
  ADMIN_SOCKET_ENV,
  AdminRequestSchema,
  AdminResponseSchema,
  boundedText,
  CSRF_HEADER,
  ENROLLMENT_ENV,
  ERROR_CODES,
  formatRef,
  isNavigableUrl,
  MCP_SERVER_NAME,
  NetworkDiagnosticSchema,
  NETWORK_DIAGNOSTIC_LIMIT,
  OWNERSHIP_STATES,
  PAIRING_CODE_TTL_MS,
  PairRequestSchema,
  PairResponseSchema,
  parseRef,
  redactUrl,
  SESSION_STATES,
  SessionStatusSchema,
  SnapshotSchema,
  TabGoblinErrorSchema,
  tabGoblinError,
  TOOL_NAMES,
  ToolInputSchemas,
  VIEWER_COOKIE,
  VIEWER_SESSION_TTL_MS,
  ViewerSessionSchema,
  ViewerStatusSchema,
} from "../src/index.js";

const NUL = String.fromCharCode(0);
const ESC = String.fromCharCode(27);
const C1_CSI = String.fromCharCode(155);
const HIGH_SURROGATE = String.fromCharCode(0xd83d);
const LOW_SURROGATE = String.fromCharCode(0xde00);
const REPLACEMENT = String.fromCharCode(0xfffd);
const ELLIPSIS = String.fromCharCode(8230);

describe("redactUrl", () => {
  it("strips userinfo, query and fragment", () => {
    expect(redactUrl("https://alice:secret@example.com/a/b?token=xyz#frag")).toBe(
      "https://example.com/a/b",
    );
  });

  it("keeps a non-default port", () => {
    expect(redactUrl("http://127.0.0.1:8931/login?next=/x")).toBe(
      "http://127.0.0.1:8931/login",
    );
  });

  it("returns a safe placeholder for invalid or unsafe protocols", () => {
    expect(redactUrl("not a url")).toBe("about:invalid");
    expect(redactUrl("file:///etc/passwd")).toBe("about:invalid");
  });
});

describe("isNavigableUrl", () => {
  it.each(["https://example.com", "http://127.0.0.1:3000/x"])('accepts "%s"', (url) => {
    expect(isNavigableUrl(url)).toBe(true);
  });

  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,<b>x</b>",
    "chrome://settings",
    "about:blank",
    "not a url",
  ])('rejects "%s"', (url) => {
    expect(isNavigableUrl(url)).toBe(false);
  });
});

describe("boundedText", () => {
  it("reserves space for the truncation marker", () => {
    expect(boundedText("abcdefghij", 5)).toBe("abcd" + ELLIPSIS);
    expect(boundedText("abcdefghij", 5)).toHaveLength(5);
  });

  it("handles zero and one-character caps without exceeding them", () => {
    expect(boundedText("abc", 0)).toBe("");
    expect(boundedText("abc", 1)).toBe(ELLIPSIS);
  });

  it("leaves text at or below the cap alone", () => {
    expect(boundedText("abcde", 5)).toBe("abcde");
    expect(boundedText("abc", 5)).toBe("abc");
  });

  it("strips C0, DEL, and C1 control characters before applying the cap", () => {
    expect(boundedText("a" + NUL + "b" + ESC + "c" + C1_CSI + "d", 4)).toBe("abcd");
  });

  it("does not split a surrogate pair while truncating to a UTF-16 schema cap", () => {
    const result = boundedText("123😀SECRET", 5);

    expect(result).toBe("123" + ELLIPSIS);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("replaces lone surrogates while preserving valid pairs", () => {
    expect(boundedText("a" + HIGH_SURROGATE + "b" + LOW_SURROGATE + "c", 10)).toBe(
      "a" + REPLACEMENT + "b" + REPLACEMENT + "c",
    );
    expect(boundedText(HIGH_SURROGATE + LOW_SURROGATE, 2)).toBe(
      HIGH_SURROGATE + LOW_SURROGATE,
    );
  });

  it.each([
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    "rejects invalid max %s",
    (max) => {
      expect(() => boundedText("abc", max)).toThrow(RangeError);
    },
  );

  it("produces values accepted by downstream 40 and 200 character schema caps", () => {
    const result = ActivityRecordSchema.safeParse({
      operationId: "op1",
      source: "agent:a1",
      tabId: "t1",
      action: boundedText("a".repeat(41), 40),
      status: "ok",
      startedAt: "2026-09-12T00:00:00.000Z",
      endedAt: null,
      code: null,
      url: "https://x/",
      title: boundedText("t".repeat(201), 200),
    });

    expect(result.success).toBe(true);
  });
});

describe("structured errors", () => {
  it("uses safe retry defaults", () => {
    expect(tabGoblinError("manual_control", "User has control")).toEqual({
      code: "manual_control",
      message: "User has control",
      retryable: false,
    });
    expect(tabGoblinError("runtime_unavailable", "Restart the session").retryable).toBe(true);
    expect(tabGoblinError("timeout_uncertain", "Inspect state before retrying").retryable).toBe(
      false,
    );
  });

  it("allows callers to disable safe retries but never enable unsafe retries", () => {
    expect(tabGoblinError("busy", "Try later", false).retryable).toBe(false);
    expect(tabGoblinError("timeout_uncertain", "unknown result", true).retryable).toBe(false);
  });

  it("rejects forged unsafe retry flags at the wire boundary", () => {
    expect(
      TabGoblinErrorSchema.safeParse({
        code: "timeout_uncertain",
        message: "unknown result",
        retryable: true,
      }).success,
    ).toBe(false);
    expect(
      TabGoblinErrorSchema.safeParse({ code: "busy", message: "Try later", retryable: true })
        .success,
    ).toBe(true);
  });

  it("uses the full schema allowance when bounding long messages", () => {
    const error = tabGoblinError("invalid_input", "x".repeat(401));

    expect(error.message).toHaveLength(400);
    expect(error.message.endsWith(ELLIPSIS)).toBe(true);
    expect(TabGoblinErrorSchema.safeParse(error).success).toBe(true);
  });

  it("bounds messages and rejects unknown codes", () => {
    expect(ERROR_CODES).toContain("timeout_uncertain");
    expect(
      TabGoblinErrorSchema.safeParse({ code: "unknown", message: "x", retryable: false }).success,
    ).toBe(false);
    expect(
      TabGoblinErrorSchema.safeParse({
        code: "busy",
        message: "x".repeat(401),
        retryable: true,
      }).success,
    ).toBe(false);
  });
});

describe("refs", () => {
  it("round-trips", () => {
    expect(parseRef(formatRef(7, 12))).toEqual({ revision: 7, index: 12 });
  });

  it.each(["e12", "r1-e-1", "r0-e1", "r1.5-e2", "r99999999999999999999-e1"])(
    'rejects invalid or unsafe ref "%s"',
    (ref) => {
      expect(parseRef(ref)).toBeNull();
    },
  );
});

describe("session and snapshot schemas", () => {
  it("exports the specified lifecycle states", () => {
    expect(OWNERSHIP_STATES).toEqual([
      "agent-ready",
      "taking-control",
      "manual",
      "returning-control",
      "needs-attention",
    ]);
    expect(SESSION_STATES).toEqual(["stopped", "starting", "ready", "failed"]);
  });

  it("keeps generic session status separate from viewer-session ownership", () => {
    const genericStatus = {
      workspaceId: "w1",
      sessionState: "ready",
      ownership: { state: "agent-ready", generation: 1, owner: "agent" },
      startedAt: "2026-09-12T00:00:00.000Z",
      viewerUrl: null,
      lastError: null,
    };
    expect(SessionStatusSchema.parse(genericStatus)).toMatchObject({
      workspaceId: "w1",
      ownership: { generation: 1 },
    });
    expect(ViewerStatusSchema.parse(genericStatus).isOwner).toBe(false);
    expect(ViewerStatusSchema.parse({ ...genericStatus, isOwner: true }).isOwner).toBe(true);
    expect(ViewerStatusSchema.safeParse({ ...genericStatus, isOwner: "true" }).success).toBe(false);
  });

  it("rejects a snapshot over the node cap", () => {
    const nodes = Array.from({ length: 2001 }, (_, i) => ({
      ref: formatRef(1, i),
      role: "button",
      name: "x",
      depth: 0,
    }));
    expect(
      SnapshotSchema.safeParse({
        tabId: "t1",
        revision: 1,
        url: "https://x/",
        title: "t",
        nodes,
      }).success,
    ).toBe(false);
  });
});

describe("privacy-safe diagnostics", () => {
  it("rejects an activity record carrying a typed value", () => {
    const record = {
      operationId: "op1",
      source: "agent:a1",
      tabId: "t1",
      action: "fill",
      status: "ok",
      startedAt: "2026-09-12T00:00:00.000Z",
      endedAt: null,
      code: null,
      url: "https://x/",
      title: "t",
      value: "hunter2",
    };
    expect(ActivityRecordSchema.safeParse(record).success).toBe(false);
    expect(ACTIVITY_LIMIT).toBe(200);
  });

  it("redacts activity URLs and sanitizes bounded titles at the schema boundary", () => {
    const record = ActivityRecordSchema.parse({
      operationId: "op1",
      source: "agent:a1",
      tabId: "t1",
      action: "navigate",
      status: "ok",
      startedAt: "2026-09-12T00:00:00.000Z",
      endedAt: null,
      code: null,
      url: "https://alice:secret@example.com/a?token=secret#fragment",
      title: "safe" + C1_CSI + NUL + "t".repeat(300),
    });

    expect(record.url).toBe("https://example.com/a");
    expect(record.title).toHaveLength(200);
    expect(record.title).not.toContain(C1_CSI);
    expect(record.title).not.toContain(NUL);
    expect(record.title?.endsWith(ELLIPSIS)).toBe(true);
  });

  it.each([
    {
      field: "url",
      url: "https://example.com/a?" + "q".repeat(4097),
      title: null,
    },
    {
      field: "title",
      url: null,
      title: C1_CSI.repeat(4097),
    },
  ])("rejects oversized raw activity $field before sanitizing", ({ url, title }) => {
    expect(
      ActivityRecordSchema.safeParse({
        operationId: "op1",
        source: "agent:a1",
        tabId: "t1",
        action: "navigate",
        status: "ok",
        startedAt: "2026-09-12T00:00:00.000Z",
        endedAt: null,
        code: null,
        url,
        title,
      }).success,
    ).toBe(false);
  });

  it("keeps network diagnostics body-free and redacts their URL", () => {
    expect(
      NetworkDiagnosticSchema.parse({
        method: "POST",
        url: "https://alice:secret@x.test/a?token=secret#fragment",
        status: 201,
      }),
    ).toEqual({ method: "POST", url: "https://x.test/a", status: 201 });
    expect(
      NetworkDiagnosticSchema.safeParse({
        method: "POST",
        url: "https://x.test/a",
        status: 201,
        requestBody: "secret",
      }).success,
    ).toBe(false);
    expect(NETWORK_DIAGNOSTIC_LIMIT).toBe(100);
  });
});

describe("admin and viewer wire contracts", () => {
  it("exports stable environment and viewer constants", () => {
    expect({ ADMIN_SOCKET_ENV, ENROLLMENT_ENV, MCP_SERVER_NAME }).toEqual({
      ADMIN_SOCKET_ENV: "TABGOBLIN_SOCKET",
      ENROLLMENT_ENV: "TABGOBLIN_ENROLLMENT",
      MCP_SERVER_NAME: "tabgoblin",
    });
    expect({ VIEWER_COOKIE, CSRF_HEADER }).toEqual({
      VIEWER_COOKIE: "tg_viewer",
      CSRF_HEADER: "x-tabgoblin-csrf",
    });
    expect(PAIRING_CODE_TTL_MS).toBe(120_000);
    expect(VIEWER_SESSION_TTL_MS).toBe(43_200_000);
  });

  it("bounds and discriminates admin requests and responses", () => {
    expect(AdminRequestSchema.parse({ op: "status", workspaceId: "w1" })).toEqual({
      op: "status",
      workspaceId: "w1",
    });
    expect(
      AdminRequestSchema.safeParse({ op: "tool", workspaceId: "w1", name: "other", source: "a" })
        .success,
    ).toBe(false);
    expect(
      AdminResponseSchema.safeParse({
        ok: false,
        error: tabGoblinError("auth_failed", "Denied"),
      }).success,
    ).toBe(true);
  });

  it("validates pairing and viewer sessions", () => {
    expect(PairRequestSchema.safeParse({ code: "short" }).success).toBe(false);
    expect(
      PairResponseSchema.safeParse({ workspaceId: "w1", csrfToken: "csrf", viewOnly: true }).success,
    ).toBe(true);
    expect(
      ViewerSessionSchema.safeParse({
        sessionId: "s1",
        workspaceId: "w1",
        csrfToken: "csrf",
        expiresAt: Date.now() + 1000,
      }).success,
    ).toBe(true);
  });
});

describe("tool schemas", () => {
  it("defines a schema for every tool name", () => {
    expect(Object.keys(ToolInputSchemas)).toEqual([...TOOL_NAMES]);
  });

  it("applies bounded defaults", () => {
    expect(ToolInputSchemas.tabgoblin_network.parse({ tabId: "t1", maxEntries: 1 })).toEqual({
      tabId: "t1",
      maxEntries: 1,
    });
    expect(ToolInputSchemas.tabgoblin_logs.parse({ tabId: "t1" })).toEqual({
      tabId: "t1",
      maxEntries: 50,
    });
    expect(ToolInputSchemas.tabgoblin_navigate.parse({ tabId: "t1", url: "https://x.test" })).toEqual({
      tabId: "t1",
      url: "https://x.test",
      timeoutMs: 10_000,
    });
  });

  it("rejects oversized diagnostics and non-HTTP navigation", () => {
    expect(() =>
      ToolInputSchemas.tabgoblin_network.parse({ tabId: "t1", maxEntries: 101 }),
    ).toThrow();
    expect(
      ToolInputSchemas.tabgoblin_navigate.safeParse({ tabId: "t1", url: "file:///etc/passwd" })
        .success,
    ).toBe(false);
    expect(
      ToolInputSchemas.tabgoblin_new_tab.safeParse({ url: "javascript:alert(1)" }).success,
    ).toBe(false);
  });
});
