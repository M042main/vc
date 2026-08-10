import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const studioUrl = new URL("../app/components/VrmStudio.tsx", import.meta.url);
const paperDollUrl = new URL(
  "../app/components/PaperDollStage.tsx",
  import.meta.url,
);

async function renderHome() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("interaction-contract", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

function resolveNumber(source, token, label) {
  if (/^\d+(?:\.\d+)?$/.test(token)) return Number(token);

  const declaration = source.match(
    new RegExp(`\\b(?:const\\s+)?${token}\\s*=\\s*(\\d+(?:\\.\\d+)?)\\b`),
  );
  assert.ok(declaration, `${label} must resolve to a numeric source constant`);
  return Number(declaration[1]);
}

function numericSetting(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match, `${label} must be explicitly configured`);
  return resolveNumber(source, match[1], label);
}

test("removes the requested marketing intro from rendered HTML", async () => {
  const response = await renderHome();
  assert.equal(response.status, 200);

  const html = await response.text();
  for (const removedCopy of [
    "BROWSER-ONLY CHARACTER LAB",
    "몸을 움직이고,",
    "캐릭터를 남겨보세요.",
    "VRM을 올리거나 직접 그린 캐릭터를 보내면",
    "마음에 드는 순간, 전신만 투명 PNG로 저장하세요.",
  ]) {
    assert.equal(
      html.includes(removedCopy),
      false,
      `removed intro copy leaked into rendered HTML: ${removedCopy}`,
    );
  }
});

test("maps the OrbitControls middle mouse button to stage panning", async () => {
  const studioSource = await readFile(studioUrl, "utf8");

  assert.match(studioSource, /controls\.enablePan\s*=\s*true\s*;/);
  assert.doesNotMatch(studioSource, /controls\.enablePan\s*=\s*false\s*;/);
  assert.match(
    studioSource,
    /controls\.mouseButtons\.MIDDLE\s*=\s*THREE\.MOUSE\.PAN\s*;/,
    "middle-button drag must pan instead of dolly or rotate",
  );
});

test("pans the articulated 2D character with the middle mouse button", async () => {
  const source = await readFile(paperDollUrl, "utf8");

  assert.match(source, /manualPanRef/);
  assert.ok(
    /event\.button\s*===\s*1/.test(source) || /event\.button\s*!==\s*1/.test(source),
    "middle mouse must be recognized as the 2D pan gesture",
  );
  assert.match(source, /setPointerCapture\(event\.pointerId\)/);
  assert.match(source, /onPointerMove=\{movePan\}/);
  assert.match(source, /manualPanRef\.current\s*=\s*\{/);
});

test("keeps camera tracking bounded for responsive CPU fallback", async () => {
  const studioSource = await readFile(studioUrl, "utf8");

  const frameInterval = numericSetting(
    studioSource,
    /timestamp\s*-\s*lastFrameRef\.current\s*<\s*([A-Za-z_$][\w$]*|\d+(?:\.\d+)?)/,
    "minimum tracking frame interval",
  );
  const inputWidth = numericSetting(
    studioSource,
    /TRACKING_INPUT_MAX_WIDTH\s*=\s*([A-Za-z_$][\w$]*|\d+(?:\.\d+)?)/,
    "tracking input width",
  );
  const inputHeight = numericSetting(
    studioSource,
    /TRACKING_INPUT_MAX_HEIGHT\s*=\s*([A-Za-z_$][\w$]*|\d+(?:\.\d+)?)/,
    "tracking input height",
  );
  const cameraWidth = numericSetting(
    studioSource,
    /width\s*:\s*\{\s*ideal\s*:\s*([A-Za-z_$][\w$]*|\d+(?:\.\d+)?)/,
    "camera capture width",
  );
  const cameraHeight = numericSetting(
    studioSource,
    /height\s*:\s*\{\s*ideal\s*:\s*([A-Za-z_$][\w$]*|\d+(?:\.\d+)?)/,
    "camera capture height",
  );
  const cameraMaxFps = numericSetting(
    studioSource,
    /frameRate\s*:\s*\{[\s\S]{0,80}?max\s*:\s*([A-Za-z_$][\w$]*|\d+(?:\.\d+)?)/,
    "camera maximum frame rate",
  );
  const pixelRatioCap = numericSetting(
    studioSource,
    /setPixelRatio\(\s*Math\.min\(\s*window\.devicePixelRatio\s*,\s*([A-Za-z_$][\w$]*|\d+(?:\.\d+)?)\s*\)\s*\)/,
    "3D renderer pixel-ratio cap",
  );

  assert.ok(
    frameInterval >= 66,
    `tracking must be capped near 15 FPS or lower; got ${frameInterval} ms`,
  );
  assert.ok(inputWidth <= 480, `tracking width must be <= 480; got ${inputWidth}`);
  assert.ok(inputHeight <= 360, `tracking height must be <= 360; got ${inputHeight}`);
  assert.ok(cameraWidth <= 640, `camera width must be <= 640; got ${cameraWidth}`);
  assert.ok(cameraHeight <= 360, `camera height must be <= 360; got ${cameraHeight}`);
  assert.ok(cameraMaxFps <= 30, `camera FPS must be <= 30; got ${cameraMaxFps}`);
  assert.ok(pixelRatioCap <= 1.5, `renderer DPR cap must be <= 1.5; got ${pixelRatioCap}`);
  assert.match(studioSource, /resizeQuality\s*:\s*["']low["']/);
  assert.match(studioSource, /trackingInputDimensions\(cameraAspectRatioRef\.current\)/);
  assert.match(
    studioSource,
    /frameInFlightRef\.current[\s\S]{0,180}timestamp\s*-\s*lastFrameRef\.current/,
    "the scheduler must drop frames while one inference is in flight",
  );
  assert.match(
    studioSource,
    /postMessage\([\s\S]{0,180}\[bitmap\]/,
    "camera frames must transfer their ImageBitmap instead of cloning it",
  );

  assert.equal(
    studioSource.match(/<video\b[^>]*ref=\{videoRef\}/g)?.length ?? 0,
    1,
    "the camera preview and tracker must share exactly one camera video element",
  );
  assert.match(
    studioSource,
    /<video\b[^>]*ref=\{pipVideoRef\}[\s\S]{0,220}aria-hidden=["'{]true/,
    "the only auxiliary video must be the hidden browser-local PiP source",
  );
  assert.match(studioSource, /trackingSessionRef/);
  assert.match(studioSource, /workerRef\.current\s*!==\s*worker/);
});

test("skips hidden 3D work and caps its render loop near 30 FPS", async () => {
  const studioSource = await readFile(studioUrl, "utf8");
  const renderInterval = numericSetting(
    studioSource,
    /timestamp\s*-\s*lastRenderAt\s*<\s*([A-Za-z_$][\w$]*|\d+(?:\.\d+)?)/,
    "minimum 3D render interval",
  );

  assert.ok(renderInterval >= 33, `3D render interval must be >= 33 ms; got ${renderInterval}`);
  assert.match(studioSource, /document\.hidden/);
  assert.match(studioSource, /paperDollActiveRef\.current/);
  assert.match(studioSource, /stageVisibleRef\.current/);
  assert.match(studioSource, /new\s+IntersectionObserver\s*\(/);
});

test("rigs the drawing as articulated limb segments instead of one transformed image", async () => {
  const source = await readFile(paperDollUrl, "utf8");

  const trackedJoints = [
    [13, "left elbow"],
    [14, "right elbow"],
    [15, "left wrist"],
    [16, "right wrist"],
    [25, "left knee"],
    [26, "right knee"],
    [27, "left ankle"],
    [28, "right ankle"],
  ];
  for (const [index, label] of trackedJoints) {
    assert.ok(
      new RegExp(`landmarks\\?\\.\\[${index}\\]`).test(source),
      `paper-doll rig must read the ${label} landmark`,
    );
  }

  assert.ok(
    /\b(?:BODY_?PARTS|DOLL_?PARTS|PAPER_?DOLL_?RIG|RIG_?PARTS|LIMB_?SEGMENTS)\b/i.test(
      source,
    ),
    "the artwork must be described as a body-part rig",
  );
  assert.ok(
    /\b(?:draw|render)(?:Rigged)?(?:Part|Segment|Limb)\b/i.test(source),
    "each body part must be rendered through a segment-level transform",
  );
  assert.ok(
    !/context\.drawImage\(\s*image\s*,\s*-drawWidth\s*\/\s*2\s*,\s*-drawHeight\s*\/\s*2/.test(
      source,
    ),
    "the legacy whole-artwork transform must not return",
  );
  assert.match(source, /findOpaqueBounds\(scratch\)/);
  assert.match(source, /fittedScale/);
  assert.match(source, /createDollSprites\(image\)/);
  assert.match(source, /spritesRef\.current/);
  assert.match(
    source,
    /captureSafe\s*\?\s*width\s*\/\s*2/,
    "transparent export must ignore viewport pan before fitting the full body",
  );
});
