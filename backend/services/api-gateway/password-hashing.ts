import { createHash, randomBytes, scryptSync, timingSafeEqual } from "crypto";

/**
 * Password hashing, upgrade-on-login style.
 *
 * Current/target format: scrypt (a slow, memory-hard KDF built into Node's
 * standard `crypto` module -- no external dependency needed) with a random
 * per-password salt, encoded as `scrypt$<saltHex>$<hashHex>`.
 *
 * Legacy formats below (bare-hex SHA-256, salt-prefixed, salt-suffixed,
 * plaintext) are kept ONLY so `authenticateUser` in auth-store.ts can still
 * verify passwords hashed before this change and transparently upgrade them
 * to scrypt on next successful login -- no forced reset, no bulk DB
 * migration. New hashes (create user, reset password) always use scrypt.
 */

const SCRYPT_PREFIX = "scrypt$";
const SCRYPT_KEYLEN = 64;

export function hashPasswordScrypt(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${SCRYPT_PREFIX}${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function isScryptHash(value: unknown): boolean {
  if (typeof value !== "string" || !value.startsWith(SCRYPT_PREFIX)) return false;
  const parts = value.split("$");
  return parts.length === 3 && /^[0-9a-f]+$/i.test(parts[1]) && /^[0-9a-f]+$/i.test(parts[2]);
}

export function verifyScryptPassword(password: string, stored: string): boolean {
  if (!isScryptHash(stored)) return false;
  const [, saltHex, hashHex] = stored.split("$");
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const actual = scryptSync(password, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// --- Legacy SHA-256 formats (verification-only; never used to hash a new password) ---

export function hashPasswordSha256Salted(password: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${password}`).digest("hex");
}

export function hashPasswordSha256NoSalt(password: string): string {
  return createHash("sha256").update(password).digest("hex");
}

export function hashPasswordSha256SuffixSalt(password: string, salt: string): string {
  return createHash("sha256").update(`${password}:${salt}`).digest("hex");
}

export function isSha256Hash(value: unknown): boolean {
  return /^[a-f0-9]{64}$/i.test(String(value || ""));
}

export type PasswordVerificationResult =
  | { outcome: "valid_no_upgrade" }
  | { outcome: "valid_upgrade"; reason: string }
  | { outcome: "invalid" };

/**
 * Pure decision function for `authenticateUser` in auth-store.ts: given what's
 * stored for a user and the password just submitted, decides whether the
 * login is valid and, if so, whether the stored hash should be upgraded to
 * scrypt. Kept side-effect-free (no DB access) so the whole legacy-format
 * decision tree can be unit tested without a live Mongo instance -- this is
 * the highest-risk logic in the auth path, so it gets the most coverage.
 */
export function resolvePasswordVerification(input: {
  password: string;
  storedPasswordHash?: string | null;
  storedPlaintextPassword?: string | null;
  configuredSalt: string;
}): PasswordVerificationResult {
  const { password, storedPasswordHash, storedPlaintextPassword, configuredSalt } = input;

  if (storedPasswordHash) {
    if (isScryptHash(storedPasswordHash)) {
      return verifyScryptPassword(password, storedPasswordHash) ? { outcome: "valid_no_upgrade" } : { outcome: "invalid" };
    }
    if (storedPasswordHash === hashPasswordSha256Salted(password, configuredSalt)) {
      return { outcome: "valid_upgrade", reason: "migrated legacy sha256 password hash to scrypt" };
    }
    if (
      storedPasswordHash === hashPasswordSha256NoSalt(password) ||
      storedPasswordHash === hashPasswordSha256SuffixSalt(password, configuredSalt)
    ) {
      return { outcome: "valid_upgrade", reason: "migrated legacy password hash to scrypt" };
    }
    const plainPasswordMatches = Boolean(storedPlaintextPassword) && storedPlaintextPassword === password;
    const plainHashFieldMatches = !isSha256Hash(storedPasswordHash) && storedPasswordHash === password;
    if (plainPasswordMatches || plainHashFieldMatches) {
      return { outcome: "valid_upgrade", reason: "migrated plain-text password storage to scrypt" };
    }
    return { outcome: "invalid" };
  }

  if (storedPlaintextPassword && storedPlaintextPassword === password) {
    return { outcome: "valid_upgrade", reason: "migrated password field to scrypt" };
  }

  return { outcome: "invalid" };
}
