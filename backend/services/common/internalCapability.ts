import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Same mechanism as call-service/threecx-internal: a random, process-scoped capability that the
 * gateway attaches when it forwards an identity it verified from the session (creator, phone
 * editor, payment actor). The production entrypoint (dev-stack) runs gateway and lead-service
 * in one process; the value never leaves the process and is never sent to browsers.
 * Requests without it are treated as anonymous: identity fields in their body are ignored.
 */
const capability = randomBytes(32).toString("hex");
export const INTERNAL_IDENTITY_HEADER = "x-leadium-internal";
export const internalIdentityHeaders = () => ({ [INTERNAL_IDENTITY_HEADER]: capability });
export function isInternalIdentityRequest(headers: Record<string, unknown>) {
  const value = headers[INTERNAL_IDENTITY_HEADER];
  return typeof value === "string" && value.length === capability.length && timingSafeEqual(Buffer.from(value), Buffer.from(capability));
}
