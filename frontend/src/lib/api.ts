import { clearSession, getAuthToken } from "./auth";
import { apiUrl } from "./api-url";

/** Same message as before; also keeps the HTTP status and JSON body (e.g. a conflict `code`). */
export class ApiError extends Error {
  constructor(message: string, public status: number, public payload: any) { super(message); }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getAuthToken();
  const baseHeaders: Record<string, string> = { "Content-Type": "application/json" };
  if (token) baseHeaders.Authorization = `Bearer ${token}`;

  const response = await fetch(apiUrl(path), {
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
    throw new ApiError(typeof payload === "string" ? payload : payload.error || "Errore API", response.status, payload);
  }
  return payload as T;
}
