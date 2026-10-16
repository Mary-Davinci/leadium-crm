import { createHmac, randomBytes } from "node:crypto";

type ObservedDevice = { deviceIdMasked: string; userAgent: string };

/** Diagnostic-only projection of the documented DNInfo.devices array, never participants. */
export class ThreeCxDeviceDiagnostics {
  private salt = randomBytes(32);
  private devices = new Map<string, ObservedDevice[]>();
  forget(dn: string) { this.devices.delete(dn); }

  observe(dn: string, value: unknown) {
    if (dn !== "901" && dn !== "913") return;
    // Missing/malformed is unknown, not proof that zero devices are registered.
    this.devices.delete(dn);
    if (!Array.isArray(value)) return;
    const observed: ObservedDevice[] = [];
    const ids = new Set<string>();
    for (const item of value) {
      if (!item || typeof item !== "object" || typeof item.device_id !== "string" || !item.device_id.trim()
        || (item.dn !== undefined && item.dn !== dn) || (item.user_agent !== undefined && item.user_agent !== null && typeof item.user_agent !== "string")) return;
      if (ids.has(item.device_id)) continue;
      ids.add(item.device_id);
      observed.push({
        // No raw ID fragments: identifiers may contain SIP identities, hostnames or phones.
        // Stable within this monitor instance only; not a selectable device ID for actions.
        deviceIdMasked: "device-" + createHmac("sha256", this.salt).update(item.device_id).digest("hex").slice(0, 12),
        userAgent: this.userAgent(item.user_agent, item.device_id)
      });
    }
    this.devices.set(dn, observed);
  }

  private userAgent(value: unknown, deviceId: string): string {
    if (typeof value !== "string") return "";
    const agent = value.trim();
    // Preserve ordinary product/version labels, redact suspicious identity/auth fields as a whole.
    if (agent.length > 160 || /[\u0000-\u001f\u007f<>@]/.test(agent)
      || /(?:bearer|token|secret|password|credential|api[ _-]?key|https?:|sips?:)/i.test(agent)
      || /\d{7,}|(?:\+|00)\d[\d ()-]{7,}|(?:\d{1,3}\.){3}\d{1,3}|[a-f\d]{24,}|[a-z\d_+-]{32,}/i.test(agent)
      || (deviceId.length >= 4 && agent.includes(deviceId))) return "[redacted]";
    return agent;
  }

  diagnostics(enabled: boolean) {
    const observedDevices: Record<string, ObservedDevice[]> = {};
    const deviceCount: Record<string, number> = {};
    if (enabled) for (const [dn, devices] of this.devices) {
      observedDevices[dn] = devices.map(item => ({ ...item }));
      deviceCount[dn] = devices.length;
    }
    return { observedDevices, deviceCount };
  }
}
