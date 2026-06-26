import { apiUrl } from "./api-url";

type AuthUser = {
  id: string;
  username: string;
  name: string;
  role: "super_admin" | "admin" | "operatore";
  email?: string;
  surname?: string;
};

type LoginResponse = {
  token: string;
  user: AuthUser;
  expiresInHours: number;
};

const AUTH_TOKEN_KEY = "crm.auth.token";
const AUTH_USER_KEY = "crm.auth.user";

function normalizeAuthRole(role: unknown): AuthUser["role"] {
  const normalized = String(role || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (normalized === "super_admin" || normalized === "superadmin") return "super_admin";
  if (normalized === "admin") return "admin";
  return "operatore";
}

function normalizeAuthUser(user: AuthUser): AuthUser {
  return {
    ...user,
    role: normalizeAuthRole(user?.role)
  };
}

async function readPayload(response: Response): Promise<any> {
  const raw = await response.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { error: raw };
  }
}

export function getAuthToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY) || "";
}

export function getAuthUser(): AuthUser | null {
  const raw = localStorage.getItem(AUTH_USER_KEY);
  if (!raw) return null;
  try {
    return normalizeAuthUser(JSON.parse(raw) as AuthUser);
  } catch {
    return null;
  }
}

function saveSession(payload: LoginResponse) {
  localStorage.setItem(AUTH_TOKEN_KEY, payload.token);
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(normalizeAuthUser(payload.user)));
}

export function clearSession() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_USER_KEY);
}

export async function login(email: string, password: string) {
  const response = await fetch(apiUrl("/api/auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const payload = (await readPayload(response)) as LoginResponse | { error?: string };
  if (!response.ok) {
    throw new Error((payload as { error?: string }).error || "Login fallito");
  }
  saveSession(payload as LoginResponse);
  return payload as LoginResponse;
}

export async function logout() {
  const token = getAuthToken();
  try {
    await fetch(apiUrl("/api/auth/logout"), {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined
    });
  } finally {
    clearSession();
  }
}

export async function fetchMe() {
  const token = getAuthToken();
  if (!token) return null;
  const response = await fetch(apiUrl("/api/auth/me"), {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    clearSession();
    return null;
  }
  const payload = (await readPayload(response)) as { user?: AuthUser };
  if (!payload.user) {
    clearSession();
    return null;
  }
  const normalizedUser = normalizeAuthUser(payload.user);
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(normalizedUser));
  return normalizedUser;
}
