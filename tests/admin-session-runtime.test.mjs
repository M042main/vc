import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const SITES_URL = "https://motion-ink-vrm-studio.m042.chatgpt.site";

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

async function loadModules(tag) {
  const [helperSource, routeSource] = await Promise.all([
    readFile(new URL("../app/lib/adminSession.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/session/route.ts", import.meta.url), "utf8"),
  ]);
  const helperUrl = `data:text/javascript;base64,${Buffer.from(
    transpile(helperSource),
  ).toString("base64")}#helper-${tag}-${Date.now()}`;
  const routeOutput = transpile(routeSource).replace(
    /from\s+["']\.\.\/\.\.\/\.\.\/lib\/adminSession["']/u,
    `from ${JSON.stringify(helperUrl)}`,
  );
  const [helper, route] = await Promise.all([
    import(helperUrl),
    import(
      `data:text/javascript;base64,${Buffer.from(routeOutput).toString("base64")}#route-${tag}-${Date.now()}`
    ),
  ]);
  return { helper, route };
}

async function withAdminEnvironment(values, run) {
  const originalCode = process.env.ADMIN_ACCESS_CODE;
  const originalSecret = process.env.ADMIN_SESSION_SECRET;
  if (values.code === undefined) delete process.env.ADMIN_ACCESS_CODE;
  else process.env.ADMIN_ACCESS_CODE = values.code;
  if (values.secret === undefined) delete process.env.ADMIN_SESSION_SECRET;
  else process.env.ADMIN_SESSION_SECRET = values.secret;
  try {
    return await run();
  } finally {
    if (originalCode === undefined) delete process.env.ADMIN_ACCESS_CODE;
    else process.env.ADMIN_ACCESS_CODE = originalCode;
    if (originalSecret === undefined) delete process.env.ADMIN_SESSION_SECRET;
    else process.env.ADMIN_SESSION_SECRET = originalSecret;
  }
}

test("trusts the Sites identity header only on the exact Sites hostname", async () => {
  const { helper } = await loadModules("sites-host");
  const headers = { "oai-authenticated-user-email": "m042@m042.kr" };
  assert.equal(
    await helper.isAdminRequest(new Request(`${SITES_URL}/api/gallery/classes`, { headers })),
    true,
  );
  assert.equal(
    await helper.isAdminRequest(
      new Request("https://virtual-creator.netlify.app/api/gallery/classes", { headers }),
    ),
    false,
  );
});

test("accepts the built-in m042 administrator login without environment variables", async () => {
  const { route } = await loadModules("built-in-login");
  await withAdminEnvironment({ code: undefined, secret: undefined }, async () => {
    const wrong = await route.POST(
      new Request(`${SITES_URL}/api/admin/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "not-m042" }),
      }),
    );
    assert.equal(wrong.status, 403);

    const response = await route.POST(
      new Request(`${SITES_URL}/api/admin/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "m042" }),
      }),
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.authenticated, true);
    assert.match(payload.token, /^\d{10}\.[A-Za-z0-9_-]{22}\.[a-f0-9]{64}$/u);
    assert.equal(JSON.stringify(payload).includes("m042"), false);
    assert.match(response.headers.get("set-cookie") ?? "", /^__Host-vc-admin=/u);
  });
});

test("fails closed when a custom administrator code lacks a strong session secret", async () => {
  const { route } = await loadModules("unsafe-custom-configuration");
  await withAdminEnvironment({ code: "custom-code", secret: undefined }, async () => {
    const response = await route.POST(
      new Request(`${SITES_URL}/api/admin/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "custom-code" }),
      }),
    );
    assert.equal(response.status, 503);
  });
  await withAdminEnvironment({ code: "m042", secret: "too-short" }, async () => {
    const response = await route.POST(
      new Request(`${SITES_URL}/api/admin/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "m042" }),
      }),
    );
    assert.equal(response.status, 503);
  });
});

test("issues and verifies a signed HttpOnly administrator cookie", async () => {
  const { route } = await loadModules("signed-cookie");
  await withAdminEnvironment(
    { code: undefined, secret: undefined },
    async () => {
      const wrong = await route.POST(
        new Request("https://virtual-creator.netlify.app/api/admin/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "wrong" }),
        }),
      );
      assert.equal(wrong.status, 403);

      const login = await route.POST(
        new Request("https://virtual-creator.netlify.app/api/admin/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "m042" }),
        }),
      );
      assert.equal(login.status, 200);
      const setCookie = login.headers.get("set-cookie") ?? "";
      assert.match(setCookie, /^__Host-vc-admin=/u);
      assert.match(setCookie, /HttpOnly/u);
      assert.match(setCookie, /Secure/u);
      assert.match(setCookie, /SameSite=Strict/u);
      const cookie = setCookie.split(";", 1)[0];

      const status = await route.GET(
        new Request("https://virtual-creator.netlify.app/api/admin/session", {
          headers: { Cookie: cookie },
        }),
      );
      assert.equal(status.status, 200);
      assert.deepEqual(await status.json(), { authenticated: true });

      const loginPayload = await login.json();
      const bearerStatus = await route.GET(
        new Request("https://virtual-creator.netlify.app/api/admin/session", {
          headers: { Authorization: `Bearer ${loginPayload.token}` },
        }),
      );
      assert.deepEqual(await bearerStatus.json(), { authenticated: true });

      const malformedBearerStatus = await route.GET(
        new Request("https://virtual-creator.netlify.app/api/admin/session", {
          headers: { Authorization: `Bearer ${loginPayload.token} extra` },
        }),
      );
      assert.deepEqual(await malformedBearerStatus.json(), {
        authenticated: false,
      });
    },
  );
});

test("logout clears the signed administrator cookie", async () => {
  const { route } = await loadModules("logout");
  const response = await route.DELETE();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie") ?? "", /^__Host-vc-admin=;/u);
  assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/u);
});

test("rate-limits repeated incorrect administrator login guesses", async () => {
  const { route } = await loadModules("rate-limit");
  await withAdminEnvironment(
    { code: undefined, secret: undefined },
    async () => {
      const request = () =>
        new Request("https://virtual-creator.netlify.app/api/admin/session", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-nf-client-connection-ip": "203.0.113.42",
          },
          body: JSON.stringify({ code: "wrong" }),
        });
      for (let index = 0; index < 5; index += 1) {
        assert.equal((await route.POST(request())).status, 403);
      }
      const blocked = await route.POST(request());
      assert.equal(blocked.status, 429);
      assert.match(blocked.headers.get("retry-after") ?? "", /^\d+$/u);
    },
  );
});

test("does not rate-limit repeated successful m042 logins", async () => {
  const { route } = await loadModules("successful-logins");
  await withAdminEnvironment(
    { code: undefined, secret: undefined },
    async () => {
      const request = () =>
        new Request("https://virtual-creator.netlify.app/api/admin/session", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-nf-client-connection-ip": "203.0.113.43",
          },
          body: JSON.stringify({ code: "m042" }),
        });
      for (let index = 0; index < 8; index += 1) {
        assert.equal((await route.POST(request())).status, 200);
      }
    },
  );
});

test("a successful m042 login clears prior failed attempts", async () => {
  const { route } = await loadModules("successful-login-reset");
  await withAdminEnvironment(
    { code: undefined, secret: undefined },
    async () => {
      const request = (code) =>
        new Request("https://virtual-creator.netlify.app/api/admin/session", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-nf-client-connection-ip": "203.0.113.44",
          },
          body: JSON.stringify({ code }),
        });
      for (let index = 0; index < 5; index += 1) {
        assert.equal((await route.POST(request("wrong"))).status, 403);
      }

      assert.equal((await route.POST(request("m042"))).status, 200);
      assert.equal((await route.POST(request("wrong"))).status, 403);
    },
  );
});
