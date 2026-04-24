import { clearSession, getAuthToken } from "./auth";

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getAuthToken();
  const baseHeaders: Record<string, string> = { "Content-Type": "application/json" };
  if (token) baseHeaders.Authorization = `Bearer ${token}`;

  const response = await fetch(path, {
    headers: { ...baseHeaders, ...(options.headers as Record<string, string> | undefined) },
    ...options
  });
  const raw = await response.text();
  const isJson = (response.headers.get("content-type") || "").includes("application/json");
  let payload: any = raw;
  if (isJson && raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { error: raw };
    }
  } else if (isJson && !raw) {
    payload = {};
  }

  if (!response.ok) {
    if (response.status === 401) clearSession();
    throw new Error(typeof payload === "string" ? payload : payload.error || "Errore API");
  }
  return payload as T;
}
