import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const ADMIN_EMAIL = "m042@m042.kr";
const API_URL =
  "https://motion-ink-vrm-studio.m042.chatgpt.site/api/gallery/delete";
const PRIVATE_ROOM_PATH =
  "/000000/박근석_t7/motion_ink_gallery_a7f3c9.json";

async function loadRoute(tag) {
  const source = await readFile(
    new URL("../app/api/gallery/delete/route.ts", import.meta.url),
    "utf8",
  );
  const adminSessionSource = await readFile(
    new URL("../app/lib/adminSession.ts", import.meta.url),
    "utf8",
  );
  const transpile = (sourceText) =>
    ts.transpileModule(sourceText, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
  const adminSessionUrl = `data:text/javascript;base64,${Buffer.from(
    transpile(adminSessionSource),
  ).toString("base64")}#admin-session-${tag}-${Date.now()}`;
  const routeOutput = transpile(source).replace(
    /from\s+["']\.\.\/\.\.\/\.\.\/lib\/adminSession["']/u,
    `from ${JSON.stringify(adminSessionUrl)}`,
  );
  return import(
    `data:text/javascript;base64,${Buffer.from(routeOutput).toString("base64")}#${tag}-${Date.now()}`
  );
}

function adminRequest(body, url = API_URL) {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "oai-authenticated-user-email": ADMIN_EMAIL,
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

test("bulk deletion rejects untrusted hosts before Firebase", async () => {
  const route = await loadRoute("bulk-auth");
  let called = false;
  const response = await withFetch(async () => {
    called = true;
    return Response.json(null);
  }, () =>
    route.POST(
      adminRequest(
        { all: true, confirmation: "DELETE_ALL_GALLERY" },
        "https://example.net/api/gallery/delete",
      ),
    ),
  );
  assert.equal(response.status, 403);
  assert.equal(called, false);
});

test("bulk deletion requires the exact strong confirmation before Firebase", async () => {
  const route = await loadRoute("bulk-confirmation");
  let called = false;
  const response = await withFetch(async () => {
    called = true;
    return Response.json(null);
  }, () =>
    route.POST(
      adminRequest({ all: true, confirmation: "DELETE ALL" }),
    ),
  );
  assert.equal(response.status, 400);
  assert.equal(called, false);
});

test("confirmed bulk deletion atomically clears metadata and original images in the isolated room", async () => {
  const route = await loadRoute("bulk-success");
  let calls = 0;
  const response = await withFetch(async (input, init) => {
    calls += 1;
    const url = new URL(input);
    assert.equal(decodeURIComponent(url.pathname), PRIVATE_ROOM_PATH);
    assert.equal(url.search, "");
    assert.equal(init.method, "PATCH");
    assert.equal(init.redirect, "follow");
    assert.deepEqual(init.headers, {
      Accept: "application/json",
      "Content-Type": "application/json; charset=utf-8",
    });
    assert.deepEqual(JSON.parse(init.body), {
      entries: null,
      galleryImages: null,
    });
    return Response.json(null);
  }, () =>
    route.POST(
      adminRequest({ all: true, confirmation: "DELETE_ALL_GALLERY" }),
    ),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: true, all: true });
  assert.equal(calls, 1);
});

test("client exposes one explicit helper and never deletes Firebase directly", async () => {
  const source = await readFile(
    new URL("../app/lib/firebaseGallery.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /export async function deleteAllGalleryEntries/u);
  assert.match(
    source,
    /JSON\.stringify\s*\(\s*\{[\s\S]{0,120}all:\s*true,[\s\S]{0,120}confirmation:\s*["']DELETE_ALL_GALLERY["']/u,
  );
  assert.doesNotMatch(source, /\bremove\s*\(/u);
});

test("administrator UI requires a second confirmation before deleting every photo", async () => {
  const source = await readFile(
    new URL("../app/components/OnlineGallery.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /deleteAllGalleryEntries/u);
  assert.match(source, /const \[deleteAllConfirming, setDeleteAllConfirming\]/u);
  assert.match(source, /isAdmin\s*&&\s*entries\.length\s*>\s*0/u);
  assert.match(source, /모든 사진 삭제/u);
  assert.match(source, /모든 사진 삭제 확인/u);
  assert.match(source, /deleteAllInFlightRef\.current/u);
  assert.match(source, /!deleteAllConfirming/u);
  assert.match(source, /deleteAllConfirmRef\.current\?\.focus/u);
  assert.match(source, /deleteAllTriggerRef\.current\?\.focus/u);
});
