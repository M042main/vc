import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const APP_ORIGIN = "https://virtual-creator.netlify.app";
const PRIVATE_ROOM = "/000000/박근석_t7/motion_ink_gallery_a7f3c9";
const CLASS_ID = "-1234567890123456789";

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

async function loadAdministratorRoutes(tag) {
  const [helperSource, sessionSource, classesSource, galleryDeleteSource] =
    await Promise.all([
      readFile(new URL("../app/lib/adminSession.ts", import.meta.url), "utf8"),
      readFile(
        new URL("../app/api/admin/session/route.ts", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../app/api/gallery/classes/route.ts", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../app/api/gallery/delete/route.ts", import.meta.url),
        "utf8",
      ),
    ]);

  const helperUrl = `data:text/javascript;base64,${Buffer.from(
    transpile(helperSource),
  ).toString("base64")}#admin-helper-${tag}-${Date.now()}`;
  const importHelper = (source) =>
    transpile(source).replace(
      /from\s+["']\.\.\/\.\.\/\.\.\/lib\/adminSession["']/u,
      `from ${JSON.stringify(helperUrl)}`,
    );
  const load = (source, routeTag) =>
    import(
      `data:text/javascript;base64,${Buffer.from(importHelper(source)).toString("base64")}#${routeTag}-${tag}-${Date.now()}`
    );

  const [session, classes, galleryDelete] = await Promise.all([
    load(sessionSource, "session"),
    load(classesSource, "classes"),
    load(galleryDeleteSource, "gallery-delete"),
  ]);
  return { session, classes, galleryDelete };
}

function request(path, method, body, cookie, bearerToken) {
  return new Request(`${APP_ORIGIN}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function withoutAdminEnvironment(run) {
  const previousCode = process.env.ADMIN_ACCESS_CODE;
  const previousSecret = process.env.ADMIN_SESSION_SECRET;
  delete process.env.ADMIN_ACCESS_CODE;
  delete process.env.ADMIN_SESSION_SECRET;
  try {
    return await run();
  } finally {
    if (previousCode === undefined) delete process.env.ADMIN_ACCESS_CODE;
    else process.env.ADMIN_ACCESS_CODE = previousCode;
    if (previousSecret === undefined) delete process.env.ADMIN_SESSION_SECRET;
    else process.env.ADMIN_SESSION_SECRET = previousSecret;
  }
}

test("m042 login authorizes class create/delete and gallery-wide delete without environment variables", async () => {
  await withoutAdminEnvironment(async () => {
    const { session, classes, galleryDelete } =
      await loadAdministratorRoutes("no-env-user-flow");

    const login = await session.POST(
      request("/api/admin/session", "POST", { code: "m042" }),
    );
    assert.equal(login.status, 200);
    const loginPayload = await login.json();
    assert.equal(loginPayload.authenticated, true);
    assert.match(
      loginPayload.token,
      /^\d{10}\.[A-Za-z0-9_-]{22}\.[a-f0-9]{64}$/u,
    );
    const setCookie = login.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /^__Host-vc-admin=/u);
    assert.match(setCookie, /HttpOnly; Secure; SameSite=Strict/u);

    const status = await session.GET(
      new Request(`${APP_ORIGIN}/api/admin/session`, {
        headers: { Authorization: `Bearer ${loginPayload.token}` },
      }),
    );
    assert.deepEqual(await status.json(), { authenticated: true });

    const firebaseCalls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const path = decodeURIComponent(new URL(input).pathname);
      firebaseCalls.push({ path, method: init?.method });
      if (path === `${PRIVATE_ROOM}/classes.json` && init?.method === "POST") {
        return Response.json({ name: CLASS_ID });
      }
      if (
        path === `${PRIVATE_ROOM}/classes/${CLASS_ID}.json` &&
        init?.method === "DELETE"
      ) {
        return Response.json(null);
      }
      if (path === `${PRIVATE_ROOM}/entries.json` && init?.method === "DELETE") {
        return Response.json(null);
      }
      throw new Error(`Unexpected Firebase call: ${init?.method} ${path}`);
    };

    try {
      const created = await classes.POST(
        request(
          "/api/gallery/classes",
          "POST",
          { name: "환경변수 없는 학급" },
          undefined,
          loginPayload.token,
        ),
      );
      assert.equal(created.status, 201);
      assert.equal((await created.json()).classRecord.id, CLASS_ID);

      const classDeleted = await classes.DELETE(
        request(
          "/api/gallery/classes",
          "DELETE",
          { id: CLASS_ID },
          undefined,
          loginPayload.token,
        ),
      );
      assert.equal(classDeleted.status, 200);
      assert.deepEqual(await classDeleted.json(), {
        deleted: true,
        id: CLASS_ID,
      });

      const galleryDeleted = await galleryDelete.POST(
        request(
          "/api/gallery/delete",
          "POST",
          { all: true, confirmation: "DELETE_ALL_GALLERY" },
          undefined,
          loginPayload.token,
        ),
      );
      assert.equal(galleryDeleted.status, 200);
      assert.deepEqual(await galleryDeleted.json(), { deleted: true, all: true });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(firebaseCalls, [
      { path: `${PRIVATE_ROOM}/classes.json`, method: "POST" },
      { path: `${PRIVATE_ROOM}/classes/${CLASS_ID}.json`, method: "DELETE" },
      { path: `${PRIVATE_ROOM}/entries.json`, method: "DELETE" },
    ]);
  });
});
