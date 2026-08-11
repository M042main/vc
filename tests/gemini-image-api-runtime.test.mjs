import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const routeUrl = new URL("../app/api/ai/generate/route.ts", import.meta.url);
const TEST_API_KEY = "test-only-gemini-key";
const TEST_CLASS_ID = "ABCDEFGHIJKLMNOPQRST";
const BROWSER_HEADERS = {
  Origin: "https://site.test",
  "Sec-Fetch-Site": "same-origin",
};

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

function generationRequest(payload, headers = {}, signal) {
  return new Request("https://site.test/api/ai/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...BROWSER_HEADERS,
      ...headers,
    },
    body: JSON.stringify({ classId: TEST_CLASS_ID, ...payload }),
    signal,
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

async function withFetch(mock, run, classRecord = { aiEnabled: true }) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (
      String(input).includes(
        `/motion_ink_gallery_a7f3c9/classes/${TEST_CLASS_ID}.json`,
      )
    ) {
      return Response.json(
        classRecord === null
          ? null
          : {
              name: "1학년 1반",
              createdAt: 1_800_000_000_000,
              ...classRecord,
            },
      );
    }
    return mock(input, init);
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test("Gemini key stays server-only and the route is Edge/Worker compatible", async () => {
  const source = await readFile(routeUrl, "utf8");

  assert.match(source, /process\.env\.GEMINI_API_KEY/);
  assert.match(source, /GALLERY_CLASSES_PATH[\s\S]{0,180}motion_ink_gallery_a7f3c9\/classes/u);
  assert.match(source, /validatedClassId\(payload\.classId\)/u);
  assert.match(source, /classAiAccess === "disabled"[\s\S]{0,180}ai_disabled_for_class/u);
  assert.match(source, /export const runtime = "edge"/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /CLASS_SETTINGS_TIMEOUT_MS\s*=\s*5_000/);
  assert.match(source, /REQUEST_TIMEOUT_MS\s*=\s*50_000/);
  assert.match(source, /sec-fetch-site/);
  assert.match(source, /cf-connecting-ip/);
  assert.match(source, /const rateLimitBuckets = new Map/);
  assert.match(source, /AUTHENTICATED_RATE_LIMIT\s*=\s*12/);
  assert.match(source, /MAX_CONCURRENT_UPSTREAM_REQUESTS\s*=\s*3/);
  assert.match(
    source,
    /while \(rateLimitBuckets\.size >= MAX_RATE_LIMIT_BUCKETS\)[\s\S]{0,220}rateLimitBuckets\.delete\(oldestKey\)/,
  );
  assert.match(
    source,
    /const retryAfter = reserveRateLimit\(request\)[\s\S]{0,900}const payload = await readRequestPayload\(request\)/,
  );
  assert.doesNotMatch(source, /request\.signal\.addEventListener/);
  assert.doesNotMatch(source, /request\.signal\.removeEventListener/);
  assert.doesNotMatch(source, /AIza[0-9A-Za-z_-]{20,}/);
  assert.doesNotMatch(source, /Buffer|node:/);
});

test("cross-site browser requests are rejected and warm-isolate bursts are bounded", async () => {
  const route = await loadRoute("abuse-guards");
  let calls = 0;

  await withApiKey(TEST_API_KEY, async () => {
    const missingBrowserMetadata = await withFetch(async () => {
      calls += 1;
      return imageResponse();
    }, () =>
      route.POST(
        new Request("https://site.test/api/ai/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: "캐릭터",
            imageDataUrl: pngDataUrl(),
          }),
        }),
      ),
    );
    assert.equal(missingBrowserMetadata.status, 403);
    assert.equal((await missingBrowserMetadata.json()).code, "request_origin_denied");

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
      for (let index = 0; index < 12; index += 1) {
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
        new Request("https://site.test/api/ai/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...BROWSER_HEADERS,
            "oai-authenticated-user-id": "test-user",
          },
          body: "{this would be invalid JSON without the earlier reservation}",
        }),
      );
      assert.equal(limited.status, 429);
      assert.equal((await limited.json()).code, "ai_rate_limited");
      assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    });
  });

  assert.equal(calls, 12);
});

test("allows three concurrent upstream requests but rejects a fourth", async () => {
  const route = await loadRoute("upstream-concurrency");
  const pendingResolvers = [];
  let holdResponses = true;
  let calls = 0;

  await withApiKey(TEST_API_KEY, () =>
    withFetch(async (_input, init) => {
      calls += 1;
      assert.ok(init.signal instanceof AbortSignal);
      if (!holdResponses) return imageResponse();
      return new Promise((resolve) => pendingResolvers.push(resolve));
    }, async () => {
      const responsePromises = Array.from({ length: 4 }, () =>
        route.POST(
          generationRequest(
            { prompt: "캐릭터", imageDataUrl: pngDataUrl() },
            { "oai-authenticated-user-id": "concurrent-user" },
          ),
        ),
      );

      await waitUntil(
        () => pendingResolvers.length === 3,
        "three upstream requests should reserve all available slots",
      );
      const earlyResponse = await Promise.race(responsePromises);
      assert.equal(earlyResponse.status, 429);
      assert.equal((await earlyResponse.json()).code, "ai_rate_limited");

      pendingResolvers.splice(0).forEach((resolve) => resolve(imageResponse()));
      const responses = await Promise.all(responsePromises);
      assert.deepEqual(
        responses.map((response) => response.status).sort((left, right) => left - right),
        [200, 200, 200, 429],
      );
      assert.equal(calls, 3);

      holdResponses = false;
      const afterRelease = await route.POST(
        generationRequest(
          { prompt: "캐릭터", imageDataUrl: pngDataUrl() },
          { "oai-authenticated-user-id": "concurrent-user" },
        ),
      );
      assert.equal(afterRelease.status, 200);
      assert.equal(calls, 4, "completed responses must release their slot");
    }),
  );
});

test("uses an independent timeout signal instead of the Sites request signal", async () => {
  const route = await loadRoute("independent-timeout-signal");
  const clientController = new AbortController();
  let upstreamSignal;
  let resolveUpstream;
  let holdResponse = true;
  let calls = 0;

  await withApiKey(TEST_API_KEY, () =>
    withFetch(async (_input, init) => {
      calls += 1;
      upstreamSignal = init.signal;
      if (!holdResponse) return imageResponse();
      return new Promise((resolve) => {
        resolveUpstream = resolve;
      });
    }, async () => {
      const responsePromise = route.POST(
        generationRequest(
          { prompt: "캐릭터", imageDataUrl: pngDataUrl() },
          { "oai-authenticated-user-id": "adapter-signal-user" },
          clientController.signal,
        ),
      );
      await waitUntil(
        () => typeof resolveUpstream === "function",
        "the upstream request should start",
      );

      clientController.abort();
      assert.ok(upstreamSignal instanceof AbortSignal);
      assert.equal(
        upstreamSignal.aborted,
        false,
        "the Sites adapter signal must not immediately abort Gemini",
      );

      holdResponse = false;
      resolveUpstream(imageResponse());
      const response = await responsePromise;
      assert.equal(response.status, 200);

      const afterRelease = await route.POST(
        generationRequest(
          { prompt: "캐릭터", imageDataUrl: pngDataUrl() },
          { "oai-authenticated-user-id": "adapter-signal-user" },
        ),
      );
      assert.equal(afterRelease.status, 200);
      assert.equal(calls, 2, "the completed request must release its upstream slot");
    }),
  );
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
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent",
      );
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "follow");
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

test("rejects disabled or missing classes before contacting Gemini", async () => {
  const route = await loadRoute("class-ai-access");
  let geminiCalls = 0;
  const makeRequest = () =>
    route.POST(
      generationRequest({ prompt: "교실에서 손을 흔들기", imageDataUrl: pngDataUrl() }),
    );

  await withApiKey(TEST_API_KEY, async () => {
    const disabled = await withFetch(
      async () => {
        geminiCalls += 1;
        return imageResponse();
      },
      makeRequest,
      { aiEnabled: false },
    );
    assert.equal(disabled.status, 403);
    assert.equal((await disabled.json()).code, "ai_disabled_for_class");

    const missing = await withFetch(
      async () => {
        geminiCalls += 1;
        return imageResponse();
      },
      makeRequest,
      null,
    );
    assert.equal(missing.status, 503);
    assert.equal((await missing.json()).code, "ai_unavailable");

    const malformed = await withFetch(
      async () => {
        geminiCalls += 1;
        return imageResponse();
      },
      makeRequest,
      { aiEnabled: "false" },
    );
    assert.equal(malformed.status, 403);
    assert.equal((await malformed.json()).code, "ai_disabled_for_class");

    const incomplete = await withFetch(
      async () => {
        geminiCalls += 1;
        return imageResponse();
      },
      makeRequest,
      { name: "", aiEnabled: true },
    );
    assert.equal(incomplete.status, 503);
    assert.equal((await incomplete.json()).code, "ai_unavailable");

    const invalid = await route.POST(
      generationRequest(
        { classId: "not-a-class", prompt: "교실", imageDataUrl: pngDataUrl() },
      ),
    );
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, "invalid_class");
  });
  assert.equal(geminiCalls, 0);
});

test("keeps legacy complete classes without an AI flag enabled", async () => {
  const route = await loadRoute("legacy-class-ai-access");
  const response = await withApiKey(TEST_API_KEY, () =>
    withFetch(
      async () => imageResponse(),
      () =>
        route.POST(
          generationRequest({ prompt: "교실에서 웃기", imageDataUrl: pngDataUrl() }),
        ),
      {},
    ),
  );

  assert.equal(response.status, 200);
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
        headers: { "Content-Type": "application/json", ...BROWSER_HEADERS },
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
        { "Content-Length": String(Math.floor(5.75 * 1024 * 1024) + 1) },
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

    const logged = [];
    const originalConsoleError = console.error;
    console.error = (...values) => logged.push(JSON.stringify(values));
    let network;
    try {
      network = await withFetch(
        async () => {
          throw new TypeError(
            `simulated Worker network failure ${TEST_API_KEY}`,
          );
        },
        () => route.POST(request()),
      );
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(network.status, 502);
    assert.deepEqual(await network.json(), {
      error: "AI 이미지 생성 서비스에 연결하지 못했습니다.",
      code: "ai_network_error",
      retryable: true,
    });
    assert.equal(logged.length, 1);
    assert.doesNotMatch(logged[0], new RegExp(TEST_API_KEY, "u"));
    assert.match(logged[0], /\[redacted\]/u);
  });
});
