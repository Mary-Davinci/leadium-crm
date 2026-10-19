/**
 * Operator-facing name for a registered 3CX device, derived only from the already sanitized
 * user agent. Raw device IDs never leave the server; the selectable value is the HMAC pseudonym.
 */
export function deviceLabel(userAgent: string) {
  const agent = String(userAgent || "");
  if (!agent || agent === "[redacted]") return "Dispositivo 3CX";
  if (/web\s*client|webclient|webrtc|browser|chrome|firefox|safari|edg\//i.test(agent)) return "Client web 3CX";
  if (/android/i.test(agent)) return "App 3CX Android";
  if (/iphone|ipad|\bios\b|3cxios/i.test(agent)) return "App 3CX iPhone";
  if (/windows/i.test(agent)) return "App 3CX Windows";
  if (/mac\s?os|macintosh|darwin/i.test(agent)) return "App 3CX Mac";
  if (/yealink|fanvil|snom|grandstream|polycom|cisco|gigaset|htek/i.test(agent)) return "Telefono fisso";
  return "Dispositivo 3CX";
}

export const DEVICE_PSEUDONYM = /^device-[a-f0-9]{12}$/;
