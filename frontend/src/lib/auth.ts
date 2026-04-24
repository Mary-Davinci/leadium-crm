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
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

function saveSession(payload: LoginResponse) {
  localStorage.setItem(AUTH_TOKEN_KEY, payload.token);
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(payload.user));
}

export function clearSession() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_USER_KEY);
}

export async function login(email: string, password: string) {
  const response = await fetch("/api/auth/login", {
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
    await fetch("/api/auth/logout", {
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
  const response = await fetch("/api/auth/me", {
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
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(payload.user));
  return payload.user;
}
