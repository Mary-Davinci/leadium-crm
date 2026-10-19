import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssignPracticeModal, assigneeLabels, findAssignee, type Assignee } from "./AssignPracticeModal";

const users: Assignee[] = [
  { id: "u1", username: "Giuseppe", name: "Giuseppe", surname: "Piraino" },
  { id: "u2", username: "giuseppe.r", name: "Giuseppe", surname: "Piraino" },
  { id: "u3", username: "marta", name: "Marta", surname: "" }
];

describe("assign practice dialog", () => {
  it("shows name and surname, adding the username only to tell homonyms apart", () => {
    const labels = assigneeLabels(users);
    expect(labels.get("u1")).toBe("Giuseppe Piraino (@Giuseppe)");
    expect(labels.get("u2")).toBe("Giuseppe Piraino (@giuseppe.r)");
    expect(labels.get("u3")).toBe("Marta");
  });

  it("recognises the current assignee from the stored username or an older stored name", () => {
    expect(findAssignee(users, "giuseppe")?.id).toBe("u1");
    expect(findAssignee(users, "Marta")?.id).toBe("u3");
    expect(findAssignee(users, "me")).toBeNull();
    expect(findAssignee(users, "")).toBeNull();
  });

  it("opens on the practice with no preselected or free-text assignee", () => {
    const html = renderToStaticMarkup(
      <AssignPracticeModal lead={{ id: "lead_1", fullName: "Cliente Prova", assignedTo: "" }} onClose={() => {}} onAssigned={() => {}} />
    );
    expect(html).toContain("Assegna pratica");
    expect(html).toContain("Cliente Prova");
    expect(html).toContain("Caricamento operatori");
    expect(html).not.toContain('value="me"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Conferma assegnazione<\/button>/);
  });
});
