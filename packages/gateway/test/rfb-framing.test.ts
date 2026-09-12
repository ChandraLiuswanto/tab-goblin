import { describe, expect, it } from "vitest";
import {
  RfbClientStreamGate,
  RfbProtocolError,
  clientMessageLength,
  isInputMessage,
} from "../src/rfb-framing.js";

const allowed = (generation = 0) => ({ allowed: true, generation });
const denied = (generation = 0) => ({ allowed: false, generation });

function keyEvent(keysym: number, down = true): Buffer {
  const frame = Buffer.alloc(8);
  frame[0] = 4;
  frame[1] = down ? 1 : 0;
  frame.writeUInt32BE(keysym, 4);
  return frame;
}

function pointerEvent(mask: number, x = 10, y = 20): Buffer {
  const extended = mask > 0x7f;
  const frame = Buffer.alloc(extended ? 7 : 6);
  frame[0] = 5;
  frame[1] = (mask & 0x7f) | (extended ? 0x80 : 0);
  frame.writeUInt16BE(x, 2);
  frame.writeUInt16BE(y, 4);
  if (extended) frame[6] = (mask >> 7) & 0x03;
  return frame;
}

function updateRequest(): Buffer {
  const frame = Buffer.alloc(10);
  frame[0] = 3;
  return frame;
}

function setEncodings(count: number): Buffer {
  const frame = Buffer.alloc(4 + count * 4);
  frame[0] = 2;
  frame.writeUInt16BE(count, 2);
  return frame;
}

function clipboard(length: number): Buffer {
  const frame = Buffer.alloc(8 + Math.max(0, length));
  frame[0] = 6;
  frame.writeUInt32BE(length >>> 0, 4);
  return frame;
}

function completeHandshake(gate: RfbClientStreamGate): void {
  gate.observeServer(Buffer.from("RFB 003.008\n"));
  expect(gate.pushClient(Buffer.from("RFB 003."), denied()).forward).toHaveLength(0);
  expect(gate.pushClient(Buffer.from("008\n"), denied()).forward.toString()).toBe("RFB 003.008\n");
  gate.observeServer(Buffer.from([1, 1]));
  expect(gate.pushClient(Buffer.from([1]), denied()).forward).toEqual(Buffer.from([1]));
  gate.observeServer(Buffer.from([0, 0, 0, 0]));
  expect(gate.pushClient(Buffer.from([1]), denied()).forward).toEqual(Buffer.from([1]));
  expect(gate.handshakeComplete).toBe(true);
}

describe("RFB client framing", () => {
  it.each([
    [Buffer.alloc(20, 0), 20],
    [setEncodings(3), 16],
    [updateRequest(), 10],
    [keyEvent(0x41), 8],
    [pointerEvent(1), 6],
    [pointerEvent(0x100), 7],
  ])("measures complete supported frames", (frame, expected) => {
    expect(clientMessageLength(frame)).toBe(expected);
  });

  it("returns null only for incomplete supported frames", () => {
    expect(clientMessageLength(Buffer.alloc(0))).toBeNull();
    expect(clientMessageLength(setEncodings(3).subarray(0, 7))).toBeNull();
  });

  it("classifies all supported keyboard and pointer forms as input", () => {
    expect(isInputMessage(4)).toBe(true);
    expect(isInputMessage(5)).toBe(true);
    expect(isInputMessage(255)).toBe(true);
    expect(isInputMessage(0)).toBe(false);
  });

  it("preserves a fragmented no-auth RFB 3.8 handshake", () => {
    const gate = new RfbClientStreamGate();
    completeHandshake(gate);
  });

  it("completes an RFB 3.7 None handshake with byte-fragmented server data and coalesced client data", () => {
    const gate = new RfbClientStreamGate();
    for (const byte of Buffer.from("RFB 003.007\n")) gate.observeServer(Buffer.from([byte]));

    const versionOutput: Buffer[] = [];
    for (const byte of Buffer.from("RFB 003.007\n")) {
      versionOutput.push(gate.pushClient(Buffer.from([byte]), denied()).forward);
    }
    expect(Buffer.concat(versionOutput).toString()).toBe("RFB 003.007\n");
    for (const byte of Buffer.from([1, 1])) gate.observeServer(Buffer.from([byte]));

    expect(gate.pushClient(Buffer.from([1, 1]), denied()).forward).toEqual(Buffer.from([1, 1]));
    expect(gate.handshakeComplete).toBe(true);
  });

  it("still waits for the SecurityResult before ClientInit for RFB 3.8 None", () => {
    const gate = new RfbClientStreamGate();
    gate.observeServer(Buffer.from("RFB 003.008\n"));
    gate.pushClient(Buffer.from("RFB 003.008\n"), denied());
    gate.observeServer(Buffer.from([1, 1]));

    expect(gate.pushClient(Buffer.from([1, 1]), denied()).forward).toEqual(Buffer.from([1]));
    expect(gate.handshakeComplete).toBe(false);
    gate.observeServer(Buffer.alloc(4));
    expect(gate.pushClient(Buffer.alloc(0), denied()).forward).toEqual(Buffer.from([1]));
    expect(gate.handshakeComplete).toBe(true);
  });

  it("accepts a client-negotiated downgrade from RFB 3.8 to 3.3", () => {
    const gate = new RfbClientStreamGate();
    gate.observeServer(Buffer.from("RFB 003.008\n"));
    expect(gate.pushClient(Buffer.from("RFB 003.003\n"), denied()).forward.toString()).toBe("RFB 003.003\n");
    const security = Buffer.alloc(4);
    security.writeUInt32BE(1);
    gate.observeServer(security);
    expect(gate.pushClient(Buffer.from([1]), denied()).forward).toEqual(Buffer.from([1]));
    expect(gate.handshakeComplete).toBe(true);
  });

  it("supports a fragmented VNC-auth handshake without interpreting auth bytes as messages", () => {
    const gate = new RfbClientStreamGate();
    gate.observeServer(Buffer.from("RFB 003.008\n"));
    gate.pushClient(Buffer.from("RFB 003.008\n"), denied());
    gate.observeServer(Buffer.from([1, 2]));
    gate.pushClient(Buffer.from([2]), denied());
    gate.observeServer(Buffer.alloc(16, 7));
    expect(gate.pushClient(Buffer.alloc(8, 1), denied()).forward).toHaveLength(0);
    expect(gate.pushClient(Buffer.alloc(8, 2), denied()).forward).toHaveLength(16);
    gate.observeServer(Buffer.alloc(4));
    gate.pushClient(Buffer.from([1]), denied());
    expect(gate.handshakeComplete).toBe(true);
  });

  it("handles coalesced normal messages and filters each completed input frame", () => {
    const gate = new RfbClientStreamGate();
    completeHandshake(gate);
    const stream = Buffer.concat([updateRequest(), keyEvent(0x41), pointerEvent(1)]);

    expect(gate.pushClient(stream, denied()).forward).toEqual(updateRequest());
    expect(gate.pushClient(stream, allowed()).forward).toEqual(stream);
  });

  it("never releases queued partial input after ownership or generation changes", () => {
    const gate = new RfbClientStreamGate();
    completeHandshake(gate);
    const key = keyEvent(0x41);

    expect(gate.pushClient(key.subarray(0, 4), denied(4)).forward).toHaveLength(0);
    expect(gate.pushClient(key.subarray(4), allowed(4)).forward).toHaveLength(0);

    expect(gate.pushClient(key.subarray(0, 4), allowed(4)).forward).toHaveLength(0);
    expect(gate.pushClient(key.subarray(4), denied(5)).forward).toHaveLength(0);
    expect(gate.synthesizeReleases()).toHaveLength(0);
  });

  it("tracks pressed keys and pointer buttons and synthesizes releases exactly once", () => {
    const gate = new RfbClientStreamGate();
    completeHandshake(gate);
    gate.pushClient(Buffer.concat([keyEvent(0xffe3), pointerEvent(0x101, 44, 55)]), allowed(9));

    expect(gate.synthesizeReleases()).toEqual(
      Buffer.concat([keyEvent(0xffe3, false), pointerEvent(0, 44, 55)]),
    );
    expect(gate.synthesizeReleases()).toHaveLength(0);
  });

  it("rejects clipboard, desktop-control, file-transfer, unknown, and over-bound frames", () => {
    const gate = new RfbClientStreamGate({ maxBufferedBytes: 64 });
    completeHandshake(gate);

    for (const frame of [clipboard(1), Buffer.from([251]), Buffer.from([7]), Buffer.from([199])]) {
      expect(() => gate.pushClient(frame, allowed())).toThrow(RfbProtocolError);
    }

    const bounded = new RfbClientStreamGate({ maxBufferedBytes: 64 });
    completeHandshake(bounded);
    const header = Buffer.alloc(8);
    header[0] = 6;
    header.writeUInt32BE(65, 4);
    expect(() => bounded.pushClient(header, allowed())).toThrow(RfbProtocolError);
  });

  it("rejects malformed supported messages even while viewer input is denied", () => {
    const gate = new RfbClientStreamGate();
    completeHandshake(gate);
    const malformedKey = keyEvent(0x41);
    malformedKey[1] = 2;
    expect(() => gate.pushClient(malformedKey, denied())).toThrow(RfbProtocolError);

    const malformedPixelFormat = Buffer.alloc(20);
    malformedPixelFormat[0] = 0;
    malformedPixelFormat[4] = 7;
    malformedPixelFormat[5] = 8;
    expect(() => gate.pushClient(malformedPixelFormat, denied())).toThrow(RfbProtocolError);

    const excessiveFence = Buffer.alloc(74);
    excessiveFence[0] = 248;
    excessiveFence[8] = 65;
    expect(() => gate.pushClient(excessiveFence, denied())).toThrow(RfbProtocolError);
  });

  it("rejects invalid handshake data and excessive buffering", () => {
    const invalid = new RfbClientStreamGate({ maxBufferedBytes: 16 });
    expect(() => invalid.observeServer(Buffer.from("NOT RFB DATA"))).toThrow(RfbProtocolError);

    const excessive = new RfbClientStreamGate({ maxBufferedBytes: 16 });
    expect(() => excessive.pushClient(Buffer.alloc(17), denied())).toThrow(RfbProtocolError);
  });
});
