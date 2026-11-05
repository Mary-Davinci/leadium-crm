import assert from "node:assert/strict";
import { ACTIVE_WINDOW_MS, computeTeamDashboard, isClosedPractice } from "./dashboard-team";

const now = Date.parse("2026-11-05T11:00:00Z"); // 12:00 in Rome
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const operators = [
  { username: "marta", name: "Marta", surname: "Rossi", threeCxDn: "913" },
  { username: "luca", name: "Luca", threeCxDn: "901" },
  { username: "sara", name: "Sara" }
];
const base = { operators, leads: [], tasks: [], calls: [], quotedLeadIds: [], conversations: [], lastSeen: new Map<string, number>(), onCallDns: new Set<string>(), now };
const row = (result: ReturnType<typeof computeTeamDashboard>, username: string) => {
  const found = result.operators.find((item) => item.username === username);
  assert.ok(found, username);
  return found;
};

for (const lead of [{ id: "a", closedAt: at(-5) }, { id: "b", closingOutcome: "won" }, { id: "c", closingOutcome: "lost" }, { id: "d", status: "Persa" }, { id: "e", status: "Chiusa 100%" }]) assert.equal(isClosedPractice(lead), true, JSON.stringify(lead));
assert.equal(isClosedPractice({ id: "f", status: "Da contattare", closingOutcome: "open" }), false);
console.log("PASS closed practices are the ones of the Chiuse tab");

{
  const result = computeTeamDashboard({
    ...base,
    leads: [
      { id: "1", assignedTo: "marta", status: "Da contattare", closingOutcome: "open" },
      { id: "2", assignedTo: "Marta Rossi", status: "Contatto interessato", closingOutcome: "open" },
      { id: "3", assignedTo: "marta", status: "Persa", closingOutcome: "lost" },
      { id: "4", assignedTo: "luca", status: "Da contattare", closingOutcome: "open" },
      { id: "5", assignedTo: "", status: "Da contattare", closingOutcome: "open" },
      { id: "6", assignedTo: "", status: "Persa", closingOutcome: "lost" },
      { id: "7", assignedTo: "ex-collega", status: "Da contattare", closingOutcome: "open" }
    ]
  });
  const marta = row(result, "marta");
  assert.deepEqual([marta.assigned, marta.open, marta.closed, marta.toContact], [3, 2, 1, 1], "the name counts as the username");
  assert.equal(result.totals.assigned, 4);
  assert.equal(result.totals.unassigned, 1, "only open practices need an operator, and a former colleague's is not 'senza operatore'");
  assert.deepEqual(result.operators.map((item) => item.username), ["marta", "luca", "sara"], "most loaded first; an operator with no work is still shown");
  console.log("PASS leads per operator, open and closed, unassigned");
}

{
  const leads = [{ id: "1", assignedTo: "marta", closingOutcome: "open" }, { id: "2", assignedTo: "marta", closingOutcome: "open" }, { id: "3", assignedTo: "marta", closedAt: at(-1) }];
  const result = computeTeamDashboard({
    ...base, leads,
    tasks: [
      { leadId: "1", kind: "next_action", status: "open", dueAt: at(30) },
      { leadId: "1", kind: "callback_reminder", status: "open", dueAt: at(30) },
      { leadId: "2", kind: "call", status: "open", dueAt: at(-60 * 24 * 2) },
      { leadId: "2", kind: "quote_preparation", status: "open", dueAt: at(5) },
      { leadId: "1", kind: "call", status: "done", dueAt: at(-10) },
      { leadId: "3", kind: "call", status: "open", dueAt: at(10) }
    ],
    calls: [
      { leadId: "1", actor: "marta", startedAt: at(-30) },
      { leadId: "2", actor: "3cx", startedAt: at(-20) },
      { leadId: "", actor: "luca", startedAt: at(-10) },
      { leadId: "1", actor: "marta", startedAt: at(-60 * 24) }
    ]
  });
  const marta = row(result, "marta");
  assert.equal(marta.todo, 1, "a callback's two tasks are one call; yesterday's late one is not today's");
  assert.equal(marta.follow, 2);
  assert.equal(marta.followLate, 1);
  assert.equal(marta.done, 2, "a 3CX log counts for the practice's operator; yesterday does not count");
  assert.equal(row(result, "luca").done, 1, "a call with no practice stays with who made it");
  console.log("PASS calls and follow-ups: one per practice, today only, late apart");
}

{
  // Rome's day, not the server's: 23:30 UTC on the 4th is already the 5th in Rome.
  const result = computeTeamDashboard({ ...base, leads: [{ id: "1", assignedTo: "marta" }], calls: [{ leadId: "1", actor: "marta", startedAt: "2026-11-04T23:30:00Z" }, { leadId: "1", actor: "marta", startedAt: "2026-11-04T22:30:00Z" }] });
  assert.equal(row(result, "marta").done, 1);
  console.log("PASS the day is Rome's");
}

{
  const leads = [{ id: "1", assignedTo: "marta" }, { id: "2", assignedTo: "marta" }, { id: "3", assignedTo: "marta", nextActionAt: at(600) }, { id: "4", assignedTo: "marta", closingOutcome: "lost" }];
  const result = computeTeamDashboard({ ...base, leads, tasks: [{ leadId: "1", kind: "quote_preparation", status: "open" }], quotedLeadIds: ["1", "1", "2", "3", "4"] });
  assert.deepEqual([row(result, "marta").quotes, row(result, "marta").quotesOpen], [3, 1], "closed practices leave, a repeated quote counts once, a next step of any kind counts");
  console.log("PASS quotes and their next step");
}

{
  const result = computeTeamDashboard({
    ...base,
    conversations: [
      { assignedTo: "marta", lastInboundAt: at(-30), lastOutboundAt: at(-60) },
      { assignedTo: "marta", lastInboundAt: at(-60), lastOutboundAt: at(-5) },
      { assignedTo: "marta", lastInboundAt: at(-30), status: "resolved" },
      { assignedTo: "marta", lastInboundAt: at(-60 * 24 * 8) },
      { assignedTo: "", lastInboundAt: at(-10) }
    ]
  });
  assert.deepEqual([row(result, "marta").chats, row(result, "marta").waiting], [2, 1], "answered today counts as handled; old and resolved chats do not wait");
  assert.equal(result.totals.waiting, 2, "a customer nobody took is waiting too");
  console.log("PASS WhatsApp handled today and waiting");
}

{
  const result = computeTeamDashboard({ ...base, lastSeen: new Map([["marta", now - 1000], ["luca", now - 1000], ["sara", now - ACTIVE_WINDOW_MS - 1]]), onCallDns: new Set(["901"]) });
  assert.deepEqual(["marta", "luca", "sara"].map((name) => row(result, name).presence), ["active", "call", "inactive"]);
  console.log("PASS status: on a call beats active; no signal for a while is inactive");
}
