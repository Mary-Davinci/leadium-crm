import { afterEach, describe, expect, it, vi } from "vitest";
import { answerFailureMessage, answerViaExtension, extensionCanAnswer } from "./extension-answer";

/** A page with the extension's bridge on the other side of postMessage. */
function fakePage(reply?: (request: Record<string, unknown>) => Record<string, unknown>) {
  const page = new EventTarget() as EventTarget & Record<string, unknown>;
  const deliver = (data: unknown) => page.dispatchEvent(Object.assign(new Event("message"), { data, source: page }));
  Object.assign(page, {
    location: { origin: "https://leadium.test" },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    postMessage(data: Record<string, unknown>) {
      if (data.type === "answer-call" && reply) queueMicrotask(() => deliver(reply(data)));
    }
  });
  vi.stubGlobal("window", page);
  return deliver;
}
const result = (body: unknown) => (request: Record<string, unknown>) => ({ source: "leadium-3cx-extension", type: "answer-result", requestId: request.requestId, result: body });

describe("answering through the extension", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is offered only where the extension marked the page", () => {
    vi.stubGlobal("document", { documentElement: { hasAttribute: () => false } });
    expect(extensionCanAnswer()).toBe(false);
    vi.stubGlobal("document", { documentElement: { hasAttribute: (name: string) => name === "data-leadium-3cx-answer" } });
    expect(extensionCanAnswer()).toBe(true);
  });
  it("resolves empty once Answer is pressed", async () => {
    fakePage(result({ ok: true }));
    await expect(answerViaExtension("55", "+393331112222")).resolves.toBeNull();
  });
  it("tells the operator what went wrong", async () => {
    fakePage(result({ ok: false, reason: "no-tab" }));
    await expect(answerViaExtension("55", "+393331112222")).resolves.toBe(answerFailureMessage("no-tab"));
  });
  it("ignores the outcome of another request and does not hang on a silent extension", async () => {
    fakePage(() => ({ source: "leadium-3cx-extension", type: "answer-result", requestId: "someone-else", result: { ok: true } }));
    await expect(answerViaExtension("55", "+393331112222", 20)).resolves.toBe(answerFailureMessage("extension-stale"));
  });
});
