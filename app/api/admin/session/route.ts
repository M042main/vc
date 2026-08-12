import {
  adminSessionConfigured,
  clearAdminSessionCookie,
  createAdminSession,
  isAdminRequest,
} from "../../../lib/adminSession";

export const dynamic = "force-dynamic";

const LOGIN_WINDOW_MS = 10 * 60_000;
const LOGIN_ATTEMPT_LIMIT = 5;
const MAX_LOGIN_BUCKETS = 1_000;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function loginIdentity(request: Request) {
  const ip =
    request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-nf-client-connection-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  return ip && ip.length <= 64 ? `ip:${ip}` : `origin:${new URL(request.url).origin}`;
}

function reserveFailedLoginAttempt(request: Request) {
  const key = loginIdentity(request);
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (current && current.resetAt > now) {
    if (current.count >= LOGIN_ATTEMPT_LIMIT) {
      return Math.max(1, Math.ceil((current.resetAt - now) / 1_000));
    }
    current.count += 1;
    return null;
  }
  if (current) loginAttempts.delete(key);
  for (const [bucketKey, bucket] of loginAttempts) {
    if (bucket.resetAt <= now) loginAttempts.delete(bucketKey);
  }
  while (loginAttempts.size >= MAX_LOGIN_BUCKETS) {
    const oldest = loginAttempts.keys().next().value;
    if (typeof oldest !== "string") break;
    loginAttempts.delete(oldest);
  }
  loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  return null;
}

function json(body: Record<string, unknown>, status = 200, cookie?: string) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...(cookie ? { "Set-Cookie": cookie } : {}),
    },
  });
}

export async function GET(request: Request) {
  return json({ authenticated: await isAdminRequest(request) });
}

export async function POST(request: Request) {
  if (!adminSessionConfigured()) {
    return json(
      {
        error: "관리자 로그인이 아직 설정되지 않았습니다.",
        code: "admin_not_configured",
      },
      503,
    );
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "관리자 로그인 요청이 올바르지 않습니다." }, 400);
  }
  const code =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).code
      : null;
  if (typeof code !== "string" || !code.trim() || code.length > 128) {
    return json({ error: "관리자 코드를 입력해 주세요." }, 400);
  }
  const session = await createAdminSession(code);
  if (session) {
    // Successful logins must never consume the guess limit. Clearing the
    // bucket also lets the real administrator recover immediately after
    // failed attempts from the same classroom network.
    loginAttempts.delete(loginIdentity(request));
    return json(
      {
        authenticated: true,
        // The signed session value lets an embedded app authorize its own
        // same-origin API calls even when the top-level browser blocks this
        // origin's third-party cookie. The submitted administrator code is
        // never returned to the browser.
        token: session.token,
      },
      200,
      session.cookie,
    );
  }

  const retryAfter = reserveFailedLoginAttempt(request);
  if (retryAfter !== null) {
    return Response.json(
      {
        error: "관리자 로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
        code: "admin_rate_limited",
        retryable: true,
      },
      {
        status: 429,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": String(retryAfter),
        },
      },
    );
  }
  return json({ error: "관리자 코드가 일치하지 않습니다." }, 403);
}

export async function DELETE() {
  return json({ authenticated: false }, 200, clearAdminSessionCookie());
}
