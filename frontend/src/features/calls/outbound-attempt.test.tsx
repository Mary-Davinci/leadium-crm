import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { describeAttempt, OutboundAttemptCard, type Attempt } from "./threecx-context";

const t0 = Date.parse("2026-10-20T09:00:00Z");
const accepted = (extra: Partial<Attempt> = {}): Attempt => ({
  id: 1, phone: "393331112222", target: { leadId: "lead-1", customerName: "Mario Rossi" }, stage: "accepted",
  attemptId: "a1b2c3d4", callId: "77", destination: "3331112222", acceptedAt: t0,
  device: { device: "device-0123456789ab", label: "Client web 3CX", userAgent: "3CX Web Client" }, ...extra
});
const card = (attempt: Attempt, now = t0) => renderToStaticMarkup(<MemoryRouter><OutboundAttemptCard attempt={attempt} dn="901" now={now} busy={false}
  onChooseDevice={() => {}} onAction={() => {}} onOutcome={() => {}} onDismiss={() => {}} /></MemoryRouter>);

describe("outbound attempt state comes only from observed events", () => {
  it("acceptance alone is not a ringing customer; silence after the window is missing confirmation, not failure", () => {
    const early = describeAttempt(accepted(), t0 + 5000);
    expect(early.title).toBe("Richiesta accettata da 3CX");
    expect(`${early.title} ${early.detail}`).not.toMatch(/cliente.*squill|squilla il cliente/i);
    expect(early.showTimer).toBe(false);
    const late = describeAttempt(accepted(), t0 + 61000);
    expect(late.tone).toBe("warn");
    expect(late.title).toBe("Nessun evento dal centralino");
    expect(late.detail).not.toMatch(/fallit|non riuscit/i);
  });

  it("callback phase asks to answer in the 3CX client; nothing promises in-CRM audio or answering", () => {
    const view = describeAttempt(accepted({ phase: "callback_ringing", maxPhaseRank: 1 }), t0 + 2000);
    expect(view.tone).toBe("action");
    expect(view.title).toBe("Rispondi nel client 3CX");
    expect(view.steps.map(step => step.state)).toEqual(["done", "current", "pending", "pending"]);
    const html = card(accepted({ phase: "callback_ringing", maxPhaseRank: 1 }));
    expect(html).not.toContain(">Rispondi<");
    expect(html).not.toMatch(/audio|microfono/i);
  });

  it("conversation timer only from an observed connection; steps never regress", () => {
    expect(describeAttempt(accepted({ phase: "dialing_customer", maxPhaseRank: 3 }), t0).title).toBe("Chiamata al cliente in corso");
    expect(describeAttempt(accepted({ phase: "connected", maxPhaseRank: 4 }), t0).showTimer).toBe(false);
    const live = describeAttempt(accepted({ phase: "connected", maxPhaseRank: 4, connectedAt: new Date(t0).toISOString() }), t0 + 65000);
    expect(live.showTimer).toBe(true);
    expect(live.steps.map(step => step.state)).toEqual(["done", "done", "done", "current"]);
    expect(card(accepted({ phase: "connected", maxPhaseRank: 4, connectedAt: new Date(t0).toISOString() }), t0 + 65000)).toContain("01:05");
  });

  it("end of call: duration when a conversation was observed, otherwise said plainly", () => {
    expect(describeAttempt(accepted({ endedAt: t0 + 90000, talkSeconds: 42, maxPhaseRank: 4 }), t0 + 90000).detail).toBe("Durata conversazione 00:42.");
    expect(describeAttempt(accepted({ endedAt: t0 + 30000, maxPhaseRank: 1 }), t0 + 30000).title).toBe("Chiamata terminata");
  });

  it("errors: refused vs uncertain, with the diagnostic reference", () => {
    expect(describeAttempt({ ...accepted(), stage: "error", error: "Nessun dispositivo 3CX registrato per questo interno." }, t0).title).toBe("Chiamata non avviata");
    const uncertain = describeAttempt({ ...accepted(), stage: "error", uncertain: true, error: "3CX momentaneamente non disponibile" }, t0);
    expect(uncertain.title).toBe("Esito incerto");
    expect(uncertain.detail).toContain("potrebbe essere partita");
    expect(card({ ...accepted(), stage: "error", error: "x" })).toContain("Riferimento per la diagnostica: a1b2c3d4");
  });

  it("shows customer, dialed number (and the stored one when different), extension and device", () => {
    const html = card(accepted());
    for (const text of ["Mario Rossi", "3331112222", "(salvato: 393331112222)", "901", "Client web 3CX"]) expect(html).toContain(text);
  });
});
