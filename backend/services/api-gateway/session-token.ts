import crypto from "crypto";

/**
 * crypto.randomBytes is Node's CSPRNG (unlike Math.random, whose output is
 * predictable and unsuitable for a bearer session token). 32 bytes = 256
 * bits of entropy, hex-encoded so it's a safe bearer-header value.
 */
export function createSessionToken(): string {
  return `sess_${crypto.randomBytes(32).toString("hex")}`;
}
