import assert from "node:assert/strict";

const hashing = require("./password-hashing") as typeof import("./password-hashing");

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
  runCase("hashPasswordScrypt produce il formato scrypt$salt$hash", () => {
    const hash = hashing.hashPasswordScrypt("Sup3rSegreta!");
    assert.ok(hash.startsWith("scrypt$"));
    assert.equal(hash.split("$").length, 3);
    assert.ok(hashing.isScryptHash(hash));
  });

  runCase("due hash della stessa password sono diversi (salt casuale per hash)", () => {
    const a = hashing.hashPasswordScrypt("Sup3rSegreta!");
    const b = hashing.hashPasswordScrypt("Sup3rSegreta!");
    assert.notEqual(a, b, "un salt fisso renderebbe l'hash prevedibile/riusabile in un rainbow table");
  });

  runCase("verifyScryptPassword accetta la password corretta", () => {
    const hash = hashing.hashPasswordScrypt("Sup3rSegreta!");
    assert.equal(hashing.verifyScryptPassword("Sup3rSegreta!", hash), true);
  });

  runCase("verifyScryptPassword rifiuta una password errata", () => {
    const hash = hashing.hashPasswordScrypt("Sup3rSegreta!");
    assert.equal(hashing.verifyScryptPassword("password-sbagliata", hash), false);
  });

  runCase("verifyScryptPassword rifiuta un hash malformato senza generare eccezioni", () => {
    assert.equal(hashing.verifyScryptPassword("qualsiasi", "non-e-un-hash-scrypt"), false);
    assert.equal(hashing.verifyScryptPassword("qualsiasi", "scrypt$nonhex$nonhex"), false);
  });

  runCase("isScryptHash distingue correttamente un hash legacy sha256 da uno scrypt", () => {
    const legacy = hashing.hashPasswordSha256Salted("Sup3rSegreta!", "salt-legacy");
    assert.equal(hashing.isSha256Hash(legacy), true);
    assert.equal(hashing.isScryptHash(legacy), false);
    const modern = hashing.hashPasswordScrypt("Sup3rSegreta!");
    assert.equal(hashing.isSha256Hash(modern), false);
    assert.equal(hashing.isScryptHash(modern), true);
  });

  runCase("gli helper legacy restano deterministici (necessario per la verifica/migrazione su login)", () => {
    assert.equal(hashing.hashPasswordSha256Salted("pw", "salt"), hashing.hashPasswordSha256Salted("pw", "salt"));
    assert.equal(hashing.hashPasswordSha256NoSalt("pw"), hashing.hashPasswordSha256NoSalt("pw"));
    assert.equal(hashing.hashPasswordSha256SuffixSalt("pw", "salt"), hashing.hashPasswordSha256SuffixSalt("pw", "salt"));
  });

  const SALT = "test-configured-salt";

  runCase("resolvePasswordVerification: hash scrypt corretto -> valido, nessun upgrade", () => {
    const hash = hashing.hashPasswordScrypt("Sup3rSegreta!");
    const result = hashing.resolvePasswordVerification({
      password: "Sup3rSegreta!",
      storedPasswordHash: hash,
      storedPlaintextPassword: null,
      configuredSalt: SALT
    });
    assert.deepEqual(result, { outcome: "valid_no_upgrade" });
  });

  runCase("resolvePasswordVerification: hash scrypt con password errata -> invalido", () => {
    const hash = hashing.hashPasswordScrypt("Sup3rSegreta!");
    const result = hashing.resolvePasswordVerification({
      password: "password-sbagliata",
      storedPasswordHash: hash,
      storedPlaintextPassword: null,
      configuredSalt: SALT
    });
    assert.deepEqual(result, { outcome: "invalid" });
  });

  runCase("resolvePasswordVerification: hash legacy sha256(salt:password) valido -> upgrade a scrypt", () => {
    const legacyHash = hashing.hashPasswordSha256Salted("Sup3rSegreta!", SALT);
    const result = hashing.resolvePasswordVerification({
      password: "Sup3rSegreta!",
      storedPasswordHash: legacyHash,
      storedPlaintextPassword: null,
      configuredSalt: SALT
    });
    assert.equal(result.outcome, "valid_upgrade");
  });

  runCase("resolvePasswordVerification: hash legacy sha256 senza salt valido -> upgrade a scrypt", () => {
    const legacyHash = hashing.hashPasswordSha256NoSalt("Sup3rSegreta!");
    const result = hashing.resolvePasswordVerification({
      password: "Sup3rSegreta!",
      storedPasswordHash: legacyHash,
      storedPlaintextPassword: null,
      configuredSalt: SALT
    });
    assert.equal(result.outcome, "valid_upgrade");
  });

  runCase("resolvePasswordVerification: hash legacy sha256(password:salt) valido -> upgrade a scrypt", () => {
    const legacyHash = hashing.hashPasswordSha256SuffixSalt("Sup3rSegreta!", SALT);
    const result = hashing.resolvePasswordVerification({
      password: "Sup3rSegreta!",
      storedPasswordHash: legacyHash,
      storedPlaintextPassword: null,
      configuredSalt: SALT
    });
    assert.equal(result.outcome, "valid_upgrade");
  });

  runCase("resolvePasswordVerification: password salvata in chiaro nel campo password -> upgrade a scrypt", () => {
    const result = hashing.resolvePasswordVerification({
      password: "Sup3rSegreta!",
      storedPasswordHash: undefined,
      storedPlaintextPassword: "Sup3rSegreta!",
      configuredSalt: SALT
    });
    assert.equal(result.outcome, "valid_upgrade");
  });

  runCase("resolvePasswordVerification: password in chiaro salvata per errore nel campo passwordHash -> upgrade a scrypt", () => {
    const result = hashing.resolvePasswordVerification({
      password: "Sup3rSegreta!",
      storedPasswordHash: "Sup3rSegreta!",
      storedPlaintextPassword: null,
      configuredSalt: SALT
    });
    assert.equal(result.outcome, "valid_upgrade");
  });

  runCase("resolvePasswordVerification: nessun campo password utilizzabile -> invalido", () => {
    const result = hashing.resolvePasswordVerification({
      password: "qualsiasi",
      storedPasswordHash: undefined,
      storedPlaintextPassword: null,
      configuredSalt: SALT
    });
    assert.deepEqual(result, { outcome: "invalid" });
  });

  runCase("resolvePasswordVerification: hash scrypt malformato salvato in DB -> invalido, nessuna eccezione", () => {
    const result = hashing.resolvePasswordVerification({
      password: "Sup3rSegreta!",
      storedPasswordHash: "scrypt$non-hex$anche-questo-non-e-hex",
      storedPlaintextPassword: null,
      configuredSalt: SALT
    });
    assert.deepEqual(result, { outcome: "invalid" });
  });

  runCase("resolvePasswordVerification: password errata con hash legacy -> invalido, nessun upgrade", () => {
    const legacyHash = hashing.hashPasswordSha256Salted("Sup3rSegreta!", SALT);
    const result = hashing.resolvePasswordVerification({
      password: "password-sbagliata",
      storedPasswordHash: legacyHash,
      storedPlaintextPassword: null,
      configuredSalt: SALT
    });
    assert.deepEqual(result, { outcome: "invalid" });
  });
}

main();
console.log("All password-hashing checks passed.");
