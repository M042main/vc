import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const paperDollUrl = new URL(
  "../app/components/PaperDollStage.tsx",
  import.meta.url,
);
const studioUrl = new URL("../app/components/VrmStudio.tsx", import.meta.url);
const creatorUrl = new URL(
  "../app/components/CharacterCreator.tsx",
  import.meta.url,
);
const pageUrl = new URL("../app/page.tsx", import.meta.url);

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function presetLiteralCount(source) {
  const sourceFile = ts.createSourceFile(
    "PaperDollStage.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let count = null;

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      /^(?:DOLL_MOTION_PRESETS|PRESET_ANIMATIONS)$/.test(node.name.text) &&
      node.initializer
    ) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isArrayLiteralExpression(initializer)) {
        count = initializer.elements.length;
      } else if (ts.isObjectLiteralExpression(initializer)) {
        count = initializer.properties.length;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return count;
}

test("defines at least three selectable paper-doll motion presets", async () => {
  const source = await readFile(paperDollUrl, "utf8");
  const count = presetLiteralCount(source);

  assert.notEqual(
    count,
    null,
    "PaperDollStage must declare DOLL_MOTION_PRESETS or PRESET_ANIMATIONS as a literal",
  );
  assert.ok(count >= 3, `paper-doll animation needs at least 3 presets; got ${count}`);
  assert.match(source, /\b(?:playPreset|playAnimation)\s*[:(]/);
  assert.match(source, /\b(?:pauseAnimation|pausePreset|stopAnimation)\s*[:(]/);
  assert.match(source, /\b(?:setAnimationSpeed|setPlaybackSpeed)\s*[:(]/);
  assert.match(
    source,
    /requestAnimationFrame\s*\(/,
    "preset playback must advance locally in the browser render loop",
  );
});

test("exposes preset selection, play-stop, and speed controls in the studio", async () => {
  const source = await readFile(studioUrl, "utf8");

  assert.ok(
    /\b(?:DOLL_MOTION_PRESETS|PRESET_ANIMATIONS)\b/.test(source),
    "studio must consume the paper-doll preset catalog",
  );
  assert.ok(
    /\b(?:selected|active)[A-Za-z]*(?:Preset|Motion)\b/i.test(source),
    "studio must keep the selected preset in state",
  );
  assert.ok(
    /paperDollRef\.current\?\.\s*(?:playPreset|playAnimation)\s*\(/.test(source),
    "studio must start the selected preset",
  );
  assert.ok(
    /paperDollRef\.current\?\.\s*(?:pauseAnimation|pausePreset|stopAnimation)\s*\(/.test(
      source,
    ),
    "studio must pause or stop preset playback",
  );
  assert.ok(
    /paperDollRef\.current\?\.\s*(?:setAnimationSpeed|setPlaybackSpeed)\s*\(/.test(
      source,
    ),
    "studio must forward the selected playback speed",
  );
  assert.ok(/재생/.test(source), "studio must render a play control");
  assert.ok(/(?:정지|일시정지)/.test(source), "studio must render a stop or pause control");
  assert.ok(/속도/.test(source), "studio must render a speed control");

  const hasSelect = /<select\b[\s\S]{0,1200}(?:DOLL_MOTION_PRESETS|PRESET_ANIMATIONS)/.test(
    source,
  );
  const hasPresetButtons =
    /(?:DOLL_MOTION_PRESETS|PRESET_ANIMATIONS)\s*\.map\([\s\S]{0,1200}<button\b/.test(
      source,
    );
  assert.ok(hasSelect || hasPresetButtons, "motion presets must be selectable in the UI");
});

test("feeds blink, mouth-open, and smile data into the 2D face renderer", async () => {
  const [paperDollSource, studioSource] = await Promise.all([
    readFile(paperDollUrl, "utf8"),
    readFile(studioUrl, "utf8"),
  ]);

  assert.ok(
    /\b(?:type|interface)\s+DollExpression\b/.test(paperDollSource),
    "PaperDollStage must define DollExpression",
  );
  for (const expression of ["blink", "mouthOpen", "smile"]) {
    assert.ok(
      new RegExp(`\\b${expression}\\??\\s*:\\s*number\\b`).test(paperDollSource),
      `DollExpression must include numeric ${expression} data`,
    );
    const uses = paperDollSource.match(new RegExp(`\\b${expression}\\b`, "g"))?.length ?? 0;
    assert.ok(uses >= 2, `${expression} must be consumed after it is declared`);
  }

  assert.ok(
    /\b(?:expressionRef|expression)\.current\b|\bexpressionRef\b/.test(paperDollSource),
    "PaperDollStage must retain current expression state",
  );
  assert.ok(
    /drawHead\([\s\S]{0,240}\bexpression\b/.test(paperDollSource),
    "the head renderer must receive the current expression",
  );
  assert.ok(
    /paperDollRef\.current\?\.\s*(?:applyPose|applyTracking)\([\s\S]{0,320}faceLandmarks/.test(
      studioSource,
    ),
    "camera face landmarks must reach the 2D paper-doll renderer",
  );
});

test("records and downloads a browser-local animation file", async () => {
  const source = await readFile(studioUrl, "utf8");

  assert.ok(/\.captureStream\s*\(/.test(source), "recording must use a local canvas stream");
  assert.ok(/new\s+MediaRecorder\s*\(/.test(source), "recording must use MediaRecorder");
  assert.ok(/\.ondataavailable\s*=/.test(source), "recorded chunks must be collected");
  assert.ok(/\.onstop\s*=/.test(source), "recording completion must create the download");
  assert.ok(/video\/webm|\.webm\b/i.test(source), "recording must produce a WebM file");
  assert.ok(/downloadBlob\s*\(/.test(source), "recording must download locally");
  assert.ok(
    /(?:애니메이션|동작)[^\n<]{0,24}(?:저장|녹화)/.test(source),
    "studio must expose an animation recording control",
  );
});

test("preserves live tracking and transparent PNG export without upload APIs", async () => {
  const [paperDollSource, studioSource, creatorSource, pageSource] = await Promise.all([
    readFile(paperDollUrl, "utf8"),
    readFile(studioUrl, "utf8"),
    readFile(creatorUrl, "utf8"),
    readFile(pageUrl, "utf8"),
  ]);

  assert.match(studioSource, /createHolisticTrackingWorker\s*\(/);
  assert.match(studioSource, /paperDollRef\.current\?\.(?:applyPose|applyTracking)\s*\(/);
  assert.match(paperDollSource, /capturePng\s*\(/);
  assert.match(studioSource, /paperDoll\.capturePng\(\s*1600\s*,\s*2000\s*\)/);
  assert.match(studioSource, /downloadBlob\s*\(/);
  assert.match(paperDollSource, /["']image\/png["']/);

  const browserOnlySource = [paperDollSource, studioSource, creatorSource, pageSource].join(
    "\n",
  );
  for (const [pattern, label] of [
    [/\bfetch\s*\(/, "fetch"],
    [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
    [/\bWebSocket\b/, "WebSocket"],
    [/\bEventSource\b/, "EventSource"],
    [/\bsendBeacon\s*\(/, "sendBeacon"],
    [/\bnew\s+FormData\s*\(/, "FormData upload"],
    [/["']\/api\//, "API route"],
    [/["']use server["']/, "server action"],
  ]) {
    assert.ok(
      !pattern.test(browserOnlySource),
      `${label} must not be introduced into the local character workflow`,
    );
  }
});
