import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const analyticsService = require("./server") as typeof import("./server");
const csv = require("../common/csv") as typeof import("../common/csv");

function buildLead(overrides: Record<string, unknown> = {}) {
  return {
    id: "lead_1",
    fullName: "Mario Rossi",
    phone: "+39 333 1234567",
    email: "mario@example.com",
    source: "facebook_lead_ads",
    sourcePlatform: "facebook",
    sourceCampaignId: "camp_1",
    assignedTo: "operatore1",
    status: "Persa",
    notes: "Nota operativa riservata sul cliente.",
    closingOutcome: "lost",
    lossReason: "fuori_budget",
    lossDetail: "Budget insufficiente per la crociera richiesta.",
    createdAt: "2026-02-10T09:00:00.000Z",
    lastContactAt: "2026-02-12T09:00:00.000Z",
    ...overrides
  };
}

function runCase(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function main() {
  runCase("segmenta correttamente i lead con esito lost", () => {
    const leads = [buildLead({ id: "l1", closingOutcome: "lost" }), buildLead({ id: "l2", closingOutcome: "open" })];
    const result = analyticsService.filterDeadContacts(leads, {});
    assert.deepEqual(result.map((lead) => lead.id), ["l1"]);
  });

  runCase("segmenta correttamente i lead con esito disqualified", () => {
    const leads = [buildLead({ id: "l1", closingOutcome: "disqualified" }), buildLead({ id: "l2", closingOutcome: "won" })];
    const result = analyticsService.filterDeadContacts(leads, {});
    assert.deepEqual(result.map((lead) => lead.id), ["l1"]);
  });

  runCase("lead aperti o vinti sono esclusi dal segmento contatti morti", () => {
    const leads = [
      buildLead({ id: "l1", closingOutcome: "open" }),
      buildLead({ id: "l2", closingOutcome: "won" }),
      buildLead({ id: "l3", closingOutcome: "lost" })
    ];
    const result = analyticsService.filterDeadContacts(leads, {});
    assert.deepEqual(result.map((lead) => lead.id), ["l3"]);
  });

  runCase("filtri campagna, periodo e operatore vengono applicati correttamente", () => {
    const leads = [
      buildLead({ id: "in_range", sourceCampaignId: "camp_1", assignedTo: "op1", createdAt: "2026-03-05T00:00:00.000Z" }),
      buildLead({ id: "wrong_campaign", sourceCampaignId: "camp_2", assignedTo: "op1", createdAt: "2026-03-05T00:00:00.000Z" }),
      buildLead({ id: "wrong_operator", sourceCampaignId: "camp_1", assignedTo: "op2", createdAt: "2026-03-05T00:00:00.000Z" }),
      buildLead({ id: "out_of_range", sourceCampaignId: "camp_1", assignedTo: "op1", createdAt: "2026-05-20T00:00:00.000Z" })
    ];
    const result = analyticsService.filterDeadContacts(leads, {
      sourceCampaignId: "camp_1",
      assignedTo: "op1",
      dateFrom: "2026-03-01T00:00:00.000Z",
      dateTo: "2026-03-31T23:59:59.000Z"
    });
    assert.deepEqual(result.map((lead) => lead.id), ["in_range"]);
  });

  runCase("il CSV interno e correttamente escapato per virgole, virgolette e newline", () => {
    const leads = [
      buildLead({
        id: "esc_1",
        fullName: 'Cliente "VIP", con virgola',
        notes: "riga1\nriga2",
        lossDetail: 'Motivo con "virgolette" e, virgola'
      })
    ];
    const rows = analyticsService.buildInternalExportRows(leads);
    const output = csv.rowsToCsv(analyticsService.INTERNAL_EXPORT_HEADERS, rows);
    assert.ok(output.startsWith("﻿"), "il CSV deve iniziare con il BOM UTF-8 per Excel");
    assert.ok(output.includes('"Cliente ""VIP"", con virgola"'), "virgolette raddoppiate e campo tra virgolette per la virgola");
    assert.ok(output.includes('"Motivo con ""virgolette"" e, virgola"'));
  });

  runCase("l'export Meta non contiene note operative ne dati sensibili, solo i campi minimi", () => {
    const leads = [buildLead({ id: "meta_1" })];
    const rows = analyticsService.buildMetaExportRows(leads);
    const output = csv.rowsToCsv(analyticsService.META_EXPORT_HEADERS, rows);
    assert.deepEqual(analyticsService.META_EXPORT_HEADERS, ["nome", "telefono", "email"]);
    assert.ok(!output.includes("Nota operativa riservata"), "le note operative non devono comparire nell'export Meta");
    assert.ok(!output.includes("Budget insufficiente"), "il dettaglio perdita non deve comparire nell'export Meta");
    assert.ok(!output.includes("fuori_budget"), "il motivo perdita non deve comparire nell'export Meta");
    assert.ok(!output.includes("operatore1"), "l'operatore assegnato non deve comparire nell'export Meta");
  });

  runCase("un lead con marketingConsent=false viene escluso anche se altrimenti candidato", () => {
    const leads = [buildLead({ id: "optout", marketingConsent: false }), buildLead({ id: "ok" })];
    const result = analyticsService.filterDeadContacts(leads, {});
    assert.deepEqual(result.map((lead) => lead.id), ["ok"]);
  });

  runCase("CSV interno: una cella che inizia con = viene neutralizzata (CSV/formula injection)", () => {
    const leads = [buildLead({ id: "inj_1", fullName: '=cmd|"/c calc"!A1' })];
    const rows = analyticsService.buildInternalExportRows(leads);
    const output = csv.rowsToCsv(analyticsService.INTERNAL_EXPORT_HEADERS, rows);
    assert.ok(!output.includes('"=cmd'), "il valore non deve comparire con = come primo carattere del campo");
    assert.ok(output.includes("'=cmd") || output.includes("\"'=cmd"), "deve essere prefissato con un apice per essere letto come testo");
  });

  runCase("CSV: celle che iniziano con +, -, @ o * vengono tutte neutralizzate", () => {
    for (const trigger of ["=", "+", "-", "@", "*"]) {
      const escaped = csv.csvEscape(`${trigger}cmd|calc.exe`);
      assert.ok(escaped.startsWith(`'${trigger}`), `il carattere "${trigger}" deve essere neutralizzato, ottenuto: ${escaped}`);
    }
  });

  runCase("CSV: un valore che non inizia con un carattere di formula resta invariato", () => {
    assert.equal(csv.csvEscape("Mario Rossi"), "Mario Rossi");
    assert.equal(csv.csvEscape("mario@example.com"), "mario@example.com");
  });

  runCase("CSV: un numero di telefono che inizia con + viene comunque neutralizzato (stesso trigger char)", () => {
    // Phone numbers commonly start with "+" (international prefix), which is also a formula
    // trigger character -- this is exactly the real-world case the guard exists for.
    assert.equal(csv.csvEscape("+39 333 1234567"), "'+39 333 1234567");
  });

  runCase("export Meta: anche i campi minimi vengono neutralizzati da CSV injection", () => {
    const leads = [buildLead({ id: "inj_meta", fullName: "@SUM(1+1)*cmd" })];
    const rows = analyticsService.buildMetaExportRows(leads);
    const output = csv.rowsToCsv(analyticsService.META_EXPORT_HEADERS, rows);
    assert.ok(!output.includes('"@SUM'), "il valore non deve comparire con @ come primo carattere del campo");
  });
}

main();
console.log("All marketing-export checks passed.");
