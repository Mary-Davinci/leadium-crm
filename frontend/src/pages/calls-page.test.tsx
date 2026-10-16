import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallsPage, ThreeCxObservedDnTypes, ThreeCxObservedDevices } from "./calls-page";
import { api } from "../lib/api";

let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) || null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key)
  });
});

describe("observed DN types", () => {
  const renderTypes = (types?: Record<string, string>) => renderToStaticMarkup(<dl><ThreeCxObservedDnTypes types={types} /></dl>);
  for (const types of [undefined, {}]) it(`shows the empty state for ${types ? "empty" : "missing"} maps`, () => {
    expect(renderTypes(types)).toContain("Nessun DN osservato");
  });
  it("shows all eight authorized DNs in operational order, preserving exact type strings", () => {
    const dns = ["901", "913", "910", "911", "912", "920", "921", "922"];
    const html = renderTypes(Object.fromEntries(dns.map(dn => [dn, `Fixture TYPE::${dn}`])));
    expect(html).toContain("observedDnTypes");
    let lastIndex = -1;
    for (const dn of dns) {
      const index = html.indexOf(`${dn} → Fixture TYPE::${dn}`);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
    expect(html).not.toContain("Nessun DN osservato");
  });
  it("renders text safely and excludes unrelated keys or non-string payloads", () => {
    const html = renderTypes({ "901": "<script>fixture</script>", "913": { participant: "hidden-fixture" }, "999": "unmonitored", access_token: "token-fixture" } as unknown as Record<string, string>);
    expect(html).toContain("901 → &lt;script&gt;fixture&lt;/script&gt;");
    for (const hidden of ["<script>", "hidden-fixture", "unmonitored", "token-fixture", "913 →"]) expect(html).not.toContain(hidden);
  });
});

describe("admin observed devices projection", () => {
  const renderDevices = (devices?: Record<string, Array<{ deviceIdMasked: string; userAgent: string }>>) => renderToStaticMarkup(<dl><ThreeCxObservedDevices devices={devices} /></dl>);
  it("distinguishes not observed and confirmed zero registrations", () => {
    expect(renderDevices()).toContain("Device non ancora osservati");
    expect(renderDevices({})).toContain("Device non ancora osservati");
    const empty = renderDevices({ "901": [], "913": [] });
    expect(empty).toContain("901 · 0 device"); expect(empty).toContain("913 · 0 device"); expect(empty).toContain("Nessun device registrato");
  });
  it("shows one/multiple sanitized devices only for 901/913", () => {
    const device = { deviceIdMasked: "device-123456abcdef", userAgent: "Fixture Desktop 20.0" };
    const html = renderDevices({ "901": [device], "913": [device, { deviceIdMasked: "device-abcdef123456", userAgent: "" }], "910": [{ deviceIdMasked: "must-not-render", userAgent: "private-queue" }] });
    for (const value of ["901 · 1 device", "913 · 2 device", "Fixture Desktop 20.0", "User agent non disponibile"]) expect(html).toContain(value);
    expect(html).not.toContain("must-not-render"); expect(html).not.toContain("private-queue");
  });
});
afterEach(() => { vi.unstubAllGlobals(); });
const render = () => renderToStaticMarkup(<MemoryRouter><CallsPage /></MemoryRouter>);
function session(role: string) {
  storage.set("crm.auth.token", "fixture-token");
  storage.set("crm.auth.user", JSON.stringify({ id: "fixture-user", username: "fixture", name: "Fixture", role }));
}

describe("CallsPage permissions and API session", () => {
  for (const role of ["admin", "super_admin"]) it(`${role}: diagnostics visible and legacy tool collapsed`, () => {
    session(role);
    const html = render();
    expect(html).toContain("Stato 3CX");
    expect(html).toContain("Strumento tecnico/admin: test webhook 3CX legacy");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("<textarea");
  });
  for (const role of ["operatore", null]) it(`${role || "no session"}: admin diagnostics and test tool absent`, () => {
    if (role) session(role);
    const html = render();
    expect(html).not.toContain("Stato 3CX");
    expect(html).not.toContain("test webhook");
    expect(html).not.toContain("<textarea");
  });
  it("calls and diagnostics GET include the bearer token through the existing api helper", async () => {
    session("admin");
    const fetchMock = vi.fn().mockImplementation(async () => new Response("{}", { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    for (const url of ["/api/calls?limit=250", "/api/3cx/diagnostics"]) await api(url);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, options] of fetchMock.mock.calls) expect(options.headers.Authorization).toBe("Bearer fixture-token");
  });
  it("cached admin identity does not keep a rejected token valid; 401 clears both credentials", async () => {
    session("admin");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Non autorizzato." }), { status: 401, headers: { "Content-Type": "application/json" } })));
    await expect(api("/api/calls?limit=250")).rejects.toThrow("Non autorizzato.");
    expect(storage.has("crm.auth.token")).toBe(false);
    expect(storage.has("crm.auth.user")).toBe(false);
  });
  it("operator denied diagnostics does not clear a valid session", async () => {
    session("operatore");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Diagnostica riservata agli amministratori." }), { status: 403, headers: { "Content-Type": "application/json" } })));
    await expect(api("/api/3cx/diagnostics")).rejects.toThrow("Diagnostica riservata");
    expect(storage.get("crm.auth.token")).toBe("fixture-token");
  });
});
