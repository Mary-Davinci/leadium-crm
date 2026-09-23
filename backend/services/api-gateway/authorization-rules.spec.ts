import assert from "node:assert/strict";

const rules = require("./authorization-rules") as typeof import("./authorization-rules");

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
  runCase("operatore non puo archiviare (dismissed) un task", () => {
    assert.equal(rules.isTaskDismissBlocked("operatore", "dismissed"), true);
  });

  runCase("admin puo archiviare (dismissed) un task", () => {
    assert.equal(rules.isTaskDismissBlocked("admin", "dismissed"), false);
  });

  runCase("super_admin puo archiviare (dismissed) un task", () => {
    assert.equal(rules.isTaskDismissBlocked("super_admin", "dismissed"), false);
  });

  runCase("operatore puo completare un task (status done non bloccato)", () => {
    assert.equal(rules.isTaskDismissBlocked("operatore", "done"), false);
  });

  runCase("operatore puo riaprire/riprogrammare un task (status open non bloccato)", () => {
    assert.equal(rules.isTaskDismissBlocked("operatore", "open"), false);
  });

  runCase("un PATCH senza cambio di status non viene bloccato per nessun ruolo", () => {
    assert.equal(rules.isTaskDismissBlocked("operatore", undefined), false);
    assert.equal(rules.isTaskDismissBlocked("admin", undefined), false);
  });

  runCase("operatore non puo inviare un template di test WhatsApp", () => {
    assert.equal(rules.isWhatsappTemplateTestSendBlocked("operatore"), true);
  });

  runCase("admin puo inviare un template di test WhatsApp", () => {
    assert.equal(rules.isWhatsappTemplateTestSendBlocked("admin"), false);
  });

  runCase("super_admin puo inviare un template di test WhatsApp", () => {
    assert.equal(rules.isWhatsappTemplateTestSendBlocked("super_admin"), false);
  });
}

main();
console.log("All authorization-rules checks passed.");
