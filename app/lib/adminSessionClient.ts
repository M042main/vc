const ADMIN_SESSION_STORAGE_KEY = "virtual-creator.admin-session.v1";
const ADMIN_TOKEN_PATTERN = /^(\d{10})\.[A-Za-z0-9_-]{22}\.[a-f0-9]{64}$/u;
const ADMIN_SESSION_MAX_SECONDS = 8 * 60 * 60;

let inMemoryToken: string | null = null;

function validToken(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(ADMIN_TOKEN_PATTERN);
  if (!match) return false;
  const expiresAt = Number(match[1]);
  const now = Math.floor(Date.now() / 1_000);
  return (
    Number.isSafeInteger(expiresAt) &&
    expiresAt > now &&
    expiresAt <= now + ADMIN_SESSION_MAX_SECONDS + 60
  );
}

export function loadAdminSessionToken() {
  if (validToken(inMemoryToken)) return inMemoryToken;
  inMemoryToken = null;
  if (typeof window === "undefined") return null;
  try {
    const stored = window.sessionStorage.getItem(ADMIN_SESSION_STORAGE_KEY);
    if (validToken(stored)) {
      inMemoryToken = stored;
      return stored;
    }
    window.sessionStorage.removeItem(ADMIN_SESSION_STORAGE_KEY);
  } catch {
    // Some embedded browser policies deny storage. The in-memory copy still
    // keeps the current iframe session usable until it is reloaded.
  }
  return null;
}

export function storeAdminSessionToken(token: string) {
  if (!validToken(token)) return false;
  inMemoryToken = token;
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(ADMIN_SESSION_STORAGE_KEY, token);
    } catch {
      // Keep the in-memory token when iframe storage is unavailable.
    }
  }
  return true;
}

export function clearAdminSessionToken() {
  inMemoryToken = null;
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(ADMIN_SESSION_STORAGE_KEY);
  } catch {
    // Storage may be unavailable in a sandboxed iframe.
  }
}

export function adminRequestHeaders(headers: Record<string, string>) {
  const token = loadAdminSessionToken();
  return token ? { ...headers, Authorization: `Bearer ${token}` } : headers;
}
