import { describe, expect, it } from "vitest";
import { alertBody, ringingCalls } from "./incoming-alert";

describe("incoming call alert", () => {
  it("rings only for a customer calling in, not for our own callback or a call in progress", () => {
    const calls = [
      { callId: "1", direction: "inbound", status: "ringing" },
      { callId: "2", direction: "outbound", status: "ringing" },
      { callId: "3", direction: "inbound", status: "connected" }
    ];
    expect(ringingCalls(calls).map((call) => call.callId)).toEqual(["1"]);
  });

  it("says who is calling with what it knows", () => {
    const base = { callId: "1", direction: "inbound", status: "ringing" };
    expect(alertBody({ ...base, customerName: "Mario Rossi", customerPhone: "+39333" })).toBe("Mario Rossi · +39333");
    expect(alertBody({ ...base, customerPhone: "+39333" })).toBe("+39333");
    expect(alertBody(base)).toBe("Numero sconosciuto");
  });
});
