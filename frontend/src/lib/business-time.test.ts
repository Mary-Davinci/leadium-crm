import { afterEach, describe, expect, it, vi } from "vitest";
import { romeCalendarDate, romeDateTimeInput, romeDayStamp, romeInputToIso } from "./business-time";

afterEach(() => vi.unstubAllEnvs());

describe("CRM uses the Rome calendar independently of device/hosting timezone", () => {
  it.each(["UTC", "America/New_York", "Asia/Tokyo"])("converts Italian wall-clock inputs with device timezone %s", zone => {
    vi.stubEnv("TZ", zone);
    expect(romeInputToIso("2026-11-02T10:30")).toBe("2026-11-02T09:30:00.000Z");
    expect(romeInputToIso("2026-07-02T10:30")).toBe("2026-07-02T08:30:00.000Z");
    expect(romeDateTimeInput("2026-11-02T09:30:00Z")).toBe("2026-11-02T10:30");
    expect(romeDateTimeInput("2026-07-02T08:30:00Z")).toBe("2026-07-02T10:30");
  });
  it("rejects nonexistent spring times and invalid calendar dates", () => {
    expect(() => romeInputToIso("2026-03-29T02:30")).toThrow(/non esiste/);
    for (const input of ["2026-02-30T12:00", "2026-11-02T24:10", "bad date"]) expect(() => romeInputToIso(input)).toThrow();
  });
  it("handles both offsets at the autumn transition and resolves repeated input deterministically", () => {
    expect(romeDateTimeInput("2026-10-25T00:30:00Z")).toBe("2026-10-25T02:30");
    expect(romeDateTimeInput("2026-10-25T01:30:00Z")).toBe("2026-10-25T02:30");
    expect(romeInputToIso("2026-10-25T02:30")).toBe("2026-10-25T00:30:00.000Z");
  });
  it("keeps tomorrow at 09:00 across 23-hour and 25-hour days", () => {
    expect(romeCalendarDate("2026-03-28T08:00:00Z", 1, 9).toISOString()).toBe("2026-03-29T07:00:00.000Z");
    expect(romeCalendarDate("2026-10-24T07:00:00Z", 1, 9).toISOString()).toBe("2026-10-25T08:00:00.000Z");
    expect(romeCalendarDate("2026-03-28T01:30:00Z", 1).toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });
  it("groups today/yesterday by Italian midnight and counts calendar days across DST", () => {
    expect(romeDayStamp("2026-11-01T23:30:00Z")).toBe(Date.UTC(2026, 10, 2));
    expect(romeDayStamp("2026-03-29T12:00:00Z") - romeDayStamp("2026-03-28T12:00:00Z")).toBe(86400000);
    expect(romeDayStamp("2026-10-25T12:00:00Z") - romeDayStamp("2026-10-24T12:00:00Z")).toBe(86400000);
    expect(Number.isNaN(romeDayStamp("invalid"))).toBe(true);
  });
});
