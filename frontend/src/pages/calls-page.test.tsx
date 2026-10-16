import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallsPage } from "./calls-page";
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
