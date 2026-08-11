import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const routeUrl = new URL("../app/api/ai/generate/route.ts", import.meta.url);
const TEST_API_KEY = "test-only-gemini-key";

function pngDataUrl(width = 64, height = 64) {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  Buffer.from("IHDR", "ascii").copy(bytes, 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function imageResponse(imageDataUrl = pngDataUrl(1024, 1024)) {
  const match = /^(data:([^;]+);base64,)(.*)$/u.exec(imageDataUrl);
  assert.ok(match);
  const data = match[3];
  return Response.json({
    candidates: [
      {
        content: {
          parts: [
            { text: "완성된 캐릭터입니다." },
            { inlineData: { mimeType: "image/png", data } },
          ],
        },
      },
    ],
  });
}

async function loadRoute(tag) {
  const source = await readFile(routeUrl, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const encoded = Buffer.from(outputText).toString("base64");
  return import(`data:text/javascript;base64,${encoded}#${tag}-${Date.now()}`);
}

function generationRequest(payload, headers = {}) {
  return new Request("https://site.test/api/ai/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

async function withApiKey(value, run) {
  const previous = process.env.GEMINI_API_KEY;
  if (value === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
  }
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

test("Gemini key stays server-only and the route is Edge/Worker compatible", async () => {
  const source = await readFile(routeUrl, "utf8");

  assert.match(source, /process\.env\.GEMINI_API_KEY/);
  assert.match(source, /export const runtime = "edge"/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /REQUEST_TIMEOUT_MS\s*=\s*60_000/);
  assert.match(source, /sec-fetch-site/);
  assert.match(source, /cf-connecting-ip/);
  assert.match(source, /const rateLimitBuckets = new Map/);
  assert.doesNotMatch(source, /AIza[0-9A-Za-z_-]{20,}/);
  assert.doesNotMatch(source, /Buffer|node:/);
});

test("cross-site browser requests are rejected and warm-isolate bursts are bounded", async () => {
  const route = await loadRoute("abuse-guards");
  let calls = 0;

  await withApiKey(TEST_API_KEY, async () => {
    const crossSite = await withFetch(async () => {
      calls += 1;
      return imageResponse();
    }, () =>
      route.POST(
        generationRequest(
          { prompt: "캐릭터", imageDataUrl: pngDataUrl() },
          {
            Origin: "https://attacker.test",
            "Sec-Fetch-Site": "cross-site",
          },
        ),
      ),
    );
    assert.equal(crossSite.status, 403);
    assert.equal((await crossSite.json()).code, "request_origin_denied");
    assert.equal(calls, 0);

    await withFetch(async () => {
      calls += 1;
      return imageResponse();
    }, async () => {
      for (let index = 0; index < 10; index += 1) {
        const response = await route.POST(
          generationRequest(
            { prompt: "캐릭터", imageDataUrl: pngDataUrl() },
            {
              Origin: "https://site.test",
              "Sec-Fetch-Site": "same-origin",
              "oai-authenticated-user-id": "test-user",
            },
          ),
        );
        assert.equal(response.status, 200);
      }
      const limited = await route.POST(
        generationRequest(
          { prompt: "캐릭터", imageDataUrl: pngDataUrl() },
          {
            Origin: "https://site.test",
            "Sec-Fetch-Site": "same-origin",
            "oai-authenticated-user-id": "test-user",
          },
        ),
      );
      assert.equal(limited.status, 429);
      assert.equal((await limited.json()).code, "ai_rate_limited");
      assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    });
  });

  assert.equal(calls, 10);
});

test("valid image+prompt uses the official Gemini 2.5 Flash Image REST shape", async () => {
  const route = await loadRoute("success");
  const inputImage = pngDataUrl(640, 960);
  let calls = 0;

  const response = await withApiKey(TEST_API_KEY, () =>
    withFetch(async (input, init) => {
      calls += 1;
      assert.equal(
        String(input),
        "https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash-image:generateContent",
      );
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers["x-goog-api-key"], TEST_API_KEY);
      assert.equal(init.headers.Authorization, undefined);
      assert.ok(init.signal instanceof AbortSignal);

      const body = JSON.parse(init.body);
      assert.deepEqual(body.generationConfig, { responseModalities: ["IMAGE"] });
      assert.deepEqual(body.contents, [
        {
          role: "user",
          parts: [
            { text: "내 사진을 수채화 캐릭터로 바꿔 줘" },
            {
              inlineData: {
                mimeType: "image/png",
                data: inputImage.split(",")[1],
              },
            },
          ],
        },
      ]);
      return imageResponse();
    }, () =>
      route.POST(
        generationRequest({
          prompt: "  내 사진을 수채화 캐릭터로 바꿔 줘  ",
          imageDataUrl: inputImage,
        }),
      ),
    ),
  );

  assert.equal(calls, 1);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const payload = await response.json();
  assert.equal(payload.result.model, "gemini-2.5-flash-image");
  assert.equal(payload.result.mimeType, "image/png");
  assert.equal(payload.result.width, 1024);
  assert.equal(payload.result.height, 1024);
  assert.match(payload.result.imageDataUrl, /^data:image\/png;base64,/);
});

test("missing server configuration fails before parsing or contacting Gemini", async () => {
  const route = await loadRoute("missing-config");
  let called = false;
  const response = await withApiKey(undefined, () =>
    withFetch(async () => {
      called = true;
      return imageResponse();
    }, () =>
      route.POST(
        generationRequest({ prompt: "캐릭터", imageDataUrl: pngDataUrl() }),
      ),
    ),
  );

  assert.equal(called, false);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "AI 이미지 생성 기능이 아직 설정되지 않았습니다.",
    code: "ai_not_configured",
    retryable: false,
  });
});

test("content type, malformed JSON, prompt, MIME, byte size, and resolution are bounded", async () => {
  const route = await loadRoute("input-validation");
  await withApiKey(TEST_API_KEY, async () => {
    const unsupported = await route.POST(
      new Request("https://site.test/api/ai/generate", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "{}",
      }),
    );
    assert.equal(unsupported.status, 415);

    const malformed = await route.POST(
      new Request("https://site.test/api/ai/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not-json",
      }),
    );
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).code, "invalid_json");

    const longPrompt = await route.POST(
      generationRequest({ prompt: "가".repeat(1_201), imageDataUrl: pngDataUrl() }),
    );
    assert.equal((await longPrompt.json()).code, "invalid_prompt");

    const fakeJpeg = await route.POST(
      generationRequest({
        prompt: "캐릭터",
        imageDataUrl: `data:image/jpeg;base64,${Buffer.from("not-jpeg").toString("base64")}`,
      }),
    );
    assert.equal((await fakeJpeg.json()).code, "invalid_image");

    const unsupportedMime = await route.POST(
      generationRequest({
        prompt: "캐릭터",
        imageDataUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yw=",
      }),
    );
    assert.equal((await unsupportedMime.json()).code, "invalid_image");

    const tiny = await route.POST(
      generationRequest({ prompt: "캐릭터", imageDataUrl: pngDataUrl(1, 1) }),
    );
    assert.equal((await tiny.json()).code, "invalid_image");

    const decompressionBomb = await route.POST(
      generationRequest({
        prompt: "캐릭터",
        imageDataUrl: pngDataUrl(8192, 8192),
      }),
    );
    assert.equal((await decompressionBomb.json()).code, "invalid_image");

    const oversized = await route.POST(
      generationRequest(
        { prompt: "캐릭터", imageDataUrl: pngDataUrl() },
        { "Content-Length": String(12 * 1024 * 1024 + 1) },
      ),
    );
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).code, "request_too_large");
  });
});

test("rate limits, safety blocks, malformed output, and network failures are actionable", async () => {
  const route = await loadRoute("upstream-errors");
  const request = () =>
    generationRequest({ prompt: "캐릭터", imageDataUrl: pngDataUrl() });

  await withApiKey(TEST_API_KEY, async () => {
    const limited = await withFetch(
      async () => Response.json({ error: { message: "quota" } }, { status: 429 }),
      () => route.POST(request()),
    );
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), {
      error: "AI 이미지 생성 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
      code: "ai_rate_limited",
      retryable: true,
      upstreamStatus: 429,
    });

    const blocked = await withFetch(
      async () =>
        Response.json({ promptFeedback: { blockReason: "SAFETY" }, candidates: [] }),
      () => route.POST(request()),
    );
    assert.equal(blocked.status, 422);
    assert.equal((await blocked.json()).code, "ai_content_blocked");

    const malformed = await withFetch(
      async () => new Response("not-json", { status: 200 }),
      () => route.POST(request()),
    );
    assert.equal(malformed.status, 502);
    assert.equal((await malformed.json()).code, "ai_invalid_response");

    const network = await withFetch(
      async () => {
        throw new TypeError("simulated Worker network failure");
      },
      () => route.POST(request()),
    );
    assert.equal(network.status, 502);
    assert.deepEqual(await network.json(), {
      error: "AI 이미지 생성 서비스에 연결하지 못했습니다.",
      code: "ai_network_error",
      retryable: true,
    });
  });
});
