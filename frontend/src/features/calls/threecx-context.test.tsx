import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect } from "vitest";
import { consumeCallStream, LiveCall, ThreeCxLiveCard } from "./threecx-context";

const call: LiveCall = { callId: "123", agentDn: "901", direction: "inbound", customerPhone: "+393331234567", startedAt: new Date().toISOString(), status: "ringing",
  capabilities: { answer: true, hangup: true, transfer: false, hold: false, resume: false } };
const render = (item: LiveCall) => renderToStaticMarkup(<MemoryRouter><ThreeCxLiveCard call={item} busy={false} onAction={() => {}} /></MemoryRouter>);
describe("native 3CX call card", () => {
  it("cancels an invalid SSE response before reconnecting, releasing the server stream", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('event: calls\ndata: invalid-json\n\n')); },
      cancel() { cancelled = true; }
    }));
    await expect(consumeCallStream(response, () => {})).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
  it("shows incoming identity/practice and only supported controls", () => {
    const html = render({ ...call, customerName: "Cliente fixture", practiceId: "practice-123" });
    for (const value of ["Chiamata in arrivo", "Cliente fixture", "+393331234567", "Apri pratica", "Rispondi", "Rifiuta"]) expect(html).toContain(value);
    for (const hidden of ["Hold", "Resume", "audio", "tel:", "3cx:"]) expect(html).not.toContain(hidden);
  });
  it("unknown caller and device without direct_control show the 3CX device instruction", () => {
    const html = render({ ...call, capabilities: { ...call.capabilities, answer: false } });
    expect(html).toContain("Numero non associato"); expect(html).toContain("Rispondi dal dispositivo 3CX"); expect(html).toMatch(/<button[^>]*is-accept[^>]*disabled=""/); expect(html).not.toContain("Apri pratica");
  });
  it("connected supports terminating and allowlisted transfer; hold is status only", () => {
    const html = render({ ...call, status: "connected", capabilities: { ...call.capabilities, answer: false, transfer: true } });
    expect(html).toContain("In chiamata"); expect(html).toContain("Termina"); expect(html).toContain("Trasferisci");
    for (const dn of ["913", "910", "911", "912"]) expect(html).toContain(`value="${dn}"`);
    expect(html).not.toContain('value="901"'); expect(html).not.toContain("Rifiuta");
    expect(render({ ...call, status: "hold" })).toContain("In attesa");
  });
  it("decodes UTF-8 SSE across chunk boundaries, snapshots and heartbeat without duplicate events", async () => {
    const events: any[] = [], encoder = new TextEncoder();
    const response = new Response(new ReadableStream({ start(controller) {
      const bytes = encoder.encode('event: calls\ndata: {"calls":[{"callId":"123","customerName":"Nicolò"}]}\n\n: heartbeat\n\nevent: calls\ndata: {"calls":[]}\n\n');
      for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close();
    } }));
    await consumeCallStream(response, (event, data) => events.push({ event, data }));
    expect(events).toHaveLength(2); expect(events[0].data.calls[0].customerName).toBe("Nicolò"); expect(events[1].data.calls).toEqual([]);
  });
});
