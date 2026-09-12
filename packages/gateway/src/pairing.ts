import { randomBytes } from "node:crypto";
import { PAIRING_CODE_TTL_MS, tabGoblinError } from "@tab-goblin/protocol";

interface PairingEntry {
  workspaceId: string;
  expiresAt: number;
}

export interface PairingCodesOptions {
  ttlMs?: number;
  now?: () => number;
  maxFailuresPerMinute?: number;
  maxActiveCodes?: number;
}

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 12;
const FAILURE_WINDOW_MS = 60_000;
const DEFAULT_MAX_FAILURES = 30;
const DEFAULT_MAX_ACTIVE_CODES = 1_024;

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function authFailure(message = "Pairing failed"): never {
  throw tabGoblinError("auth_failed", message);
}

export class PairingCodes {
  private readonly entries = new Map<string, PairingEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly maxFailuresPerMinute: number;
  private readonly maxActiveCodes: number;
  private readonly failedAt: number[] = [];

  constructor(options: PairingCodesOptions = {}) {
    this.ttlMs = positiveSafeInteger(options.ttlMs ?? PAIRING_CODE_TTL_MS, "ttlMs");
    this.maxFailuresPerMinute = positiveSafeInteger(
      options.maxFailuresPerMinute ?? DEFAULT_MAX_FAILURES,
      "maxFailuresPerMinute",
    );
    this.maxActiveCodes = positiveSafeInteger(
      options.maxActiveCodes ?? DEFAULT_MAX_ACTIVE_CODES,
      "maxActiveCodes",
    );
    this.now = options.now ?? Date.now;
  }

  issue(workspaceId: string): { code: string; expiresAt: string } {
    if (typeof workspaceId !== "string" || workspaceId.length < 1 || workspaceId.length > 128) {
      throw new TypeError("workspaceId must contain 1 to 128 characters");
    }

    const now = this.now();
    this.sweep(now);
    while (this.entries.size >= this.maxActiveCodes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }

    let code: string;
    do code = this.generateCode(); while (this.entries.has(code));
    const expiresAt = now + this.ttlMs;
    this.entries.set(code, { workspaceId, expiresAt });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  redeem(code: string): { workspaceId: string } {
    const now = this.now();
    this.pruneFailures(now);
    if (this.failedAt.length >= this.maxFailuresPerMinute) {
      authFailure("Too many pairing attempts; try again shortly");
    }

    const entry = typeof code === "string" ? this.entries.get(code) : undefined;
    if (!entry || entry.expiresAt <= now) {
      if (entry) this.entries.delete(code);
      this.failedAt.push(now);
      authFailure();
    }

    this.entries.delete(code);
    return { workspaceId: entry.workspaceId };
  }

  private pruneFailures(now: number): void {
    const cutoff = now - FAILURE_WINDOW_MS;
    let expired = 0;
    while (expired < this.failedAt.length && this.failedAt[expired]! <= cutoff) expired += 1;
    if (expired > 0) this.failedAt.splice(0, expired);
  }

  private sweep(now: number): void {
    for (const [code, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(code);
    }
  }

  private generateCode(): string {
    const bytes = randomBytes(CODE_LENGTH);
    let raw = "";
    for (const byte of bytes) raw += CODE_ALPHABET[byte & 31];
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  }
}
