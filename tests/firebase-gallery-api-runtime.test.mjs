import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const ADMIN_EMAIL = "m042@m042.kr";
const PUSH_KEY = "-1234567890123456789";
const PRIVATE_ROOM = "/000000/박근석_t7/motion_ink_gallery_a7f3c9";
const ADMIN_SESSION_SECRET = "runtime-test-admin-session-secret";

async function loadRoute(relativePath, tag) {
  let source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  if (source.includes('from "../../../lib/adminSession"')) {
    const adminSessionSource = await readFile(
      new URL("../app/lib/adminSession.ts", import.meta.url),
      "utf8",
    );
    const { outputText: adminSessionModule } = ts.transpileModule(
      adminSessionSource,
      {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      },
    );
    const adminSessionUrl = `data:text/javascript;base64,${Buffer.from(adminSessionModule).toString("base64")}`;
    source = source.replace(
      'from "../../../lib/adminSession"',
      `from "${adminSessionUrl}"`,
    );
  }
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const encoded = Buffer.from(outputText).toString("base64");
  return import(`data:text/javascript;base64,${encoded}#${tag}-${Date.now()}`);
}

function adminRequest(method, body) {
  return new Request("https://motion-ink-vrm-studio.m042.chatgpt.site/api/gallery/classes", {
    method,
    headers: {
      "Content-Type": "application/json",
      "oai-authenticated-user-email": ADMIN_EMAIL,
    },
    body: JSON.stringify(body),
  });
}

async function signedAdminCookie() {
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60;
  const nonce = "abcdefghijklmnopqrstuv";
  const payload = `${expiresAt}.${nonce}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(ADMIN_SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = Array.from(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `__Host-vc-admin=${payload}.${signature}`;
}

async function withFetch(mock, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("class creation uses the exact regional Firebase collection and Worker-safe fetch options", async () => {
  const route = await loadRoute(
    "../app/api/gallery/classes/route.ts",
    "class-create",
  );
  let calls = 0;

  const response = await withFetch(async (input, init) => {
    calls += 1;
    const url = new URL(input);
    assert.equal(
      decodeURIComponent(url.pathname),
      `${PRIVATE_ROOM}/classes.json`,
    );
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "follow");
    assert.equal(Object.hasOwn(init, "cache"), false);
    assert.equal(init.headers.Accept, "application/json");
    assert.equal(init.headers["Content-Type"], "application/json; charset=utf-8");
    assert.equal("Authorization" in init.headers, false);
    return Response.json({ name: PUSH_KEY });
  }, () => route.POST(adminRequest("POST", { name: "  1학년 1반  " })));

  assert.equal(calls, 1);
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.classRecord.id, PUSH_KEY);
  assert.equal(payload.classRecord.name, "1학년 1반");
});

test("class creation accepts the signed server administrator session on Netlify", async () => {
  const previousSecret = process.env.ADMIN_SESSION_SECRET;
  process.env.ADMIN_SESSION_SECRET = ADMIN_SESSION_SECRET;
  try {
    const route = await loadRoute(
      "../app/api/gallery/classes/route.ts",
      "class-cookie-create",
    );
    const cookie = await signedAdminCookie();
    let calls = 0;
    const response = await withFetch(async () => {
      calls += 1;
      return Response.json({ name: PUSH_KEY });
    }, () =>
      route.POST(
        new Request("https://virtual-creator.netlify.app/api/gallery/classes", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookie,
          },
          body: JSON.stringify({ name: "넷리파이 학급" }),
        }),
      ));

    assert.equal(response.status, 201);
    assert.equal(calls, 1);
    assert.equal((await response.json()).classRecord.name, "넷리파이 학급");
  } finally {
    if (previousSecret === undefined) delete process.env.ADMIN_SESSION_SECRET;
    else process.env.ADMIN_SESSION_SECRET = previousSecret;
  }
});

test("class creation never retries an uncertain POST and returns actionable network metadata", async () => {
  const route = await loadRoute(
    "../app/api/gallery/classes/route.ts",
    "class-network",
  );
  let calls = 0;
  const response = await withFetch(async () => {
    calls += 1;
    throw new TypeError("simulated Worker subrequest failure");
  }, () => route.POST(adminRequest("POST", { name: "2학년 3반" })));

  assert.equal(calls, 1, "POST must not be retried after an uncertain response");
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error:
      "Firebase 학급 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    code: "firebase_network_error",
    retryable: true,
  });
});

test("Firebase permission and availability failures remain distinguishable", async () => {
  const route = await loadRoute(
    "../app/api/gallery/classes/route.ts",
    "class-upstream-errors",
  );

  const denied = await withFetch(
    async () => Response.json({ error: "Permission denied" }, { status: 403 }),
    () => route.POST(adminRequest("POST", { name: "3학년 1반" })),
  );
  assert.equal(denied.status, 502);
  assert.deepEqual(await denied.json(), {
    error:
      "Firebase Realtime Database 쓰기 권한이 거부되었습니다. 데이터베이스 규칙을 확인해 주세요.",
    code: "firebase_permission_denied",
    retryable: false,
    upstreamStatus: 403,
  });

  const unavailable = await withFetch(
    async () => new Response("unavailable", { status: 503 }),
    () => route.POST(adminRequest("POST", { name: "3학년 2반" })),
  );
  assert.equal(unavailable.status, 502);
  const unavailablePayload = await unavailable.json();
  assert.equal(unavailablePayload.code, "firebase_unavailable");
  assert.equal(unavailablePayload.retryable, true);
  assert.equal(unavailablePayload.upstreamStatus, 503);
});

test("class and gallery deletion target only their validated isolated child", async () => {
  const [classesRoute, galleryRoute] = await Promise.all([
    loadRoute("../app/api/gallery/classes/route.ts", "class-delete"),
    loadRoute("../app/api/gallery/delete/route.ts", "gallery-delete"),
  ]);
  const paths = [];

  await withFetch(async (input, init) => {
    paths.push(decodeURIComponent(new URL(input).pathname));
    assert.equal(init.method, "DELETE");
    assert.equal(init.redirect, "follow");
    assert.equal(Object.hasOwn(init, "cache"), false);
    return new Response("null", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }, async () => {
    const classResponse = await classesRoute.DELETE(
      adminRequest("DELETE", { id: PUSH_KEY }),
    );
    assert.equal(classResponse.status, 200);

    const galleryRequest = new Request("https://motion-ink-vrm-studio.m042.chatgpt.site/api/gallery/delete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "oai-authenticated-user-email": ADMIN_EMAIL,
      },
      body: JSON.stringify({ id: PUSH_KEY }),
    });
    const galleryResponse = await galleryRoute.POST(galleryRequest);
    assert.equal(galleryResponse.status, 200);
  });

  assert.deepEqual(paths, [
    `${PRIVATE_ROOM}/classes/${PUSH_KEY}.json`,
    `${PRIVATE_ROOM}/entries/${PUSH_KEY}.json`,
  ]);
});

test("server authorization rejects class writes before any Firebase request", async () => {
  const route = await loadRoute(
    "../app/api/gallery/classes/route.ts",
    "class-auth",
  );
  let called = false;
  const response = await withFetch(async () => {
    called = true;
    return Response.json({ name: PUSH_KEY });
  }, () =>
    route.POST(
      new Request("https://site.test/api/gallery/classes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "권한 없는 학급" }),
      }),
    ));

  assert.equal(response.status, 403);
  assert.equal(called, false);
});
