const AUTHENTICATED_USER_EMAIL_HEADER = "oai-authenticated-user-email";
const ADMIN_EMAIL = "m042@m042.kr";
const TRUSTED_SITES_HOSTNAME = "motion-ink-vrm-studio.m042.chatgpt.site";
const ADMIN_COOKIE_NAME = "__Host-vc-admin";
const ADMIN_SESSION_SECONDS = 8 * 60 * 60;
const TOKEN_PATTERN = /^(\d{10})\.([A-Za-z0-9_-]{22})\.([a-f0-9]{64})$/u;
const DEFAULT_ADMIN_ACCESS_CODE = "m042";
// Convenience fallback for the fixed classroom code. Deployments that override
// the access code must also provide their own independent session secret.
const DEFAULT_ADMIN_SESSION_SECRET =
  "virtual-creator-classroom-admin-session-m042-v1";

const encoder = new TextEncoder();

function environmentValue(name: "ADMIN_ACCESS_CODE" | "ADMIN_SESSION_SECRET") {
  const value = process.env[name]?.trim();
  return value || null;
}

function sessionSecret() {
  const value = environmentValue("ADMIN_SESSION_SECRET");
  if (value) return value.length >= 32 ? value : null;
  return environmentValue("ADMIN_ACCESS_CODE")
    ? null
    : DEFAULT_ADMIN_SESSION_SECRET;
}

function configuredAccessCode() {
  return environmentValue("ADMIN_ACCESS_CODE") ?? DEFAULT_ADMIN_ACCESS_CODE;
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

async function sha256(value: string) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function hmac(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))),
  );
}

async function equalSecrets(left: string, right: string) {
  const [leftHash, rightHash] = await Promise.all([sha256(left), sha256(right)]);
  let difference = leftHash.length ^ rightHash.length;
  const length = Math.max(leftHash.length, rightHash.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftHash.charCodeAt(index) || 0) ^ (rightHash.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function cookieValue(request: Request) {
  const cookieHeader = request.headers.get("cookie") ?? "";
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== ADMIN_COOKIE_NAME) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

function isTrustedSitesAdmin(request: Request) {
  return (
    new URL(request.url).hostname.toLowerCase() === TRUSTED_SITES_HOSTNAME &&
    request.headers.get(AUTHENTICATED_USER_EMAIL_HEADER) === ADMIN_EMAIL
  );
}

async function verifyToken(token: string | null) {
  const secret = sessionSecret();
  const match = token?.match(TOKEN_PATTERN);
  if (!secret || !match) return false;
  const expiresAt = Number(match[1]);
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + ADMIN_SESSION_SECONDS + 60
  ) {
    return false;
  }
  const payload = `${match[1]}.${match[2]}`;
  return equalSecrets(match[3], await hmac(payload, secret));
}

export function adminSessionConfigured() {
  return Boolean(configuredAccessCode() && sessionSecret());
}

export async function createAdminSessionCookie(accessCode: string) {
  const configuredCode = configuredAccessCode();
  const secret = sessionSecret();
  if (!configuredCode || !secret) return null;
  if (!(await equalSecrets(accessCode.normalize("NFKC").trim(), configuredCode))) {
    return false;
  }
  const expiresAt = Math.floor(Date.now() / 1000) + ADMIN_SESSION_SECONDS;
  const nonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const payload = `${expiresAt}.${nonce}`;
  const token = `${payload}.${await hmac(payload, secret)}`;
  return `${ADMIN_COOKIE_NAME}=${token}; Path=/; Max-Age=${ADMIN_SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearAdminSessionCookie() {
  return `${ADMIN_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export async function isAdminRequest(request: Request) {
  return isTrustedSitesAdmin(request) || verifyToken(cookieValue(request));
}
