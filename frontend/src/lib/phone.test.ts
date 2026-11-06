import { describe, expect, it } from "vitest";
import { isUsablePhone } from "./phone";

describe("isUsablePhone", () => {
  it("accepts the numbers the team writes", () => {
    for (const phone of ["3895382595", "+393381216940", "+39 338 121 6940", "0039 338 1216940", "p:+393381216940", "06 12345678"]) expect(isUsablePhone(phone)).toBe(true);
  });
  it("refuses what cannot be a phone", () => {
    for (const phone of ["D'AMATO", "", null, undefined, "123", "393381216940123456"]) expect(isUsablePhone(phone)).toBe(false);
  });
});
