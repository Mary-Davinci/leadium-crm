import { randomBytes, timingSafeEqual } from "node:crypto";
// The current dev-stack/production entrypoint runs gateway and call-service in one process.
// This process-scoped capability prevents direct internal HTTP action/identity forgery.
const capability = randomBytes(32).toString("hex");
export const callControlInternalHeaders = () => ({ "x-leadium-call-control": capability });
export function isCallControlInternal(value: unknown) {
  return typeof value === "string" && value.length === capability.length && timingSafeEqual(Buffer.from(value), Buffer.from(capability));
}
