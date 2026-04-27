import "../../loadEnv";
import http from "http";
import {
  authenticateUser,
  AuthCreateUserInput,
  AuthPublicUser,
  AuthUpdateUserInput,
  createUser,
  deleteUser,
  listUsers,
  resetUserPassword,
  updateUser
} from "./auth-store";

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT || 4110);
const LEAD_URL = process.env.LEAD_SERVICE_URL || "http://localhost:4301";
const WORKFLOW_URL = process.env.WORKFLOW_SERVICE_URL || "http://localhost:4302";
const CALL_URL = process.env.CALL_SERVICE_URL || "http://localhost:4303";
const ANALYTICS_URL = process.env.ANALYTICS_SERVICE_URL || "http://localhost:4304";
const INGEST_URL = process.env.INGEST_SERVICE_URL || "http://localhost:4305";
const WHATSAPP_URL = process.env.WHATSAPP_SERVICE_URL || "http://localhost:4306";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5179";
const SLA_FIRST_CONTACT_MINUTES = Number(process.env.SLA_FIRST_CONTACT_MINUTES || 5);
const AUTH_SESSION_TTL_HOURS = Number(process.env.AUTH_SESSION_TTL_HOURS || 12);
const ALLOWED_ORIGINS = new Set(
  [FRONTEND_URL, ...(process.env.CORS_ORIGINS || "").split(",")]
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean)
);

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function applyCors(req: http.IncomingMessage, res: http.ServerResponse) {
  const origin = String(req.headers.origin || "").replace(/\/+$/, "");
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Auth-Token");
}

function sanitizeApiError(message: unknown) {
  const raw = String(message || "");
  const normalized = raw.toLowerCase();
  if (
    normalized.includes("server selection timed out") ||
    normalized.includes("ssl alert") ||
    normalized.includes("tlsv1 alert") ||
    normalized.includes("mongodb") ||
    normalized.includes("mongo")
  ) {
    return "Connessione dati temporaneamente lenta o non disponibile. Riprova tra qualche secondo.";
  }
  return raw || "Errore gateway.";
}

type SessionRecord = {
  token: string;
  user: AuthPublicUser;
  expiresAt: number;
};

const sessions = new Map<string, SessionRecord>();

function randomToken() {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

function getTokenFromRequest(req: http.IncomingMessage) {
  const header = String(req.headers.authorization || "");
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  const xToken = req.headers["x-auth-token"];
  return xToken ? String(xToken) : "";
}

function getSessionFromRequest(req: http.IncomingMessage) {
  const token = getTokenFromRequest(req);
  if (!token) return null;
  const session = sessions.get(token) || null;
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function isAdmin(user?: AuthPublicUser | null) {
  return Boolean(user && (user.role === "admin" || user.role === "super_admin"));
}

function isSuperAdmin(user?: AuthPublicUser | null) {
  return Boolean(user && user.role === "super_admin");
}

async function parseJsonBody(req: http.IncomingMessage) {
  const body = await readBody(req);
  if (!body || !body.length) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("Invalid JSON body");
  }
}

type InboxLead = {
  id: string;
  fullName?: string;
  phone?: string;
  status?: string;
  source?: string;
  assignedTo?: string;
  createdAt?: string;
  updatedAt?: string;
  nextActionAt?: string | null;
};

type InboxConversation = {
  id: string;
  customerName?: string;
  phone?: string;
  lastMessagePreview?: string;
  lastMessageAt?: string;
  unreadCount?: number;
  leadId?: string | null;
};

type InboxTask = {
  id: string;
  leadId?: string | null;
  assignedTo?: string;
  kind?: string;
  title?: string;
  description?: string;
  source?: string;
  status?: string;
  priority?: number;
  dueAt?: string | null;
  updatedAt?: string;
};

function toMs(value?: string | null) {
  if (!value) return 0;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function leadPriority(lead: InboxLead) {
  const now = Date.now();
  const firstContactDeadline = toMs(lead.createdAt) + SLA_FIRST_CONTACT_MINUTES * 60_000;
  const status = String(lead.status || "").toLowerCase();
  const callbackOverdue = Boolean(lead.nextActionAt && toMs(lead.nextActionAt) > 0 && toMs(lead.nextActionAt) < now);
  const firstContactBreach = Boolean(firstContactDeadline > 0 && firstContactDeadline < now && status.includes("contattare"));
  if (callbackOverdue) return 100;
  if (firstContactBreach) return 95;
  if (status.includes("non risponde")) return 80;
  if (status.includes("contattare")) return 70;
  if (status.includes("interess")) return 60;
  return 40;
}

function conversationPriority(conversation: InboxConversation) {
  const unread = Number(conversation.unreadCount || 0);
  if (unread >= 3) return 90;
  if (unread > 0) return 75;
  return 50;
}

async function buildInbox() {
  const [leadRes, convRes, openTaskRes, doneTaskRes] = await Promise.all([
    fetch(`${LEAD_URL}/leads`),
    fetch(`${WHATSAPP_URL}/conversations`),
    fetch(`${LEAD_URL}/tasks?status=open`),
    fetch(`${LEAD_URL}/tasks?status=done`)
  ]);

  if (!leadRes.ok) throw new Error("Impossibile leggere lead dal lead-service.");
  if (!convRes.ok) throw new Error("Impossibile leggere conversazioni dal whatsapp-service.");
  if (!openTaskRes.ok || !doneTaskRes.ok) throw new Error("Impossibile leggere task dal lead-service.");

  const leads = (await leadRes.json()) as InboxLead[];
  const conversations = (await convRes.json()) as InboxConversation[];
  const openTasks = (await openTaskRes.json()) as InboxTask[];
  const doneTasks = ((await doneTaskRes.json()) as InboxTask[]).slice(0, 30);
  const tasks = [...openTasks, ...doneTasks];
  const now = Date.now();

  const leadItems = leads.map((lead) => {
    const createdAtMs = toMs(lead.createdAt);
    const firstContactDeadline = createdAtMs > 0 ? new Date(createdAtMs + SLA_FIRST_CONTACT_MINUTES * 60_000).toISOString() : null;
    const nextActionOverdue = Boolean(lead.nextActionAt && toMs(lead.nextActionAt) > 0 && toMs(lead.nextActionAt) < now);
    const firstContactBreached = Boolean(
      firstContactDeadline &&
        toMs(firstContactDeadline) < now &&
        String(lead.status || "").toLowerCase().includes("contattare")
    );

    return {
      kind: "lead",
      id: lead.id,
      leadId: lead.id,
      title: lead.fullName || lead.phone || "Lead",
      subtitle: `${lead.status || "-"} | ${lead.phone || "-"}`,
      source: lead.source || "manuale",
      assignedTo: lead.assignedTo || "",
      dueAt: lead.nextActionAt || firstContactDeadline,
      priority: leadPriority(lead),
      badges: {
        firstContactBreached,
        nextActionOverdue
      },
      updatedAt: lead.updatedAt || lead.createdAt || null
    };
  });

  const conversationItems = conversations.map((conv) => ({
    kind: "chat",
    id: conv.id,
    conversationId: conv.id,
    leadId: conv.leadId || null,
    title: conv.customerName || conv.phone || "Conversazione",
    subtitle: conv.lastMessagePreview || "Nessun messaggio",
    source: "whatsapp",
    unreadCount: Number(conv.unreadCount || 0),
    dueAt: conv.lastMessageAt || null,
    priority: conversationPriority(conv),
    badges: {
      hasUnread: Number(conv.unreadCount || 0) > 0
    },
    updatedAt: conv.lastMessageAt || null
  }));

  const taskItems = tasks.map((task) => ({
    kind: "task",
    id: task.id,
    taskId: task.id,
    leadId: task.leadId || null,
    title: task.title || "Task",
    subtitle: task.description || task.kind || "",
    source: task.source || "manual",
    assignedTo: task.assignedTo || "",
    status: task.status || "open",
    dueAt: task.dueAt || null,
    priority: Number(task.priority || 50),
    badges: {
      overdue: Boolean(task.dueAt && toMs(task.dueAt) < now)
    },
    updatedAt: task.updatedAt || task.dueAt || null
  }));

  const items = [...taskItems, ...leadItems, ...conversationItems].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return toMs(b.updatedAt || b.dueAt || null) - toMs(a.updatedAt || a.dueAt || null);
  });

  const kpis = {
    total: items.length,
    tasks: taskItems.length,
    openTasks: taskItems.filter((item) => item.status === "open").length,
    doneTasks: taskItems.filter((item) => item.status === "done").length,
    leads: leadItems.length,
    chats: conversationItems.length,
    unreadChats: conversationItems.filter((item) => item.unreadCount > 0).length,
    slaBreaches: leadItems.filter((item) => item.badges.firstContactBreached || item.badges.nextActionOverdue).length
  };

  return {
    items,
    kpis,
    meta: {
      slaFirstContactMinutes: SLA_FIRST_CONTACT_MINUTES,
      generatedAt: new Date().toISOString()
    }
  };
}

async function readBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return chunks.length ? Buffer.concat(chunks) : null;
}

async function proxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  targetBase: string,
  targetPath: string
) {
  const body = await readBody(req);
  const headers: Record<string, string> = {};
  if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"] as string;
  if (req.headers.authorization) headers.authorization = req.headers.authorization;

  const upstream = await fetch(`${targetBase}${targetPath}`, {
    method: req.method,
    headers,
    body: body && req.method !== "GET" && req.method !== "HEAD" ? body : undefined
  });

  const responseHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (key !== "transfer-encoding" && key !== "connection") responseHeaders[key] = value;
  });
  const content = Buffer.from(await upstream.arrayBuffer());
  const contentType = upstream.headers.get("content-type") || "";
  if (upstream.status >= 500 && contentType.includes("application/json")) {
    try {
      const payload = JSON.parse(content.toString("utf8"));
      if (payload?.error) {
        sendJson(res, upstream.status, { ...payload, error: sanitizeApiError(payload.error) });
        return;
      }
    } catch {
      // Fall through and proxy the original response if it is not valid JSON.
    }
  }
  res.writeHead(upstream.status, responseHeaders);
  res.end(content);
}

function mapApiRoute(pathname: string) {
  if (pathname === "/api/workflow") return { base: WORKFLOW_URL, path: "/workflow" };
  if (pathname.startsWith("/api/leads")) return { base: LEAD_URL, path: pathname.replace(/^\/api/, "") };
  if (pathname.startsWith("/api/tasks")) return { base: LEAD_URL, path: pathname.replace(/^\/api/, "") };
  if (pathname === "/api/3cx/webhook") return { base: CALL_URL, path: "/3cx/webhook" };
  if (pathname === "/api/analytics/kpis") return { base: ANALYTICS_URL, path: "/kpis" };
  if (pathname.startsWith("/api/ingest/")) return { base: INGEST_URL, path: pathname.replace(/^\/api\/ingest/, "") };
  if (pathname.startsWith("/api/whatsapp/")) return { base: WHATSAPP_URL, path: pathname.replace(/^\/api\/whatsapp/, "") };
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    applyCors(req, res);
    const method = req.method || "GET";
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);
    if (method === "GET" && pathname === "/api/health") {
      sendJson(res, 200, { ok: true, service: "api-gateway" });
      return;
    }
    if (method === "GET" && pathname === "/api/inbox") {
      const session = getSessionFromRequest(req);
      if (!session) {
        sendJson(res, 401, { error: "Non autorizzato." });
        return;
      }
      sendJson(res, 200, await buildInbox());
      return;
    }
    if (pathname === "/api/auth/login" && method === "POST") {
      const body = await parseJsonBody(req);
      const emailOrUsername = String(body.email || body.username || "").trim();
      const password = String(body.password || "").trim();
      const user = await authenticateUser(emailOrUsername, password);
      if (!user) {
        sendJson(res, 401, { error: "Credenziali non valide." });
        return;
      }
      const token = randomToken();
      sessions.set(token, {
        token,
        user,
        expiresAt: Date.now() + AUTH_SESSION_TTL_HOURS * 60 * 60 * 1000
      });
      sendJson(res, 200, { token, user, expiresInHours: AUTH_SESSION_TTL_HOURS });
      return;
    }
    if (pathname === "/api/auth/logout" && method === "POST") {
      const token = getTokenFromRequest(req);
      if (token) sessions.delete(token);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (pathname === "/api/auth/me" && method === "GET") {
      const session = getSessionFromRequest(req);
      if (!session) {
        sendJson(res, 401, { error: "Non autorizzato." });
        return;
      }
      sendJson(res, 200, { user: session.user, expiresAt: session.expiresAt });
      return;
    }
    if (pathname === "/api/auth/change-password" && method === "POST") {
      const session = getSessionFromRequest(req);
      if (!session) {
        sendJson(res, 401, { error: "Non autorizzato." });
        return;
      }
      const body = (await parseJsonBody(req)) as { currentPassword?: string; newPassword?: string };
      const currentPassword = String(body.currentPassword || "").trim();
      const newPassword = String(body.newPassword || "").trim();
      if (!currentPassword || !newPassword) {
        sendJson(res, 400, { error: "Password attuale e nuova password obbligatorie." });
        return;
      }
      if (newPassword.length < 6) {
        sendJson(res, 400, { error: "La nuova password deve avere almeno 6 caratteri." });
        return;
      }
      const identity = String(session.user.email || session.user.username || "").trim();
      const verified = await authenticateUser(identity, currentPassword);
      if (!verified) {
        sendJson(res, 401, { error: "Password attuale non valida." });
        return;
      }
      await resetUserPassword(identity, newPassword);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (pathname === "/api/users" && method === "GET") {
      const session = getSessionFromRequest(req);
      if (!session) {
        sendJson(res, 401, { error: "Non autorizzato." });
        return;
      }
      if (!isAdmin(session.user)) {
        sendJson(res, 403, { error: "Permesso negato." });
        return;
      }
      sendJson(res, 200, await listUsers());
      return;
    }
    if (pathname === "/api/users" && method === "POST") {
      const session = getSessionFromRequest(req);
      if (!session) {
        sendJson(res, 401, { error: "Non autorizzato." });
        return;
      }
      if (!isAdmin(session.user)) {
        sendJson(res, 403, { error: "Permesso negato." });
        return;
      }
      const body = (await parseJsonBody(req)) as AuthCreateUserInput;
      const username = String(body.username || "").trim();
      const email = String(body.email || "").trim();
      const name = String(body.name || "").trim();
      const surname = String(body.surname || "").trim();
      const password = String(body.password || "").trim();
      const rawRole = String(body.role || "operatore").trim().toLowerCase();
      const role = rawRole === "super_admin" ? "super_admin" : rawRole === "admin" ? "admin" : "operatore";
      if (role === "super_admin" && !isSuperAdmin(session.user)) {
        sendJson(res, 403, { error: "Solo super admin puo creare super admin." });
        return;
      }
      if (!username || !email || !password) {
        sendJson(res, 400, { error: "Username, email e password obbligatori." });
        return;
      }
      if (!email.includes("@")) {
        sendJson(res, 400, { error: "Email non valida." });
        return;
      }
      if (password.length < 6) {
        sendJson(res, 400, { error: "Password minima 6 caratteri." });
        return;
      }
      const created = await createUser({ username, email, name, surname, password, role });
      sendJson(res, 201, created);
      return;
    }
    const updateMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
    if (updateMatch && method === "PUT") {
      const session = getSessionFromRequest(req);
      if (!session) {
        sendJson(res, 401, { error: "Non autorizzato." });
        return;
      }
      if (!isAdmin(session.user)) {
        sendJson(res, 403, { error: "Permesso negato." });
        return;
      }
      const username = decodeURIComponent(updateMatch[1] || "").trim();
      if (!username) {
        sendJson(res, 400, { error: "Username obbligatorio." });
        return;
      }
      const body = (await parseJsonBody(req)) as AuthUpdateUserInput;
      const updated = await updateUser(username, body);
      sendJson(res, 200, updated);
      return;
    }
    const resetMatch = pathname.match(/^\/api\/users\/([^/]+)\/reset-password$/);
    if (resetMatch && method === "POST") {
      const session = getSessionFromRequest(req);
      if (!session) {
        sendJson(res, 401, { error: "Non autorizzato." });
        return;
      }
      if (!isAdmin(session.user)) {
        sendJson(res, 403, { error: "Permesso negato." });
        return;
      }
      const username = decodeURIComponent(resetMatch[1] || "").trim();
      const body = (await parseJsonBody(req)) as { password?: string };
      const password = String(body.password || "").trim();
      if (!password) {
        sendJson(res, 400, { error: "Password obbligatoria." });
        return;
      }
      if (password.length < 6) {
        sendJson(res, 400, { error: "Password minima 6 caratteri." });
        return;
      }
      await resetUserPassword(username, password);
      sendJson(res, 200, { ok: true });
      return;
    }
    const deleteMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
    if (deleteMatch && method === "DELETE") {
      const session = getSessionFromRequest(req);
      if (!session) {
        sendJson(res, 401, { error: "Non autorizzato." });
        return;
      }
      if (!isAdmin(session.user)) {
        sendJson(res, 403, { error: "Permesso negato." });
        return;
      }
      const username = decodeURIComponent(deleteMatch[1] || "").trim();
      if (!username) {
        sendJson(res, 400, { error: "Username obbligatorio." });
        return;
      }
      if (username.toLowerCase() === session.user.username.toLowerCase()) {
        sendJson(res, 400, { error: "Non puoi eliminare il tuo utente." });
        return;
      }
      await deleteUser(username, session.user.role);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (!pathname.startsWith("/api/")) {
      sendJson(res, 404, {
        error: "Questa porta espone solo API.",
        frontend: FRONTEND_URL,
        hint: "Apri il frontend nel browser e usa /api tramite proxy Vite."
      });
      return;
    }
    const route = mapApiRoute(pathname);
    if (!route) {
      sendJson(res, 404, { error: "Endpoint non trovato." });
      return;
    }
    const session = getSessionFromRequest(req);
    if (!session) {
      sendJson(res, 401, { error: "Non autorizzato." });
      return;
    }
    await proxyRequest(req, res, route.base, `${route.path}${url.search}`);
  } catch (error: any) {
    sendJson(res, 502, { error: sanitizeApiError(error.message) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`api-gateway su http://localhost:${PORT}`);
});
