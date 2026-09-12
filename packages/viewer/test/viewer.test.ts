import { describe, expect, it } from "vitest";
// This test deliberately imports the DOM-free module: node tests must not load noVNC or bootstrap code.
import { nextUi, scaleToFit } from "../src/ui-state.js";

describe("scaleToFit", () => {
  it("fits a 1280x800 desktop into a narrow phone viewport and centres it", () => {
    const { scale, offsetX } = scaleToFit({ width: 1280, height: 800 }, { width: 390, height: 844 });
    expect(scale).toBeCloseTo(390 / 1280, 5);
    expect(offsetX).toBe(0);
  });

  it("never scales above 1", () => {
    expect(scaleToFit({ width: 800, height: 600 }, { width: 2560, height: 1440 }).scale).toBe(1);
  });
});

describe("nextUi", () => {
  it("starts at pairing and moves to connecting once paired", () => {
    expect(nextUi({ kind: "pairing", error: null }, { type: "paired" })).toEqual({
      kind: "connecting",
    });
  });

  it("lands in view-only, not controlling, straight after connecting", () => {
    const ui = nextUi({ kind: "connecting" }, { type: "socket-open" });
    expect(ui.kind).toBe("view-only");
  });

  it("only shows controlling when the server says this session owns input", () => {
    const notOwner = nextUi(
      { kind: "view-only", ownership: "agent-ready" },
      { type: "ownership", state: "manual", isOwner: false },
    );
    expect(notOwner.kind).toBe("view-only");

    const owner = nextUi(
      { kind: "view-only", ownership: "agent-ready" },
      { type: "ownership", state: "manual", isOwner: true },
    );
    expect(owner.kind).toBe("controlling");
  });

  it("drops to reconnecting on socket close and disables local input", () => {
    expect(nextUi({ kind: "controlling" }, { type: "socket-closed" })).toEqual({
      kind: "reconnecting",
    });
  });

  it("keeps a failed pairing on the pairing screen with the message", () => {
    expect(
      nextUi({ kind: "pairing", error: null }, { type: "pair-failed", message: "Code expired" }),
    ).toEqual({ kind: "pairing", error: "Code expired" });
  });
});
