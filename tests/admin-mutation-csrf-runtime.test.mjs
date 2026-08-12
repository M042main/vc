import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const APP_ORIGIN = "https://motion-ink-vrm-studio.m042.chatgpt.site";
const ADMIN_EMAIL = "m042@m042.kr";
const PUSH_KEY = "-1234567890123456789";

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

async function loadRoutes(tag) {
  const [helperSource, classesSource, deleteSource] = await Promise.all([
    readFile(new URL("../app/lib/adminSession.ts", import.meta.url), "utf8"),
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
  ).toString("base64")}#csrf-helper-${tag}-${Date.now()}`;
  const load = (source, routeTag) => {
    const output = transpile(source).replace(
      /from\s+["']\.\.\/\.\.\/\.\.\/lib\/adminSession["']/u,
      `from ${JSON.stringify(helperUrl)}`,
    );
    return import(
      `data:text/javascript;base64,${Buffer.from(output).toString("base64")}#${routeTag}-${tag}-${Date.now()}`
    );
  };
  const [classes, galleryDelete] = await Promise.all([
    load(classesSource, "classes"),
    load(deleteSource, "gallery-delete"),
  ]);
  return { classes, galleryDelete };
}

function request(path, method, body, headers = {}) {
  return new Request(`${APP_ORIGIN}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "oai-authenticated-user-email": ADMIN_EMAIL,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function withoutFirebaseCalls(run) {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json(null);
  };
  try {
    await run();
    assert.equal(calls, 0, "rejected browser mutations must stop before Firebase");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("rejects hostile same-site origins and fetch metadata before every Firebase mutation", async () => {
  const { classes, galleryDelete } = await loadRoutes("hostile-origin");
  const attacks = [
    () =>
      classes.POST(
        request("/api/gallery/classes", "POST", { name: "공격 학급" }, {
          Origin: "https://attacker.m042.chatgpt.site",
          "Sec-Fetch-Site": "same-site",
        }),
      ),
    () =>
      classes.PATCH(
        request(
          "/api/gallery/classes",
          "PATCH",
          { id: PUSH_KEY, aiEnabled: false },
          { "Sec-Fetch-Site": "same-site" },
        ),
      ),
    () =>
      classes.DELETE(
        request("/api/gallery/classes", "DELETE", { id: PUSH_KEY }, {
          Origin: "https://attacker.m042.chatgpt.site",
        }),
      ),
    () =>
      galleryDelete.POST(
        request("/api/gallery/delete", "POST", { id: PUSH_KEY }, {
          Origin: "https://attacker.m042.chatgpt.site",
        }),
      ),
  ];

  await withoutFirebaseCalls(async () => {
    for (const attack of attacks) {
      const response = await attack();
      assert.equal(response.status, 403);
    }
  });
});

test("rejects text/plain administrator mutations even with otherwise valid authentication", async () => {
  const { classes, galleryDelete } = await loadRoutes("text-plain");
  await withoutFirebaseCalls(async () => {
    const classResponse = await classes.POST(
      request("/api/gallery/classes", "POST", { name: "공격 학급" }, {
        "Content-Type": "text/plain",
      }),
    );
    assert.equal(classResponse.status, 403);

    const galleryResponse = await galleryDelete.POST(
      request("/api/gallery/delete", "POST", {
        all: true,
        confirmation: "DELETE_ALL_GALLERY",
      }, {
        "Content-Type": "text/plain;charset=UTF-8",
      }),
    );
    assert.equal(galleryResponse.status, 403);
  });
});

test("allows authenticated JSON runtime requests when browser metadata is absent", async () => {
  const helperSource = await readFile(
    new URL("../app/lib/adminSession.ts", import.meta.url),
    "utf8",
  );
  const helper = await import(
    `data:text/javascript;base64,${Buffer.from(transpile(helperSource)).toString("base64")}#valid-runtime-${Date.now()}`
  );
  const valid = request("/api/gallery/classes", "POST", { name: "정상 학급" });
  assert.equal(await helper.isAdminMutationRequest(valid), true);
});
