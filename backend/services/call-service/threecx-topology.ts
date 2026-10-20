// Tenant topology: which 3CX DNs Leadium may read and control. Not a PBX configuration change.
// Operator extensions come from THREECX_AGENT_DNS (comma separated); queues and receptionists
// are fixed infrastructure and can never become operator extensions.
export const DEFAULT_AGENT_DNS = ["901", "913"] as const;
export const QUEUE_DNS = ["910", "911", "912"] as const;
export const RECEPTIONIST_DNS = ["920", "921", "922"] as const;

const infrastructure = new Set<string>([...QUEUE_DNS, ...RECEPTIONIST_DNS]);
let cache: { raw: string | undefined; dns: readonly string[] } | null = null;

/** Invalid or infrastructure entries are dropped; an empty result falls back to the defaults. */
export function parseAgentDns(raw: string | undefined): readonly string[] {
  const dns: string[] = [];
  for (const token of (raw || "").split(",").map(value => value.trim()).filter(Boolean)) {
    if (!/^\d{2,6}$/.test(token) || infrastructure.has(token)) {
      console.warn(`[3cx] THREECX_AGENT_DNS: interno ignorato (${token.slice(0, 12)})`);
      continue;
    }
    if (!dns.includes(token)) dns.push(token);
  }
  return dns.length ? dns : DEFAULT_AGENT_DNS;
}

export function agentDns(): readonly string[] {
  const raw = process.env.THREECX_AGENT_DNS;
  if (!cache || cache.raw !== raw) cache = { raw, dns: parseAgentDns(raw) };
  return cache.dns;
}
export const isAgentDn = (dn: string) => agentDns().includes(dn);
export const isQueueDn = (dn: string) => (QUEUE_DNS as readonly string[]).includes(dn);
export const isReceptionistDn = (dn: string) => (RECEPTIONIST_DNS as readonly string[]).includes(dn);
export const transferDns = (): string[] => [...agentDns(), ...QUEUE_DNS];
export const monitoredDns = (): string[] => [...agentDns(), ...QUEUE_DNS, ...RECEPTIONIST_DNS];
export const isMonitoredDn = (dn: string) => isAgentDn(dn) || infrastructure.has(dn);
