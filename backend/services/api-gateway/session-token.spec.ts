import assert from "node:assert/strict";

const { createSessionToken } = require("./session-token") as typeof import("./session-token");

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
  runCase("il token ha il prefisso atteso e alta entropia (64 char hex dopo sess_)", () => {
    const token = createSessionToken();
    assert.ok(token.startsWith("sess_"), "prefisso sess_ mancante");
    const randomPart = token.slice("sess_".length);
    assert.equal(randomPart.length, 64, "atteso 32 byte esadecimali (64 caratteri)");
    assert.ok(/^[0-9a-f]{64}$/.test(randomPart), "la parte casuale deve essere esadecimale");
  });

  runCase("due token generati in sequenza sono sempre diversi (nessuna collisione su un campione ampio)", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 5000; i += 1) {
      tokens.add(createSessionToken());
    }
    assert.equal(tokens.size, 5000, "generati token duplicati su 5000 campioni");
  });

  runCase("il token non e derivabile da un timestamp prevedibile (non contiene Date.now())", () => {
    const before = Date.now();
    const token = createSessionToken();
    const after = Date.now();
    const randomPart = token.slice("sess_".length);
    // A Math.random()-based token historically embedded Date.now() directly in the string.
    // Assert the CSPRNG-based token contains no literal timestamp from the generation window.
    for (let ts = before; ts <= after; ts += 1) {
      assert.ok(!randomPart.includes(String(ts)), `il token non deve incorporare un timestamp prevedibile (${ts})`);
    }
  });
}

main();
console.log("All session-token checks passed.");
