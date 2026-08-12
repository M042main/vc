import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const ADMIN_EMAIL = "m042@m042.kr";
const PUSH_KEY = "-1234567890123456789";
const PRIVATE_ROOM = "/000000/박근석_t7/motion_ink_gallery_a7f3c9";

async function source(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

async function loadRoute(tag) {
  let routeSource = await source("../app/api/gallery/classes/route.ts");
  const adminSessionSource = await source("../app/lib/adminSession.ts");
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
  routeSource = routeSource.replace(
    'from "../../../lib/adminSession"',
    `from "${adminSessionUrl}"`,
  );
  const { outputText } = ts.transpileModule(routeSource, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const encoded = Buffer.from(outputText).toString("base64");
  return import(`data:text/javascript;base64,${encoded}#${tag}-${Date.now()}`);
}

function request(method, body, email = ADMIN_EMAIL) {
  return new Request("https://motion-ink-vrm-studio.m042.chatgpt.site/api/gallery/classes", {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(email ? { "oai-authenticated-user-email": email } : {}),
    },
    body: JSON.stringify(body),
  });
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

test("normalizes legacy class records to AI enabled and preserves explicit off", async () => {
  const firebase = await source("../app/lib/firebaseGallery.ts");

  assert.match(
    firebase,
    /export type ClassRecord\s*=\s*\{[\s\S]{0,220}aiEnabled:\s*boolean/u,
  );
  assert.ok(
    [...firebase.matchAll(/aiEnabled:\s*candidate\.aiEnabled\s*!==\s*false/gu)]
      .length >= 2,
    "snapshot subscriptions and exact-class reads must both treat legacy records as enabled",
  );
  assert.match(
    firebase,
    /export function subscribeClassRecords[\s\S]{0,500}classesFromSnapshot/u,
  );
});

test("administrator UI offers an accessible per-class AI switch", async () => {
  const [onboarding, css] = await Promise.all([
    source("../app/components/ClassOnboarding.tsx"),
    source("../app/components/ClassOnboarding.module.css"),
  ]);

  assert.match(onboarding, /setClassAiEnabled\(classRecord\.id, nextEnabled\)/u);
  assert.match(
    onboarding,
    /role="switch"[\s\S]{0,180}aria-checked=\{item\.aiEnabled\}/u,
  );
  assert.match(onboarding, /data-enabled=\{item\.aiEnabled\}/u);
  assert.match(css, /\.aiToggle\[data-enabled="true"\]/u);
});

test("protected setting update verifies the class before patching only aiEnabled", async () => {
  const route = await loadRoute("class-ai-patch");
  const calls = [];

  const response = await withFetch(async (input, init) => {
    calls.push({ input, init });
    assert.equal(
      decodeURIComponent(new URL(input).pathname),
      `${PRIVATE_ROOM}/classes/${PUSH_KEY}.json`,
    );
    assert.equal(init.redirect, "follow");
    assert.equal(init.headers.Accept, "application/json");
    if (calls.length === 1) {
      assert.equal(init.method, "GET");
      assert.equal(init.headers["X-Firebase-ETag"], "true");
      assert.equal(Object.hasOwn(init, "body"), false);
      return Response.json(
        { name: "1학년 1반", createdAt: 1_800_000_000_000 },
        { headers: { ETag: '"class-version-1"' } },
      );
    }
    assert.equal(calls.length, 2, "only one verification and one write are allowed");
    assert.equal(init.method, "PATCH");
    assert.deepEqual(JSON.parse(init.body), { aiEnabled: false });
    assert.equal(init.headers["Content-Type"], "application/json; charset=utf-8");
    assert.equal(init.headers["If-Match"], '"class-version-1"');
    return Response.json({ aiEnabled: false });
  }, () => route.PATCH(request("PATCH", { id: PUSH_KEY, aiEnabled: false })));

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ init }) => init.method), ["GET", "PATCH"]);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    updated: true,
    id: PUSH_KEY,
    aiEnabled: false,
  });
});

test("a concurrent class deletion cannot be recreated by the AI setting PATCH", async () => {
  const route = await loadRoute("class-ai-conflict");
  let calls = 0;

  const response = await withFetch(async (_input, init) => {
    calls += 1;
    if (calls === 1) {
      return Response.json(
        { name: "1학년 1반", createdAt: 1_800_000_000_000 },
        { headers: { ETag: '"class-version-before-delete"' } },
      );
    }
    assert.equal(init.method, "PATCH");
    assert.equal(init.headers["If-Match"], '"class-version-before-delete"');
    return Response.json({ error: "ETag mismatch" }, { status: 412 });
  }, () => route.PATCH(request("PATCH", { id: PUSH_KEY, aiEnabled: true })));

  assert.equal(calls, 2);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "학급 정보가 동시에 변경되었습니다. 목록을 확인한 뒤 다시 시도해 주세요.",
    code: "firebase_conflict",
    retryable: true,
    upstreamStatus: 412,
  });
});

test("a missing class returns 404 without creating an orphan setting child", async () => {
  const route = await loadRoute("class-ai-missing");
  let calls = 0;

  const response = await withFetch(async (input, init) => {
    calls += 1;
    assert.equal(
      decodeURIComponent(new URL(input).pathname),
      `${PRIVATE_ROOM}/classes/${PUSH_KEY}.json`,
    );
    assert.equal(init.method, "GET");
    return Response.json(null);
  }, () => route.PATCH(request("PATCH", { id: PUSH_KEY, aiEnabled: true })));

  assert.equal(calls, 1, "a missing class must never reach the PATCH write");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: "변경할 학급을 찾지 못했습니다.",
    code: "firebase_not_found",
    retryable: false,
  });
});

test("AI setting writes require the exact administrator email and boolean payload", async () => {
  const route = await loadRoute("class-ai-auth");
  let called = false;

  const unauthorized = await withFetch(async () => {
    called = true;
    return Response.json({});
  }, () => route.PATCH(request("PATCH", { id: PUSH_KEY, aiEnabled: false }, "")));
  assert.equal(unauthorized.status, 403);
  assert.equal(called, false);

  const invalid = await withFetch(async () => {
    called = true;
    return Response.json({});
  }, () => route.PATCH(request("PATCH", { id: PUSH_KEY, aiEnabled: "false" })));
  assert.equal(invalid.status, 400);
  assert.equal(called, false);
});

test("new classes explicitly start with AI image generation enabled", async () => {
  const route = await loadRoute("class-ai-create-default");

  const response = await withFetch(async (_input, init) => {
    assert.deepEqual(JSON.parse(init.body), {
      name: "새 학급",
      createdAt: JSON.parse(init.body).createdAt,
      aiEnabled: true,
    });
    return Response.json({ name: PUSH_KEY });
  }, () => route.POST(request("POST", { name: "새 학급" })));

  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.classRecord.aiEnabled, true);
});
