import assert from "node:assert/strict";

/**
 * authenticateUser() integration coverage: the DB-write side of the upgrade-on-login
 * flow, which resolvePasswordVerification() (password-hashing.spec.ts) cannot exercise
 * on its own since that function is pure/side-effect-free by design.
 *
 * No real Mongo connection is ever made here: ../common/mongo is monkey-patched with an
 * in-memory fake collection before each case, and auth-store.ts is re-required fresh
 * (module-level mongoAuthSetupPromise cache reset) so cases stay isolated. Nothing in
 * this file touches a real database.
 */

type FakeUserDoc = {
  _id: string;
  username: string;
  usernameLower: string;
  email: string;
  emailLower: string;
  name: string;
  role: string;
  passwordHash?: string;
  password?: string;
  createdAt?: string;
  updatedAt?: string;
};

function matchesQuery(doc: FakeUserDoc, query: Record<string, unknown>): boolean {
  if (query.$or) {
    return (query.$or as Record<string, unknown>[]).some((clause) => matchesQuery(doc, clause));
  }
  return Object.entries(query).every(([key, value]) => (doc as Record<string, unknown>)[key] === value);
}

function createFakeUsersCollection(seed: FakeUserDoc[]) {
  const docs = seed.map((doc) => ({ ...doc }));
  const updateCalls: Array<{ query: Record<string, unknown>; update: Record<string, unknown> }> = [];
  return {
    docs,
    updateCalls,
    async createIndex() {
      return "ok";
    },
    find() {
      return { toArray: async () => docs.map((doc) => ({ ...doc })) };
    },
    async findOne(query: Record<string, unknown>) {
      const match = docs.find((doc) => matchesQuery(doc, query));
      return match ? { ...match } : null;
    },
    async updateOne(query: Record<string, unknown>, update: Record<string, unknown>) {
      updateCalls.push({ query, update });
      const match = docs.find((doc) => matchesQuery(doc, query));
      if (!match) return { matchedCount: 0 };
      const set = update.$set as Record<string, unknown> | undefined;
      const unset = update.$unset as Record<string, unknown> | undefined;
      if (set) Object.assign(match, set);
      if (unset) Object.keys(unset).forEach((key) => delete (match as Record<string, unknown>)[key]);
      return { matchedCount: 1 };
    }
  };
}

type FakeCollection = ReturnType<typeof createFakeUsersCollection>;

async function withFakeAuthStore(
  seed: FakeUserDoc[],
  fn: (authStore: typeof import("./auth-store"), users: FakeCollection) => Promise<void>
) {
  const mongoModule = require("../common/mongo") as {
    isMongoEnabled: () => boolean;
    getMongoDb: () => Promise<{ collection: (name: string) => FakeCollection }>;
  };
  const originalIsMongoEnabled = mongoModule.isMongoEnabled;
  const originalGetMongoDb = mongoModule.getMongoDb;

  const users = createFakeUsersCollection(seed);
  mongoModule.isMongoEnabled = () => true;
  mongoModule.getMongoDb = async () => ({
    collection(name: string) {
      assert.equal(name, "users", "auth-store deve leggere/scrivere solo sulla collection 'users'");
      return users;
    }
  });

  delete require.cache[require.resolve("./auth-store")];
  const authStore = require("./auth-store") as typeof import("./auth-store");

  try {
    await fn(authStore, users);
  } finally {
    mongoModule.isMongoEnabled = originalIsMongoEnabled;
    mongoModule.getMongoDb = originalGetMongoDb;
    delete require.cache[require.resolve("./auth-store")];
  }
}

function baseUser(overrides: Partial<FakeUserDoc>): FakeUserDoc {
  return {
    _id: "user_1",
    username: "admin",
    usernameLower: "admin",
    email: "admin@crocieriamo.local",
    emailLower: "admin@crocieriamo.local",
    name: "Admin",
    role: "super_admin",
    ...overrides
  };
}

async function runCase(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function main() {
  const AUTH_SALT = process.env.AUTH_PASSWORD_SALT || "crocieriamo-auth-salt";
  const PASSWORD = "Sup3rSegreta!";

  await runCase("login con hash SHA-256 legacy valido -> autenticato", async () => {
    const { hashPasswordSha256Salted } = require("./password-hashing") as typeof import("./password-hashing");
    const legacyHash = hashPasswordSha256Salted(PASSWORD, AUTH_SALT);
    await withFakeAuthStore([baseUser({ passwordHash: legacyHash })], async (authStore) => {
      const user = await authStore.authenticateUser("admin", PASSWORD);
      assert.ok(user, "il login con la password corretta su hash legacy deve riuscire");
      assert.equal(user!.username, "admin");
    });
  });

  await runCase("upgrade automatico SHA-256 -> scrypt: il login riscrive passwordHash in formato scrypt", async () => {
    const { hashPasswordSha256Salted, isScryptHash } = require("./password-hashing") as typeof import("./password-hashing");
    const legacyHash = hashPasswordSha256Salted(PASSWORD, AUTH_SALT);
    await withFakeAuthStore([baseUser({ passwordHash: legacyHash })], async (authStore, users) => {
      const user = await authStore.authenticateUser("admin", PASSWORD);
      assert.ok(user, "login atteso valido durante l'upgrade");
      assert.equal(users.updateCalls.length, 1, "deve esserci esattamente una scrittura di upgrade");
      const stored = users.docs.find((doc) => doc.usernameLower === "admin")!;
      assert.ok(isScryptHash(stored.passwordHash), "dopo l'upgrade l'hash salvato deve essere in formato scrypt");
      assert.equal(stored.password, undefined, "il campo password in chiaro (se presente) deve essere rimosso dopo l'upgrade");
    });
  });

  await runCase("login successivo sul nuovo hash scrypt -> autenticato, nessuna ulteriore riscrittura", async () => {
    const { hashPasswordScrypt } = require("./password-hashing") as typeof import("./password-hashing");
    const scryptHash = hashPasswordScrypt(PASSWORD);
    await withFakeAuthStore([baseUser({ passwordHash: scryptHash })], async (authStore, users) => {
      const user = await authStore.authenticateUser("admin", PASSWORD);
      assert.ok(user, "il login sul nuovo hash scrypt deve riuscire");
      assert.equal(users.updateCalls.length, 0, "un hash scrypt gia' valido non deve mai essere riscritto");
    });
  });

  await runCase("password errata su hash SHA-256 legacy -> login rifiutato, nessuna scrittura", async () => {
    const { hashPasswordSha256Salted } = require("./password-hashing") as typeof import("./password-hashing");
    const legacyHash = hashPasswordSha256Salted(PASSWORD, AUTH_SALT);
    await withFakeAuthStore([baseUser({ passwordHash: legacyHash })], async (authStore, users) => {
      const user = await authStore.authenticateUser("admin", "password-sbagliata");
      assert.equal(user, null);
      assert.equal(users.updateCalls.length, 0, "una password errata non deve mai scrivere sul DB");
    });
  });

  await runCase("password errata su hash scrypt -> login rifiutato, nessuna scrittura", async () => {
    const { hashPasswordScrypt } = require("./password-hashing") as typeof import("./password-hashing");
    const scryptHash = hashPasswordScrypt(PASSWORD);
    await withFakeAuthStore([baseUser({ passwordHash: scryptHash })], async (authStore, users) => {
      const user = await authStore.authenticateUser("admin", "password-sbagliata");
      assert.equal(user, null);
      assert.equal(users.updateCalls.length, 0);
    });
  });

  await runCase("hash scrypt malformato in DB -> login rifiutato senza eccezioni, nessuna scrittura", async () => {
    await withFakeAuthStore([baseUser({ passwordHash: "scrypt$non-hex$anche-questo-non-e-hex" })], async (authStore, users) => {
      const user = await authStore.authenticateUser("admin", PASSWORD);
      assert.equal(user, null, "un hash malformato non deve mai autenticare, ma nemmeno far esplodere la richiesta");
      assert.equal(users.updateCalls.length, 0);
    });
  });

  await runCase("gli altri 5 utenti con hash SHA-256 restano compatibili (retrocompatibilita')", async () => {
    const { hashPasswordSha256Salted } = require("./password-hashing") as typeof import("./password-hashing");
    const operators = ["operatore", "Mauro", "Giuseppe", "Marta", "Denise"].map((name, index) =>
      baseUser({
        _id: `user_${index + 2}`,
        username: name,
        usernameLower: name.toLowerCase(),
        email: `${name.toLowerCase()}@crocieriamo.local`,
        emailLower: `${name.toLowerCase()}@crocieriamo.local`,
        role: "operatore",
        passwordHash: hashPasswordSha256Salted(PASSWORD, AUTH_SALT)
      })
    );
    await withFakeAuthStore(operators, async (authStore) => {
      for (const operator of operators) {
        const user = await authStore.authenticateUser(operator.username, PASSWORD);
        assert.ok(user, `${operator.username} deve poter accedere con il proprio hash SHA-256 legacy`);
        assert.equal(user!.username, operator.username);
      }
    });
  });
}

main()
  .then(() => console.log("All auth-store checks passed."))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
