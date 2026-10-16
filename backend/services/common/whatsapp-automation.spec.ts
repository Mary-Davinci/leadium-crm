import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const engine = require("./whatsappAutomation") as typeof import("./whatsappAutomation");
const { LEAD_STATUSES } = require("./workflow") as typeof import("./workflow");

// The real template configuration, so the rules are tested against what ships.
const CONFIG_PATH = path.join(__dirname, "..", "..", "..", "config", "whatsapp-templates.json");
const TEMPLATES = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as import("./whatsappAutomation").TemplateDefinition[];

// Same templates with the Booking sequence switched to automatic, for the sequence tests.
const AUTOMATIC = TEMPLATES.map((item) =>
  ["lead_first_contact", "lead_no_answer_followup", "final_recovery", "contact_closure", "quote_followup"].includes(item.key)
    ? { ...item, automationMode: "automatic_allowed" as const }
    : item
);

const NOW = new Date("2026-10-16T10:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

function ctx(overrides: Partial<import("./whatsappAutomation").AutomationContext> = {}) {
  return {
    lead: { id: "lead_1", status: LEAD_STATUSES.TO_CONTACT, closingOutcome: "open", productInterest: "Crociera Fiordi" },
    conversation: { lastInboundAt: null },
    sent: [],
    templates: TEMPLATES,
    now: NOW,
    automationEnabled: false,
    ...overrides
  } as import("./whatsappAutomation").AutomationContext;
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
  runCase("PM: testi definitivi, variabili Meta esatte e stato prudente", () => {
    const expected = {
    "lead_first_contact": "Ciao, siamo il team Crocieriamo!\n\nAbbiamo ricevuto la tua richiesta di informazioni per {{1}}.\n\nPer aiutarti nel modo più semplice, preferisci essere ricontattato telefonicamente oppure continuare qui su WhatsApp?",
    "lead_no_answer_followup": "Ciao, ti contattiamo in merito alla richiesta che hai inviato a Crocieriamo per {{1}}.\n\nSe sei ancora interessato, puoi risponderci direttamente qui e proseguiremo con la tua richiesta.",
    "lead_qualification": "Ciao! Per individuare la proposta più adatta alle tue esigenze, avremmo bisogno di alcune informazioni:\n\n- Destinazione o tipo di viaggio che stai cercando.\n- Periodo indicativo della partenza.\n- Numero di persone che viaggeranno.\n\nPuoi risponderci direttamente qui: ti aiuteremo a individuare la soluzione più adatta.",
    "call_no_answer": "Ciao, abbiamo provato a contattarti telefonicamente in merito alla tua richiesta a Crocieriamo.\n\nSe preferisci, possiamo proseguire direttamente qui su WhatsApp oppure concordare un momento più comodo per sentirci.",
    "quote_ready": "Ciao, abbiamo preparato la proposta relativa alla tua richiesta!\n\nPuoi consultarla al seguente link:\n\n{{1}}\n\nSe desideri maggiori informazioni o vuoi valutare eventuali alternative, siamo a disposizione per aiutarti.",
    "quote_followup": "Ciao, ti contattiamo per sapere se hai avuto modo di valutare la proposta che ti abbiamo inviato.\n\nSe c'è qualcosa che vorresti rivedere, come il prezzo, le date o la soluzione proposta, possiamo verificare insieme le alternative disponibili.",
    "budget_alternative": "Ciao, se la proposta ricevuta supera il budget che avevi previsto, possiamo verificare se esistono alternative più adatte alle tue esigenze.\n\nSe vuoi, indicaci il budget indicativo che desideri rispettare e valuteremo le opzioni disponibili.",
    "interested_undecided": "Ciao, siamo a disposizione se desideri chiarire qualche dettaglio prima di prendere una decisione.\n\nSe ti fa comodo, possiamo concordare un momento per rivedere insieme la proposta e rispondere alle tue domande.\n\nQuando preferisci essere ricontattato?",
    "final_recovery": "Ciao, ti ricontattiamo un'ultima volta in merito alla tua richiesta a Crocieriamo.\n\nSe sei ancora interessato, puoi risponderci direttamente qui e riprenderemo la valutazione della tua richiesta.\n\nSe invece hai già risolto o non desideri proseguire, non continueremo a inviarti solleciti relativi a questa pratica.",
    "contact_closure": "Ciao, per il momento chiudiamo il seguito della tua richiesta, così da non inviarti ulteriori solleciti relativi a questa pratica.\n\nTi ringraziamo per aver contattato Crocieriamo."
};
    for (const [key, body] of Object.entries(expected)) {
      const template = TEMPLATES.find(item => item.key === key)!;
      assert.equal(template.body, body, key);
      assert.equal((template as any).bodyDraft, undefined, key);
      assert.equal(template.metaStatus, key === "quote_ready" ? "pending" : "approved", key);
      assert.equal(template.automationMode, "manual_only", key);
      const placeholders = [...body.matchAll(/\{\{(\d+)\}\}/g)].map(match => Number(match[1]));
      assert.deepEqual((template.parameters || []).map(parameter => parameter.index), placeholders, key);
    }
  });

  runCase("Template 2: destinazione obbligatoria e components Cloud API", () => {
    const template = engine.findTemplate(TEMPLATES, "lead_no_answer_followup")!;
    const check = engine.checkTemplateSend(ctx(), template.key, "manual");
    assert.equal(check.allowed, true);
    assert.deepEqual(engine.buildTemplateComponents(template, check.values!), [
      { type: "body", parameters: [{ type: "text", text: "Crociera Fiordi" }] }
    ]);
    const missing = engine.checkTemplateSend(ctx({ lead: { id: "lead_1" } }), template.key, "manual");
    assert.equal(missing.code, "missing_parameters");
  });


  runCase("config: i 10 template Booking sono presenti e i vecchi restano disponibili", () => {
    const keys = TEMPLATES.map((item) => item.key);
    for (const key of [
      "lead_first_contact",
      "lead_no_answer_followup",
      "lead_qualification",
      "call_no_answer",
      "quote_ready",
      "quote_followup",
      "budget_alternative",
      "interested_undecided",
      "final_recovery",
      "contact_closure",
      "primo_contatto_cliente",
      "request_documents"
    ]) {
      assert.ok(keys.includes(key), `manca il template ${key}`);
    }
  });

  runCase("default prudente: nessun template e automatic_allowed nella configurazione di produzione", () => {
    assert.equal(TEMPLATES.filter((item) => item.automationMode === "automatic_allowed").length, 0);
  });

  runCase("Template 1 sostituisce {{1}} con prodotto/destinazione e genera i components Cloud API", () => {
    const template = engine.findTemplate(TEMPLATES, "lead_first_contact")!;
    const check = engine.checkTemplateSend(ctx(), "lead_first_contact", "manual");
    assert.equal(check.allowed, true);
    assert.equal(check.values!.destination, "Crociera Fiordi");
    assert.ok(engine.renderTemplateBody(template, check.values!).includes("Crociera Fiordi"));
    assert.ok(!engine.renderTemplateBody(template, check.values!).includes("{{1}}"));
    assert.deepEqual(engine.buildTemplateComponents(template, check.values!), [
      { type: "body", parameters: [{ type: "text", text: "Crociera Fiordi" }] }
    ]);
  });

  runCase("Template 1: il valore inserito dall'operatore prevale su quello del lead", () => {
    const check = engine.checkTemplateSend(ctx(), "lead_first_contact", "manual", { destination: "Mediterraneo" });
    assert.equal(check.values!.destination, "Mediterraneo");
  });

  runCase("Template 1 senza destinazione non parte (nessun valore inventato)", () => {
    const check = engine.checkTemplateSend(ctx({ lead: { id: "lead_1", status: LEAD_STATUSES.TO_CONTACT } }), "lead_first_contact", "manual");
    assert.equal(check.allowed, false);
    assert.equal(check.code, "missing_parameters");
  });

  runCase("Template 5 sostituisce l'URL del preventivo", () => {
    const template = engine.findTemplate(TEMPLATES, "quote_ready")!;
    const lead = { id: "lead_1", status: LEAD_STATUSES.INTERESTED, quoteUrl: "https://crocieriamo.it/p/abc123" };
    const check = engine.checkTemplateSend(ctx({ lead }), "quote_ready", "manual");
    assert.equal(check.allowed, true);
    assert.ok(engine.renderTemplateBody(template, check.values!).includes("https://crocieriamo.it/p/abc123"));
    assert.deepEqual(engine.buildTemplateComponents(template, check.values!)[0].parameters[0].text, "https://crocieriamo.it/p/abc123");
  });

  runCase("template preventivo non parte senza URL del preventivo (o con un URL non valido)", () => {
    const noQuote = engine.checkTemplateSend(ctx({ lead: { id: "lead_1", status: LEAD_STATUSES.INTERESTED } }), "quote_ready", "manual");
    assert.equal(noQuote.allowed, false);
    assert.equal(noQuote.code, "quote_missing");
    const badUrl = engine.checkTemplateSend(ctx({ lead: { id: "lead_1", quoteUrl: "preventivo.pdf" } }), "quote_ready", "manual");
    assert.equal(badUrl.code, "quote_missing");
  });

  runCase("primo contatto inviato al massimo una volta (anche con il vecchio template di primo contatto)", () => {
    const sentNew = engine.checkTemplateSend(ctx({ sent: [{ key: "lead_first_contact", sentAt: hoursAgo(2) }] }), "lead_first_contact", "manual");
    assert.equal(sentNew.allowed, false);
    assert.equal(sentNew.code, "already_sent");
    const sentLegacy = engine.checkTemplateSend(ctx({ sent: [{ key: "primo_contatto_cliente", sentAt: hoursAgo(2) }] }), "lead_first_contact", "manual");
    assert.equal(sentLegacy.code, "already_sent", "primo_contatto_cliente e lead_first_contact sono lo stesso primo contatto");
  });

  runCase("un invio fallito non conta come inviato: si puo riprovare", () => {
    const check = engine.checkTemplateSend(ctx({ sent: [{ key: "lead_first_contact", sentAt: hoursAgo(2), status: "failed" }] }), "lead_first_contact", "manual");
    assert.equal(check.allowed, true);
  });

  runCase("final_recovery una sola volta", () => {
    const check = engine.checkTemplateSend(ctx({ sent: [{ key: "final_recovery", sentAt: hoursAgo(80) }] }), "final_recovery", "manual");
    assert.equal(check.code, "already_sent");
  });

  runCase("automazione manual_only non parte automaticamente (anche con automazioni attive)", () => {
    const check = engine.checkTemplateSend(ctx({ automationEnabled: true }), "lead_first_contact", "automation");
    assert.equal(check.allowed, false);
    assert.equal(check.code, "manual_only");
    assert.equal(engine.nextAutomaticTemplate(ctx({ automationEnabled: true })), null);
  });

  runCase("interruttore globale spento: nessun invio automatico anche per template automatic_allowed", () => {
    assert.equal(engine.nextAutomaticTemplate(ctx({ templates: AUTOMATIC, automationEnabled: false })), null);
  });

  runCase("sequenza deterministica: primo contatto, poi sollecito solo dopo 24h senza risposta", () => {
    assert.deepEqual(engine.nextAutomaticTemplate(ctx({ templates: AUTOMATIC, automationEnabled: true })), { key: "lead_first_contact" });
    const after2h = ctx({ templates: AUTOMATIC, automationEnabled: true, sent: [{ key: "lead_first_contact", sentAt: hoursAgo(2) }] });
    assert.equal(engine.nextAutomaticTemplate(after2h), null, "prima delle 24h non si sollecita");
    const after25h = ctx({ templates: AUTOMATIC, automationEnabled: true, sent: [{ key: "lead_first_contact", sentAt: hoursAgo(25) }] });
    assert.deepEqual(engine.nextAutomaticTemplate(after25h), { key: "lead_no_answer_followup" });
  });

  runCase("risposta del cliente blocca i follow-up automatici", () => {
    const replied = ctx({
      templates: AUTOMATIC,
      automationEnabled: true,
      sent: [{ key: "lead_first_contact", sentAt: hoursAgo(30) }],
      conversation: { lastInboundAt: hoursAgo(20) }
    });
    assert.equal(engine.nextAutomaticTemplate(replied), null);
    assert.equal(engine.getSequenceStopReason(replied), "customer_replied");
    assert.equal(engine.checkTemplateSend(replied, "lead_no_answer_followup", "automation").code, "customer_replied");
  });

  runCase("vendita/prenotazione blocca i follow-up", () => {
    for (const status of [LEAD_STATUSES.SOLD, LEAD_STATUSES.FIRST_DEPOSIT, LEAD_STATUSES.ONE_SHOT_SALE]) {
      const sold = ctx({ templates: AUTOMATIC, automationEnabled: true, lead: { id: "l", status, productInterest: "x" }, sent: [{ key: "lead_first_contact", sentAt: hoursAgo(30) }] });
      assert.equal(engine.nextAutomaticTemplate(sold), null, status);
      assert.equal(engine.getSequenceStopReason(sold), "sold", status);
    }
  });

  runCase("non interessato blocca i follow-up", () => {
    const lost = ctx({
      templates: AUTOMATIC,
      automationEnabled: true,
      lead: { id: "l", status: LEAD_STATUSES.NOT_INTERESTED, closingOutcome: "disqualified", productInterest: "x" },
      sent: [{ key: "lead_first_contact", sentAt: hoursAgo(30) }]
    });
    assert.equal(engine.nextAutomaticTemplate(lost), null);
    assert.equal(engine.getSequenceStopReason(lost), "not_interested");
    const stopped = ctx({ templates: AUTOMATIC, automationEnabled: true, lead: { id: "l", status: LEAD_STATUSES.TO_CONTACT, productInterest: "x", whatsappAutomation: { stoppedAt: hoursAgo(1), stoppedReason: "not_interested" } } });
    assert.equal(engine.nextAutomaticTemplate(stopped), null, "lo stop da esito 3CX non interessato ferma la sequenza");
  });

  runCase("optOut blocca qualsiasi automazione, ogni invio manuale e i suggerimenti", () => {
    const optedOut = ctx({
      templates: AUTOMATIC,
      automationEnabled: true,
      lead: { id: "l", status: LEAD_STATUSES.TO_CONTACT, productInterest: "x", doNotContact: { active: true, reason: "Richiesta cliente" } }
    });
    assert.equal(engine.nextAutomaticTemplate(optedOut), null);
    assert.equal(engine.checkTemplateSend(optedOut, "lead_first_contact", "manual").code, "opt_out");
    assert.equal(engine.checkTemplateSend(optedOut, "request_documents", "manual").code, "opt_out");
    assert.deepEqual(engine.suggestTemplates(optedOut), []);
    assert.equal(engine.deriveAutomationState(optedOut).stoppedReason, "opt_out");
  });

  runCase("contact_closure termina la sequenza", () => {
    const closed = ctx({
      templates: AUTOMATIC,
      automationEnabled: true,
      sent: [
        { key: "lead_first_contact", sentAt: hoursAgo(300) },
        { key: "lead_no_answer_followup", sentAt: hoursAgo(270) },
        { key: "final_recovery", sentAt: hoursAgo(190) },
        { key: "contact_closure", sentAt: hoursAgo(100) }
      ]
    });
    assert.equal(engine.getSequenceStopReason(closed), "sequence_closed");
    assert.equal(engine.nextAutomaticTemplate(closed), null);
  });

  runCase("stato derivato: primo contatto, ultimo template e passo di follow-up senza dati duplicati", () => {
    const state = engine.deriveAutomationState(
      ctx({
        sent: [
          { key: "lead_first_contact", sentAt: hoursAgo(50) },
          { key: "lead_no_answer_followup", sentAt: hoursAgo(20) }
        ],
        conversation: { lastInboundAt: hoursAgo(5) }
      })
    );
    assert.equal(state.firstContactSentAt, hoursAgo(50));
    assert.equal(state.lastTemplateKey, "lead_no_answer_followup");
    assert.equal(state.followupStep, 1);
    assert.equal(state.customerRepliedAt, hoursAgo(5));
  });

  runCase("suggerimenti: chiamata persa suggerisce call_no_answer, fuori budget suggerisce l'alternativa", () => {
    const missed = engine.suggestTemplates(ctx({ sent: [{ key: "lead_first_contact", sentAt: hoursAgo(5) }], lead: { id: "l", status: LEAD_STATUSES.NO_ANSWER } }), "no_answer");
    assert.ok(missed.some((item) => item.key === "call_no_answer"));
    const budget = engine.suggestTemplates(ctx({ sent: [{ key: "lead_first_contact", sentAt: hoursAgo(5) }], lead: { id: "l", status: LEAD_STATUSES.OUT_OF_BUDGET } }));
    assert.ok(budget.some((item) => item.key === "budget_alternative"));
  });
}

main();
console.log("All whatsapp-automation checks passed.");
