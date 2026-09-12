import { describe, expect, it } from "vitest";
import { PAIRING_CODE_TTL_MS } from "@tab-goblin/protocol";
import { PairingCodes } from "../src/pairing.js";

describe("PairingCodes", () => {
  it("redeems a fresh code exactly once and never returns the code", () => {
    const codes = new PairingCodes();
    const issued = codes.issue("ws-1");

    expect(codes.redeem(issued.code)).toEqual({ workspaceId: "ws-1" });
    expect(() => codes.redeem(issued.code)).toThrowError(
      expect.objectContaining({ code: "auth_failed" }),
    );
  });

  it("uses the protocol TTL and rejects an expired code", () => {
    let now = 1_000;
    const codes = new PairingCodes({ now: () => now });
    const issued = codes.issue("ws-1");
    expect(issued.expiresAt).toBe(new Date(now + PAIRING_CODE_TTL_MS).toISOString());

    now += PAIRING_CODE_TTL_MS;
    expect(() => codes.redeem(issued.code)).toThrowError(
      expect.objectContaining({ code: "auth_failed" }),
    );
  });

  it("bounds repeated failed redemption attempts for the remainder of the window", () => {
    let now = 0;
    const codes = new PairingCodes({ now: () => now, maxFailuresPerMinute: 3 });
    for (let index = 0; index < 3; index += 1) {
      expect(() => codes.redeem(`WRONG-${index}`)).toThrowError(
        expect.objectContaining({ code: "auth_failed" }),
      );
    }

    const issued = codes.issue("ws-1");
    expect(() => codes.redeem(issued.code)).toThrowError(
      expect.objectContaining({ code: "auth_failed" }),
    );

    now = 60_000;
    expect(codes.redeem(issued.code)).toEqual({ workspaceId: "ws-1" });
  });

  it("uses a rolling failure window rather than a resettable fixed window", () => {
    let now = 0;
    const codes = new PairingCodes({ now: () => now, maxFailuresPerMinute: 2 });
    now = 59_000;
    for (let index = 0; index < 2; index += 1) {
      expect(() => codes.redeem(`WRONG-${index}`)).toThrow();
    }
    const issued = codes.issue("ws-1");

    now = 60_001;
    expect(() => codes.redeem(issued.code)).toThrowError(
      expect.objectContaining({ code: "auth_failed" }),
    );
    now = 119_001;
    expect(codes.redeem(issued.code)).toEqual({ workspaceId: "ws-1" });
  });

  it("bounds live codes and invalidates an evicted code", () => {
    const codes = new PairingCodes({ maxActiveCodes: 2 });
    const first = codes.issue("ws-1");
    codes.issue("ws-2");
    codes.issue("ws-3");

    expect(() => codes.redeem(first.code)).toThrowError(
      expect.objectContaining({ code: "auth_failed" }),
    );
  });

  it("issues distinct high-entropy Crockford-style codes", () => {
    const codes = new PairingCodes();
    const seen = new Set(Array.from({ length: 200 }, () => codes.issue("ws-1").code));

    expect(seen.size).toBe(200);
    expect([...seen][0]).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
  });

  it("rejects invalid constructor bounds and workspace identifiers", () => {
    expect(() => new PairingCodes({ ttlMs: 0 })).toThrow(RangeError);
    expect(() => new PairingCodes({ maxFailuresPerMinute: 0 })).toThrow(RangeError);
    expect(() => new PairingCodes({ maxActiveCodes: 0 })).toThrow(RangeError);
    expect(() => new PairingCodes().issue("")).toThrow(TypeError);
  });
});
