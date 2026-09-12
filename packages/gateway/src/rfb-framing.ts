export interface RfbAuthorization {
  allowed: boolean;
  generation: number;
}

export interface RfbFilterResult {
  forward: Buffer;
  bufferedBytes: number;
}

export interface RfbClientStreamGateOptions {
  maxBufferedBytes?: number;
  maxEncodings?: number;
}

type HandshakeState =
  | "server-version"
  | "client-version"
  | "server-security"
  | "client-security-selection"
  | "server-challenge"
  | "client-auth-response"
  | "server-security-result"
  | "client-init"
  | "normal";

const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
const DEFAULT_MAX_ENCODINGS = 1024;
const RFB_VERSION_LENGTH = 12;

export class RfbProtocolError extends Error {
  constructor(message = "Invalid or unsupported RFB client stream") {
    super(message);
    this.name = "RfbProtocolError";
  }
}

function boundedPositive(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return selected;
}

function parseVersion(frame: Buffer): number {
  const match = /^RFB 003\.(003|007|008)\n$/.exec(frame.toString("ascii"));
  if (!match) throw new RfbProtocolError("Unsupported RFB protocol version");
  return Number(match[1]);
}

export function isInputMessage(messageType: number): boolean {
  return messageType === 4 || messageType === 5 || messageType === 255;
}

export function clientMessageLength(
  buffer: Buffer,
  options: { maxBytes?: number; maxEncodings?: number } = {},
): number | null {
  const maxBytes = boundedPositive(options.maxBytes, DEFAULT_MAX_BUFFERED_BYTES, "maxBytes");
  const maxEncodings = boundedPositive(options.maxEncodings, DEFAULT_MAX_ENCODINGS, "maxEncodings");
  if (buffer.length < 1) return null;

  let total: number;
  switch (buffer[0]) {
    case 0:
      total = 20;
      break;
    case 2:
      if (buffer.length < 4) return null;
      if (buffer.readUInt16BE(2) > maxEncodings) {
        throw new RfbProtocolError("RFB encoding list exceeds its bound");
      }
      total = 4 + 4 * buffer.readUInt16BE(2);
      break;
    case 3:
      total = 10;
      break;
    case 4:
      total = 8;
      break;
    case 5:
      if (buffer.length < 2) return null;
      total = (buffer[1]! & 0x80) === 0 ? 6 : 7;
      break;
    case 6:
      throw new RfbProtocolError("RFB clipboard transfer is disabled");
    case 150:
      total = 10;
      break;
    case 248:
      if (buffer.length < 9) return null;
      if (buffer[8]! > 64) throw new RfbProtocolError("RFB fence payload exceeds its bound");
      total = 9 + buffer[8]!;
      break;
    case 251:
      throw new RfbProtocolError("RFB desktop control is disabled");
    case 255:
      if (buffer.length < 2) return null;
      if (buffer[1] !== 0) throw new RfbProtocolError("Unknown RFB extension message");
      total = 12;
      break;
    default:
      throw new RfbProtocolError();
  }

  if (total > maxBytes) throw new RfbProtocolError("RFB message exceeds its bound");
  return buffer.length >= total ? total : null;
}

export class RfbClientStreamGate {
  private readonly maxBufferedBytes: number;
  private readonly maxEncodings: number;
  private state: HandshakeState = "server-version";
  private serverBuffer: Buffer = Buffer.alloc(0);
  private clientBuffer: Buffer = Buffer.alloc(0);
  private pendingAuthorization: RfbAuthorization | null = null;
  private serverMinor = 0;
  private offeredSecurityTypes = new Set<number>();
  private readonly pressedKeys = new Map<string, Buffer>();
  private pointerMask = 0;
  private pointerX = 0;
  private pointerY = 0;

  constructor(options: RfbClientStreamGateOptions = {}) {
    this.maxBufferedBytes = boundedPositive(
      options.maxBufferedBytes,
      DEFAULT_MAX_BUFFERED_BYTES,
      "maxBufferedBytes",
    );
    this.maxEncodings = boundedPositive(options.maxEncodings, DEFAULT_MAX_ENCODINGS, "maxEncodings");
  }

  get handshakeComplete(): boolean {
    return this.state === "normal";
  }

  observeServer(chunk: Buffer): void {
    if (this.state === "normal" || chunk.length === 0) return;
    this.serverBuffer = this.appendBounded(this.serverBuffer, chunk);

    while (true) {
      if (this.state === "server-version") {
        const frame = this.takeServer(RFB_VERSION_LENGTH);
        if (!frame) return;
        this.serverMinor = parseVersion(frame);
        this.state = "client-version";
        continue;
      }
      if (this.state === "server-security") {
        if (this.serverMinor === 3) {
          const frame = this.takeServer(4);
          if (!frame) return;
          const securityType = frame.readUInt32BE(0);
          if (securityType === 1) this.state = "client-init";
          else if (securityType === 2) this.state = "server-challenge";
          else throw new RfbProtocolError("Unsupported RFB security type");
          continue;
        }

        if (this.serverBuffer.length < 1) return;
        const count = this.serverBuffer[0]!;
        if (count === 0) throw new RfbProtocolError("RFB server rejected the connection");
        const frame = this.takeServer(1 + count);
        if (!frame) return;
        this.offeredSecurityTypes = new Set(frame.subarray(1));
        if (![...this.offeredSecurityTypes].some((type) => type === 1 || type === 2)) {
          throw new RfbProtocolError("RFB server offered no supported security type");
        }
        this.state = "client-security-selection";
        continue;
      }
      if (this.state === "server-challenge") {
        if (!this.takeServer(16)) return;
        this.state = "client-auth-response";
        continue;
      }
      if (this.state === "server-security-result") {
        const frame = this.takeServer(4);
        if (!frame) return;
        if (frame.readUInt32BE(0) !== 0) throw new RfbProtocolError("RFB authentication failed");
        this.state = "client-init";
        continue;
      }
      return;
    }
  }

  pushClient(chunk: Buffer, authorization: RfbAuthorization): RfbFilterResult {
    if (!Number.isSafeInteger(authorization.generation) || authorization.generation < 0) {
      throw new RfbProtocolError("Invalid ownership generation");
    }
    if (chunk.length > 0 && this.clientBuffer.length === 0) {
      this.pendingAuthorization = { ...authorization };
    }
    this.clientBuffer = this.appendBounded(this.clientBuffer, chunk);
    const output: Buffer[] = [];

    while (this.clientBuffer.length > 0) {
      if (this.state === "client-version") {
        const frame = this.takeClient(RFB_VERSION_LENGTH);
        if (!frame) break;
        const clientMinor = parseVersion(frame);
        if (clientMinor > this.serverMinor) {
          throw new RfbProtocolError("RFB version negotiation mismatch");
        }
        this.serverMinor = clientMinor;
        output.push(frame);
        this.state = "server-security";
        continue;
      }
      if (this.state === "client-security-selection") {
        const frame = this.takeClient(1);
        if (!frame) break;
        const selected = frame[0]!;
        if (!this.offeredSecurityTypes.has(selected) || (selected !== 1 && selected !== 2)) {
          throw new RfbProtocolError("Unsupported RFB security selection");
        }
        output.push(frame);
        this.state = selected === 1 ? "server-security-result" : "server-challenge";
        continue;
      }
      if (this.state === "client-auth-response") {
        const frame = this.takeClient(16);
        if (!frame) break;
        output.push(frame);
        this.state = "server-security-result";
        continue;
      }
      if (this.state === "client-init") {
        const frame = this.takeClient(1);
        if (!frame) break;
        if (frame[0] !== 0 && frame[0] !== 1) throw new RfbProtocolError("Invalid RFB ClientInit");
        output.push(frame);
        this.state = "normal";
        continue;
      }
      if (this.state !== "normal") break;

      const length = clientMessageLength(this.clientBuffer, {
        maxBytes: this.maxBufferedBytes,
        maxEncodings: this.maxEncodings,
      });
      if (length === null) break;
      const firstAuthorization = this.pendingAuthorization ?? authorization;
      const frame = this.takeClient(length)!;
      this.pendingAuthorization = this.clientBuffer.length === 0 ? null : { ...authorization };
      const input = isInputMessage(frame[0]!);
      this.validateMessage(frame);
      const canForwardInput =
        firstAuthorization.allowed
        && authorization.allowed
        && firstAuthorization.generation === authorization.generation;
      if (!input || canForwardInput) {
        output.push(frame);
        if (input) this.trackInput(frame);
      }
    }

    return { forward: Buffer.concat(output), bufferedBytes: this.clientBuffer.length };
  }

  synthesizeReleases(): Buffer {
    const releases = [...this.pressedKeys.values()];
    this.pressedKeys.clear();
    if (this.pointerMask !== 0) {
      const pointer = Buffer.alloc(6);
      pointer[0] = 5;
      pointer.writeUInt16BE(this.pointerX, 2);
      pointer.writeUInt16BE(this.pointerY, 4);
      releases.push(pointer);
      this.pointerMask = 0;
    }
    return Buffer.concat(releases);
  }

  private validateMessage(frame: Buffer): void {
    switch (frame[0]) {
      case 0: {
        const bitsPerPixel = frame[4]!;
        const depth = frame[5]!;
        const trueColor = frame[7]!;
        if (
          frame[1] !== 0
          || frame[2] !== 0
          || frame[3] !== 0
          || ![8, 16, 32].includes(bitsPerPixel)
          || depth === 0
          || depth > bitsPerPixel
          || frame[6]! > 1
          || trueColor > 1
          || frame[17] !== 0
          || frame[18] !== 0
          || frame[19] !== 0
        ) throw new RfbProtocolError();
        if (trueColor === 1) {
          for (const [maximum, shift] of [
            [frame.readUInt16BE(8), frame[14]!],
            [frame.readUInt16BE(10), frame[15]!],
            [frame.readUInt16BE(12), frame[16]!],
          ] as const) {
            const channelBits = Math.log2(maximum + 1);
            if (maximum === 0 || !Number.isInteger(channelBits) || shift + channelBits > bitsPerPixel) {
              throw new RfbProtocolError();
            }
          }
        }
        break;
      }
      case 2:
        if (frame[1] !== 0) throw new RfbProtocolError();
        break;
      case 3:
        if (frame[1] !== 0 && frame[1] !== 1) throw new RfbProtocolError();
        break;
      case 4:
        if ((frame[1] !== 0 && frame[1] !== 1) || frame[2] !== 0 || frame[3] !== 0) {
          throw new RfbProtocolError();
        }
        break;
      case 5:
        if (frame.length === 7 && (frame[6]! & 0xfc) !== 0) throw new RfbProtocolError();
        break;
      case 150:
        if (frame[1] !== 0 && frame[1] !== 1) throw new RfbProtocolError();
        break;
      case 248:
        if (frame[1] !== 0 || frame[2] !== 0 || frame[3] !== 0) throw new RfbProtocolError();
        break;
      case 255:
        if (frame.readUInt16BE(2) > 1) throw new RfbProtocolError();
        break;
    }
  }

  private trackInput(frame: Buffer): void {
    if (frame[0] === 4) {
      const keysym = frame.readUInt32BE(4);
      const key = `standard:${keysym}`;
      if (frame[1] === 1) {
        const release = Buffer.from(frame);
        release[1] = 0;
        this.pressedKeys.set(key, release);
      } else {
        this.pressedKeys.delete(key);
      }
      return;
    }
    if (frame[0] === 255) {
      const keysym = frame.readUInt32BE(4);
      const keycode = frame.readUInt32BE(8);
      const key = `qemu:${keysym}:${keycode}`;
      if (frame.readUInt16BE(2) === 1) {
        const release = Buffer.from(frame);
        release.writeUInt16BE(0, 2);
        this.pressedKeys.set(key, release);
      } else {
        this.pressedKeys.delete(key);
      }
      return;
    }

    this.pointerX = frame.readUInt16BE(2);
    this.pointerY = frame.readUInt16BE(4);
    this.pointerMask = frame[1]! & 0x7f;
    if (frame.length === 7) this.pointerMask |= (frame[6]! & 0x03) << 7;
  }

  private appendBounded(existing: Buffer, chunk: Buffer): Buffer {
    if (existing.length + chunk.length > this.maxBufferedBytes) {
      throw new RfbProtocolError("RFB stream buffer exceeds its bound");
    }
    return existing.length === 0 ? Buffer.from(chunk) : Buffer.concat([existing, chunk]);
  }

  private takeServer(length: number): Buffer | null {
    if (this.serverBuffer.length < length) return null;
    const frame = this.serverBuffer.subarray(0, length);
    this.serverBuffer = this.serverBuffer.subarray(length);
    return frame;
  }

  private takeClient(length: number): Buffer | null {
    if (this.clientBuffer.length < length) return null;
    const frame = this.clientBuffer.subarray(0, length);
    this.clientBuffer = this.clientBuffer.subarray(length);
    this.pendingAuthorization = this.clientBuffer.length === 0 ? null : this.pendingAuthorization;
    return frame;
  }
}
