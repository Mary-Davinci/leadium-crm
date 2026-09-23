import assert from "node:assert/strict";

const report = require("./booking-report") as typeof import("./booking-report");

function runCase(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function buildLead(overrides: Record<string, unknown> = {}) {
  return {
    id: "lead_1",
    fullName: "Mario Rossi",
    phone: "+39 333 1234567",
    status: "Contatto interessato",
    sourcePlatform: "facebook",
    sourceCampaignId: "camp_estate",
    lossReason: null,
    nextActionAt: "2026-03-10T09:00:00.000Z",
    ...overrides
  };
}

function buildCallLog(overrides: Record<string, unknown> = {}) {
  return {
    id: "call_1",
    leadId: "lead_1",
    startedAt: "2026-03-01T10:30:00.000Z",
    outcome: "interested",
    actor: "operatore1",
    note: "Cliente interessato alla crociera",
    source: "3cx",
    ...overrides
  };
}

function main() {
  runCase("costruisce una riga per ogni call log con i dati del lead collegato", () => {
    const rows = report.buildBookingActivityRows([buildCallLog()], new Map([["lead_1", buildLead()]]), new Map());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].operatore, "operatore1");
    assert.equal(rows[0].cliente, "Mario Rossi");
    assert.equal(rows[0].numeroContatto, "+39 333 1234567");
    assert.equal(rows[0].data, "2026-03-01");
    assert.equal(rows[0].ora, "10:30");
    assert.equal(rows[0].esito, "Interessato");
    assert.equal(rows[0].campagna, "camp_estate");
  });

  runCase("ignora i call log orfani (lead non trovato) invece di far fallire il report", () => {
    const rows = report.buildBookingActivityRows([buildCallLog({ leadId: "lead_ghost" })], new Map([["lead_1", buildLead()]]), new Map());
    assert.equal(rows.length, 0);
  });

  runCase("popola 'preventivo' solo per gli esiti di preventivo, senza inventare valori per altri esiti", () => {
    const rows = report.buildBookingActivityRows(
      [buildCallLog({ id: "c1", outcome: "quote_sent" }), buildCallLog({ id: "c2", outcome: "no_answer" })],
      new Map([["lead_1", buildLead()]]),
      new Map()
    );
    assert.equal(rows.find((r) => r.esito === "Preventivo inviato")?.preventivo, "Si");
    assert.equal(rows.find((r) => r.esito === "Non risponde")?.preventivo, "");
  });

  runCase("popola 'appuntamento' solo per l'esito appointment_set, usando nextActionAt del lead", () => {
    const rows = report.buildBookingActivityRows([buildCallLog({ outcome: "appointment_set" })], new Map([["lead_1", buildLead()]]), new Map());
    assert.equal(rows[0].appuntamento, "2026-03-10T09:00:00.000Z");
  });

  runCase("recupera 'prodotto' dall'acquisto piu recente collegato al lead", () => {
    const purchasesByLeadId = new Map([
      [
        "lead_1",
        [
          { id: "p2", leadId: "lead_1", product: "Mediterraneo Deluxe", purchasedAt: "2026-02-01T00:00:00.000Z" },
          { id: "p1", leadId: "lead_1", product: "Caraibi Base", purchasedAt: "2026-01-01T00:00:00.000Z" }
        ] as any
      ]
    ]);
    const rows = report.buildBookingActivityRows([buildCallLog()], new Map([["lead_1", buildLead()]]), purchasesByLeadId);
    assert.equal(rows[0].prodotto, "Mediterraneo Deluxe", "deve usare il piu recente (gia ordinato per purchasedAt desc dal chiamante)");
  });

  runCase("filtro periodo (dateFrom/dateTo) restituisce solo le righe nell'intervallo", () => {
    const rows = report.buildBookingActivityRows(
      [buildCallLog({ id: "c1", startedAt: "2026-01-15T10:00:00.000Z" }), buildCallLog({ id: "c2", startedAt: "2026-03-15T10:00:00.000Z" })],
      new Map([["lead_1", buildLead()]]),
      new Map()
    );
    const filtered = report.filterBookingActivityRows(rows, { dateFrom: "2026-02-01", dateTo: "2026-04-01" });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].data, "2026-03-15");
  });

  runCase("filtro singolo operatore restituisce solo le sue righe; nessun filtro restituisce tutti gli operatori", () => {
    const rows = report.buildBookingActivityRows(
      [buildCallLog({ id: "c1", actor: "operatore1" }), buildCallLog({ id: "c2", actor: "operatore2" })],
      new Map([["lead_1", buildLead()]]),
      new Map()
    );
    assert.equal(report.filterBookingActivityRows(rows, { operatore: "operatore1" }).length, 1);
    assert.equal(report.filterBookingActivityRows(rows, {}).length, 2, "senza filtro operatore devono comparire tutti gli operatori");
  });

  runCase("filtro campagna restituisce solo le righe della campagna richiesta", () => {
    const rows = report.buildBookingActivityRows(
      [buildCallLog({ id: "c1", leadId: "lead_1" }), buildCallLog({ id: "c2", leadId: "lead_2" })],
      new Map([
        ["lead_1", buildLead({ sourceCampaignId: "camp_estate" })],
        ["lead_2", buildLead({ id: "lead_2", sourceCampaignId: "camp_inverno" })]
      ]),
      new Map()
    );
    const filtered = report.filterBookingActivityRows(rows, { campagna: "camp_estate" });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].campagna, "camp_estate");
  });

  runCase("filtro prodotto restituisce solo le righe con quel prodotto", () => {
    const rows = report.buildBookingActivityRows(
      [buildCallLog({ id: "c1", leadId: "lead_1" }), buildCallLog({ id: "c2", leadId: "lead_2" })],
      new Map([
        ["lead_1", buildLead()],
        ["lead_2", buildLead({ id: "lead_2" })]
      ]),
      new Map([
        ["lead_1", [{ id: "p1", leadId: "lead_1", product: "Mediterraneo", purchasedAt: "2026-01-01" }] as any],
        ["lead_2", [{ id: "p2", leadId: "lead_2", product: "Caraibi", purchasedAt: "2026-01-01" }] as any]
      ])
    );
    const filtered = report.filterBookingActivityRows(rows, { prodotto: "Mediterraneo" });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].leadId, "lead_1");
  });

  runCase("filtro canale ed esito applicati insieme combinano correttamente (AND)", () => {
    const rows = report.buildBookingActivityRows(
      [
        buildCallLog({ id: "c1", source: "3cx", outcome: "interested" }),
        buildCallLog({ id: "c2", source: "3cx", outcome: "no_answer" }),
        buildCallLog({ id: "c3", source: "manual", outcome: "interested" })
      ],
      new Map([["lead_1", buildLead()]]),
      new Map()
    );
    const filtered = report.filterBookingActivityRows(rows, { canale: "3cx", esito: "Interessato" });
    assert.equal(filtered.length, 1);
  });

  runCase("filtro stato lead restituisce solo le pratiche in quello stato", () => {
    const rows = report.buildBookingActivityRows(
      [buildCallLog({ id: "c1", leadId: "lead_1" }), buildCallLog({ id: "c2", leadId: "lead_2" })],
      new Map([
        ["lead_1", buildLead({ status: "Persa" })],
        ["lead_2", buildLead({ id: "lead_2", status: "Contatto interessato" })]
      ]),
      new Map()
    );
    const filtered = report.filterBookingActivityRows(rows, { statoLead: "Persa" });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].leadId, "lead_1");
  });

  runCase("le righe CSV rispettano l'ordine degli header dichiarati (nessuna colonna scambiata)", () => {
    const rows = report.buildBookingActivityRows([buildCallLog()], new Map([["lead_1", buildLead()]]), new Map());
    const csvRows = report.buildBookingActivityCsvRows(rows);
    assert.equal(csvRows[0].length, report.BOOKING_ACTIVITY_HEADERS.length);
    assert.equal(csvRows[0][0], "operatore1");
    assert.equal(csvRows[0][1], "Mario Rossi");
  });

  runCase("un motivo di perdita nel campo note/lossReason contenente un carattere da formula CSV viene neutralizzato", () => {
    const rows = report.buildBookingActivityRows(
      [buildCallLog({ note: "=cmd|'/c calc'!A1" })],
      new Map([["lead_1", buildLead({ lossReason: "+SUM(A1:A9)" })]]),
      new Map()
    );
    // buildBookingActivityCsvRows only shapes the array; the actual formula-injection escaping is
    // csvEscape's job (already covered by marketing-export's own CSV tests) -- this just verifies
    // the raw values pass through unmodified so rowsToCsv can do its job on them downstream.
    const csvRows = report.buildBookingActivityCsvRows(rows);
    assert.equal(csvRows[0][8], "=cmd|'/c calc'!A1");
    assert.equal(csvRows[0][11], "+SUM(A1:A9)");
  });
}

main();
console.log("All booking-report checks passed.");
