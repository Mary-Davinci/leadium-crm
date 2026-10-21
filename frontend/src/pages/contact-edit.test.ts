import { describe, expect, it } from "vitest";
import { contactPatch, splitContactDraft } from "./pratica-detail-page";

describe("contact correction draft", () => {
  it("shows the first word as Nome and the rest as Cognome", () => {
    expect(splitContactDraft({ fullName: "  Anna   Maria Verdi ", phone: "+39 333 1", email: "a@b.it" }))
      .toEqual({ firstName: "Anna", lastName: "Maria Verdi", phone: "+39 333 1", email: "a@b.it" });
    expect(splitContactDraft({ fullName: "Cher" })).toEqual({ firstName: "Cher", lastName: "", phone: "", email: "" });
    expect(splitContactDraft(null)).toEqual({ firstName: "", lastName: "", phone: "", email: "" });
  });

  it("sends only what changed, so an untouched legacy phone is never re-validated", () => {
    const initial = splitContactDraft({ fullName: "Anna Verdi", phone: "333 1234567", email: "anna@example.it" });
    expect(contactPatch(initial, initial)).toEqual({});
    expect(contactPatch(initial, { ...initial, lastName: " Verdi  " })).toEqual({});
    expect(contactPatch(initial, { ...initial, firstName: "Anna Maria" })).toEqual({ fullName: "Anna Maria Verdi" });
    expect(contactPatch(initial, { ...initial, email: " anna.verdi@example.it " })).toEqual({ email: "anna.verdi@example.it" });
    expect(contactPatch(initial, { ...initial, email: "" })).toEqual({ email: "" });
    expect(contactPatch(initial, { ...initial, phone: "+39 333 7654321" })).toEqual({ phone: "+39 333 7654321" });
  });
});
