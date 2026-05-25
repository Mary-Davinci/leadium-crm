import { createHash } from "crypto";
import { getMongoDb, isMongoEnabled } from "../common/mongo";

export type AuthRole = "super_admin" | "admin" | "operatore";

type AuthUser = {
  id: string;
  username: string;
  password: string;
  name: string;
  role: AuthRole;
  email?: string;
  surname?: string;
  organization?: string;
};

export type AuthPublicUser = {
  id: string;
  username: string;
  name: string;
  role: AuthRole;
  email?: string;
  surname?: string;
  organization?: string;
};

export type AuthCreateUserInput = {
  username: string;
  name: string;
  role: AuthRole;
  password: string;
  email?: string;
  surname?: string;
  organization?: string;
};

export type AuthUpdateUserInput = {
  username?: string;
  name?: string;
  role?: AuthRole;
  email?: string;
  surname?: string;
  organization?: string;
};

type MongoAuthUser = {
  _id?: unknown;
  username: string;
  usernameLower: string;
  emailLower?: string;
  name: string;
  role: AuthRole;
  email?: string;
  surname?: string;
  organization?: string;
  passwordHash?: string;
  password?: string;
  createdAt?: string;
  updatedAt?: string;
};

const AUTH_SALT = process.env.AUTH_PASSWORD_SALT || "crocieriamo-auth-salt";
const AUTH_MONGO_TIMEOUT_MS = Number(process.env.AUTH_MONGO_TIMEOUT_MS || 3500);
let mongoAuthSetupPromise: Promise<void> | null = null;

function hashPassword(password: string) {
  return createHash("sha256").update(`${AUTH_SALT}:${password}`).digest("hex");
}

function hashPasswordWithoutSalt(password: string) {
  return createHash("sha256").update(password).digest("hex");
}

function hashPasswordWithSuffixSalt(password: string) {
  return createHash("sha256").update(`${password}:${AUTH_SALT}`).digest("hex");
}

function isSha256Hash(value: unknown) {
  return /^[a-f0-9]{64}$/i.test(String(value || ""));
}

function normalizeRole(value: unknown): AuthRole {
  const role = String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
  if (role === "super_admin") return "super_admin";
  if (role === "admin") return "admin";
  return "operatore";
}

async function withAuthTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timeout`)), AUTH_MONGO_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function toPublicMongoUser(user: MongoAuthUser): AuthPublicUser {
  return {
    id: String(user._id || user.usernameLower),
    username: user.username,
    name: user.name,
    role: normalizeRole(user.role),
    email: user.email || user.username,
    surname: user.surname || "",
    organization: user.organization || ""
  };
}

async function ensureMongoAuthSetup() {
  if (!isMongoEnabled()) return;
  if (mongoAuthSetupPromise) return mongoAuthSetupPromise;
  mongoAuthSetupPromise = (async () => {
    const db = await getMongoDb();
    if (!db) return;
    const users = db.collection("users");
    await users.createIndex({ usernameLower: 1 }, { unique: true });
    await users.createIndex({ emailLower: 1 });

    // One-shot data hygiene for existing users:
    // ensure every record has a usable email/emailLower for email-based login.
    const existingUsers = await users.find({}).toArray();
    for (const item of existingUsers as MongoAuthUser[]) {
      const username = String(item.username || "").trim();
      if (!username) continue;
      const currentEmail = String(item.email || "").trim();
      const normalizedEmail = currentEmail || (username.includes("@") ? username : `${username}@crocieriamo.local`);
      const emailLower = normalizedEmail.toLowerCase();
      const currentEmailLower = String(item.emailLower || "").trim().toLowerCase();
      if (currentEmail === normalizedEmail && currentEmailLower === emailLower) continue;

      await users.updateOne(
        { usernameLower: String(item.usernameLower || username.toLowerCase()) },
        { $set: { email: normalizedEmail, emailLower, updatedAt: new Date().toISOString() } }
      );
    }
  })();
  return mongoAuthSetupPromise;
}

export async function authenticateUser(identifier: string, password: string): Promise<AuthPublicUser | null> {
  if (!identifier || !password) return null;
  if (!isMongoEnabled()) {
    console.error("[auth] login refused: Mongo disabled or MONGODB_URI missing");
    return null;
  }

  try {
    await withAuthTimeout(ensureMongoAuthSetup(), "Mongo auth setup");
    const db = await withAuthTimeout(getMongoDb(), "Mongo auth connection");
    if (!db) return null;
    const users = db.collection("users") as {
      findOne(query: Record<string, unknown>): Promise<MongoAuthUser | null>;
      updateOne(
        query: Record<string, unknown>,
        update: Record<string, unknown>,
        options?: { upsert?: boolean }
      ): Promise<unknown>;
    };
    const identifierLower = identifier.toLowerCase();
    let user = await users.findOne({ emailLower: identifierLower });
    if (!user) user = await users.findOne({ usernameLower: identifierLower });
    if (!user) user = await users.findOne({ email: identifier });
    if (!user) user = await users.findOne({ username: identifier });
    if (!user && identifierLower.includes("@")) {
      const localPart = identifierLower.split("@")[0] || "";
      if (localPart) user = await users.findOne({ usernameLower: localPart });
    }
    if (!user) {
      console.warn(`[auth] login denied: user not found for "${identifierLower}"`);
      return null;
    }

    const expectedHash = hashPassword(password);
    const legacyHashWithoutSalt = hashPasswordWithoutSalt(password);
    const legacyHashWithSuffixSalt = hashPasswordWithSuffixSalt(password);
    if (user.passwordHash) {
      if (user.passwordHash !== expectedHash) {
        const matchesLegacyHash =
          user.passwordHash === legacyHashWithoutSalt || user.passwordHash === legacyHashWithSuffixSalt;
        if (matchesLegacyHash) {
          await users.updateOne(
            {
              $or: [
                { usernameLower: String(user.usernameLower || "").toLowerCase() },
                { emailLower: String(user.emailLower || "").toLowerCase() }
              ]
            },
            { $set: { passwordHash: expectedHash, updatedAt: new Date().toISOString() }, $unset: { password: "" } }
          );
          console.warn(
            `[auth] migrated legacy password hash for "${String(user.usernameLower || identifierLower).toLowerCase()}"`
          );
          return toPublicMongoUser(user);
        }
        // Legacy/manual recovery path:
        // if a plain password is present, or was accidentally saved in passwordHash,
        // and matches the login password, re-hash it and migrate.
        const plainPasswordMatches = user.password && user.password === password;
        const plainHashFieldMatches = !isSha256Hash(user.passwordHash) && user.passwordHash === password;
        if (plainPasswordMatches || plainHashFieldMatches) {
          await users.updateOne(
            {
              $or: [
                { usernameLower: String(user.usernameLower || "").toLowerCase() },
                { emailLower: String(user.emailLower || "").toLowerCase() }
              ]
            },
            { $set: { passwordHash: expectedHash, updatedAt: new Date().toISOString() }, $unset: { password: "" } }
          );
          console.warn(
            `[auth] migrated plain-text password storage for "${String(user.usernameLower || identifierLower).toLowerCase()}"`
          );
          return toPublicMongoUser(user);
        }
        console.warn(
          `[auth] login denied: password mismatch for "${String(user.usernameLower || identifierLower).toLowerCase()}"`
        );
        return null;
      }
      return toPublicMongoUser(user);
    }

    if (user.password && user.password === password) {
      await users.updateOne(
        {
          $or: [
            { usernameLower: String(user.usernameLower || "").toLowerCase() },
            { emailLower: String(user.emailLower || "").toLowerCase() }
          ]
        },
        { $set: { passwordHash: expectedHash, updatedAt: new Date().toISOString() }, $unset: { password: "" } }
      );
      console.warn(
        `[auth] migrated password field for "${String(user.usernameLower || identifierLower).toLowerCase()}"`
      );
      return toPublicMongoUser(user);
    }

    console.warn(
      `[auth] login denied: no usable password fields for "${String(user.usernameLower || identifierLower).toLowerCase()}"`
    );
    return null;
  } catch (error) {
    console.error("[auth] login failed with internal error", error);
    return null;
  }
}

export async function listUsers(): Promise<AuthPublicUser[]> {
  if (!isMongoEnabled()) return [];

  try {
    await ensureMongoAuthSetup();
    const db = await getMongoDb();
    if (!db) return [];
    const users = db.collection("users") as {
      find(query: Record<string, unknown>): { toArray(): Promise<MongoAuthUser[]> };
    };
    const all = await users.find({}).toArray();
    return all.map((user) => toPublicMongoUser(user)).sort((a, b) => a.username.localeCompare(b.username, "it"));
  } catch {
    return [];
  }
}

export async function createUser(input: AuthCreateUserInput): Promise<AuthPublicUser> {
  const username = input.username.trim();
  const name = input.name.trim() || username;
  const password = input.password.trim();
  const role = normalizeRole(input.role);
  const email = input.email?.trim() || "";
  const surname = input.surname?.trim() || "";
  const organization = input.organization?.trim() || "";
  const usernameLower = username.toLowerCase();

  if (!email) throw new Error("Email obbligatoria.");

  if (!isMongoEnabled()) throw new Error("Mongo non disponibile.");

  await ensureMongoAuthSetup();
  const db = await getMongoDb();
  if (!db) throw new Error("Mongo non disponibile.");
  const users = db.collection("users") as {
    findOne(query: { usernameLower: string }): Promise<MongoAuthUser | null>;
    insertOne(doc: Record<string, unknown>): Promise<{ insertedId: unknown }>;
  };

  const exists = await users.findOne({ usernameLower });
  if (exists) throw new Error("Username gia esistente.");
  const now = new Date().toISOString();
  const inserted = await users.insertOne({
    username,
    usernameLower,
    emailLower: email.toLowerCase(),
    name,
    role,
    email,
    surname,
    organization,
    passwordHash: hashPassword(password),
    createdAt: now,
    updatedAt: now
  });

  return {
    id: String(inserted.insertedId || usernameLower),
    username,
    name,
    role,
    email,
    surname,
    organization
  };
}

export async function resetUserPassword(identifier: string, newPassword: string): Promise<void> {
  const normalizedIdentifier = identifier.trim();
  const identifierLower = normalizedIdentifier.toLowerCase();
  if (!identifierLower) throw new Error("Username obbligatorio.");
  const password = newPassword.trim();
  if (!password) throw new Error("Password obbligatoria.");

  if (!isMongoEnabled()) throw new Error("Mongo non disponibile.");

  await ensureMongoAuthSetup();
  const db = await getMongoDb();
  if (!db) throw new Error("Mongo non disponibile.");
  const users = db.collection("users") as {
    updateOne(query: Record<string, unknown>, update: Record<string, unknown>): Promise<{ matchedCount: number }>;
  };
  const result = await users.updateOne(
    {
      $or: [
        { usernameLower: identifierLower },
        { emailLower: identifierLower },
        { username: normalizedIdentifier },
        { email: normalizedIdentifier }
      ]
    },
    { $set: { passwordHash: hashPassword(password), updatedAt: new Date().toISOString() }, $unset: { password: "" } }
  );
  if (!result.matchedCount) throw new Error("Utente non trovato.");
}

export async function deleteUser(username: string, actorRole: AuthRole): Promise<void> {
  const usernameLower = username.trim().toLowerCase();
  if (!usernameLower) throw new Error("Username obbligatorio.");

  if (!isMongoEnabled()) throw new Error("Mongo non disponibile.");

  await ensureMongoAuthSetup();
  const db = await getMongoDb();
  if (!db) throw new Error("Mongo non disponibile.");
  const users = db.collection("users") as {
    findOne(query: { usernameLower: string }): Promise<MongoAuthUser | null>;
    countDocuments(query: Record<string, unknown>): Promise<number>;
    deleteOne(query: { usernameLower: string }): Promise<{ deletedCount: number }>;
  };

  const target = await users.findOne({ usernameLower });
  if (!target) throw new Error("Utente non trovato.");
  const targetRole = normalizeRole(target.role);
  if (actorRole !== "super_admin" && (targetRole === "admin" || targetRole === "super_admin")) {
    throw new Error("Solo super admin puo eliminare utenti admin.");
  }
  if (targetRole === "admin") {
    const adminCount = await users.countDocuments({ role: "admin" });
    if (adminCount <= 1) throw new Error("Impossibile eliminare l'ultimo admin.");
  }

  const result = await users.deleteOne({ usernameLower });
  if (!result.deletedCount) throw new Error("Utente non trovato.");
}

export async function updateUser(username: string, input: AuthUpdateUserInput): Promise<AuthPublicUser> {
  const currentUsernameLower = username.trim().toLowerCase();
  if (!currentUsernameLower) throw new Error("Username obbligatorio.");

  const nextUsername = String(input.username || username).trim();
  const nextUsernameLower = nextUsername.toLowerCase();
  const nextName = String(input.name || "").trim();
  const nextEmailFromInput = String(input.email || "").trim();
  const nextSurname = String(input.surname || "").trim();
  const nextOrganization = String(input.organization || "").trim();

  if (!nextUsername) throw new Error("Username obbligatorio.");
  if (!nextName) throw new Error("Nome obbligatorio.");

  if (!isMongoEnabled()) throw new Error("Mongo non disponibile.");

  await ensureMongoAuthSetup();
  const db = await getMongoDb();
  if (!db) throw new Error("Mongo non disponibile.");
  const users = db.collection("users") as {
    findOne(query: { usernameLower: string }): Promise<MongoAuthUser | null>;
    updateOne(query: { usernameLower: string }, update: Record<string, unknown>): Promise<{ matchedCount: number }>;
  };

  const existing = await users.findOne({ usernameLower: currentUsernameLower });
  if (!existing) throw new Error("Utente non trovato.");
  const nextEmail = nextEmailFromInput || existing.email || existing.username;
  if (nextUsernameLower !== currentUsernameLower) {
    const conflict = await users.findOne({ usernameLower: nextUsernameLower });
    if (conflict) throw new Error("Username gia esistente.");
  }

  const nextRole = input.role ? normalizeRole(input.role) : normalizeRole(existing.role);
  const result = await users.updateOne(
    { usernameLower: currentUsernameLower },
    {
      $set: {
        username: nextUsername,
        usernameLower: nextUsernameLower,
        name: nextName,
        role: nextRole,
        email: nextEmail,
        emailLower: nextEmail.toLowerCase(),
        surname: nextSurname,
        organization: nextOrganization,
        updatedAt: new Date().toISOString()
      }
    }
  );
  if (!result.matchedCount) throw new Error("Utente non trovato.");

  return {
    id: String(existing._id || nextUsernameLower),
    username: nextUsername,
    name: nextName,
    role: nextRole,
    email: nextEmail,
    surname: nextSurname,
    organization: nextOrganization
  };
}
