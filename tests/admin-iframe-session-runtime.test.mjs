import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

function futureToken() {
  const expiresAt = Math.floor(Date.now() / 1_000) + 3_600;
  return `${expiresAt}.abcdefghijklmnopqrstuv.${"a".repeat(64)}`;
}

async function loadClient(tag) {
  const source = await readFile(
    new URL("../app/lib/adminSessionClient.ts", import.meta.url),
    "utf8",
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(output).toString("base64")}#${tag}-${Date.now()}`
  );
}

test("keeps the signed iframe administrator token in sessionStorage and attaches it as bearer auth", async () => {
  const values = new Map();
  const previousWindow = globalThis.window;
  globalThis.window = {
    sessionStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  };
  try {
    const client = await loadClient("storage");
    const token = futureToken();
    assert.equal(client.storeAdminSessionToken(token), true);
    assert.equal(client.loadAdminSessionToken(), token);
    assert.deepEqual(client.adminRequestHeaders({ Accept: "application/json" }), {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    });
    client.clearAdminSessionToken();
    assert.equal(client.loadAdminSessionToken(), null);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("keeps an in-memory iframe session when embedded storage is blocked", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    sessionStorage: {
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      removeItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    },
  };
  try {
    const client = await loadClient("memory");
    const token = futureToken();
    assert.equal(client.storeAdminSessionToken(token), true);
    assert.equal(
      client.adminRequestHeaders({}).Authorization,
      `Bearer ${token}`,
    );
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("all administrator browser API calls use the iframe bearer helper", async () => {
  const [page, firebase] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/firebaseGallery.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /storeAdminSessionToken\(payload\.token\)/u);
  assert.match(
    page,
    /method:\s*"GET"[\s\S]{0,120}headers:\s*adminRequestHeaders/u,
  );
  assert.match(
    page,
    /method:\s*"DELETE"[\s\S]{0,120}headers:\s*adminRequestHeaders/u,
  );
  assert.equal(
    [...firebase.matchAll(/headers:\s*adminRequestHeaders\(/gu)].length,
    3,
  );
});
