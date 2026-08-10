import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const studioUrl = new URL("../app/components/VrmStudio.tsx", import.meta.url);
const paperDollUrl = new URL(
  "../app/components/PaperDollStage.tsx",
  import.meta.url,
);
const studioCssUrl = new URL(
  "../app/components/VrmStudio.module.css",
  import.meta.url,
);

function blockFrom(source, marker, length = 6_000) {
  const index = source.indexOf(marker);
  assert.notEqual(index, -1, `missing source marker: ${marker}`);
  return source.slice(index, index + length);
}

function cssMinHeight(source, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rules = [
    ...source.matchAll(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "g")),
  ];
  assert.ok(rules.length > 0, `missing CSS rule for ${selector}`);
  const values = rules
    .map((rule) => rule[1].match(/min-height\s*:\s*(\d+)px/))
    .filter(Boolean)
    .map((value) => Number(value[1]));
  assert.ok(values.length > 0, `${selector} must declare a pixel min-height`);
  return values.at(-1);
}

test("owns and cancels MediaRecorder resources when the studio unmounts", async () => {
  const source = await readFile(studioUrl, "utf8");

  const hasSeparateResourceRefs =
    /const\s+\w*(?:Recorder|Recording)\w*Ref\s*=\s*useRef<MediaRecorder\s*\|\s*null>/.test(
      source,
    ) &&
    /const\s+\w*Recording\w*Stream\w*Ref\s*=\s*useRef<MediaStream\s*\|\s*null>/i.test(
      source,
    ) &&
    /const\s+\w*Recording\w*(?:Timer|Timeout)\w*Ref\s*=\s*useRef</i.test(source);
  const hasAggregateResourceRef =
    /const\s+activeRecordingRef\s*=\s*useRef<\{[\s\S]{0,500}recorder\s*:\s*MediaRecorder[\s\S]{0,200}stream\s*:\s*MediaStream[\s\S]{0,200}timer\s*:\s*number/.test(
      source,
    );
  assert.ok(
    hasSeparateResourceRefs || hasAggregateResourceRef,
    "the active recorder, stream, and timer must be owned across renders",
  );

  const cleanupMarker = source.includes("const cancelRecording")
    ? "const cancelRecording"
    : "const stopRecording";
  const cleanup = blockFrom(source, cleanupMarker, 3_000);
  assert.ok(/clearTimeout\s*\(/.test(cleanup), "recording cleanup must clear its timer");
  assert.ok(/\.stop\s*\(\s*\)/.test(cleanup), "recording cleanup must stop the recorder");
  assert.ok(
    /\.getTracks\s*\(\s*\)\.forEach\([\s\S]{0,160}\.stop\s*\(/.test(cleanup),
    "recording cleanup must stop every canvas-stream track",
  );
  assert.ok(
    /return\s*\(\s*\)\s*=>\s*\{[\s\S]{0,900}(?:stopRecording|cancelRecording)\s*\(/.test(
      source,
    ),
    "component teardown must invoke recording cleanup",
  );
});

test("serializes camera startup and preset recording modes", async () => {
  const source = await readFile(studioUrl, "utf8");
  const cameraButton = blockFrom(
    source,
    "onClick={trackingRunning ? stopTracking : startTracking}",
    500,
  );
  assert.ok(/disabled=\{[^}]*isRecording/.test(cameraButton), "camera start must be disabled while recording");

  assert.ok(
    /const\s+startTracking[\s\S]{0,500}if\s*\(\s*isRecording\s*\)/.test(source),
    "camera startup must also guard recording in its handler",
  );
  assert.ok(
    (source.match(/disabled=\{isRecording\s*\|\|\s*trackingState\s*===\s*["']loading["']\}/g)
      ?.length ?? 0) >= 3,
    "preset, playback, and recording controls must be disabled during camera startup",
  );
  assert.ok(
    (source.match(/if\s*\(\s*trackingState\s*!==\s*["']idle["']\s*\)\s*stopTracking\s*\(\s*\)/g)
      ?.length ?? 0) >= 3,
    "preset playback and recording must cancel every non-idle camera session",
  );
});

test("claims a recording session before awaiting PiP and blocks competing workflows", async () => {
  const source = await readFile(studioUrl, "utf8");
  const recording = blockFrom(source, "const recordAnimation", 4_500);
  const busyIndex = recording.indexOf("recordingBusyRef.current = true");
  const sessionIndex = recording.indexOf("++recordingSessionRef.current");
  const pipAwaitIndex = recording.indexOf("await exitStagePictureInPicture()");

  assert.ok(busyIndex >= 0, "recording must synchronously claim an in-flight lock");
  assert.ok(sessionIndex >= 0, "recording must create a cancellable session token");
  assert.ok(pipAwaitIndex >= 0, "recording must close PiP before capturing the stage");
  assert.ok(
    busyIndex < pipAwaitIndex && sessionIndex < pipAwaitIndex,
    "the recording lock and session must be established before the first PiP await",
  );
  assert.match(
    recording,
    /await\s+exitStagePictureInPicture\s*\(\s*\)[\s\S]{0,220}recordingSessionRef\.current\s*!==\s*session/,
    "an unmount or cancellation during PiP exit must stop recording startup",
  );

  const cancelRecording = blockFrom(source, "const cancelRecording", 1_000);
  assert.match(
    cancelRecording,
    /recordingSessionRef\.current\s*\+=\s*1[\s\S]{0,120}recordingBusyRef\.current\s*=\s*false/,
    "recording cleanup must invalidate pending startup and release its lock",
  );

  for (const [marker, label] of [
    ["const startTracking", "camera startup"],
    ["const handleModelFile", "VRM replacement"],
    ["const enterStagePictureInPicture", "PiP entry"],
  ]) {
    const handler = blockFrom(source, marker, 1_500);
    assert.match(
      handler,
      /if\s*\(\s*recordingBusyRef\.current\s*\)\s*(?:return|\{)/,
      `${label} must reject a recording that is pending before MediaRecorder activation`,
    );
  }
});

test("does not label an unsupported recorder format as WebM", async () => {
  const source = await readFile(studioUrl, "utf8");
  const recording = blockFrom(source, "const recordAnimation", 7_000);

  assert.ok(
    /if\s*\(\s*!mimeType\s*\)\s*\{[\s\S]{0,500}(?:throw\s+new\s+Error|return\s*;)/.test(
      recording,
    ),
    "recording must fail clearly when VP9, VP8, and generic WebM are unsupported",
  );
  assert.ok(
    !/type\s*:\s*mimeType\s*\?\?\s*["']video\/webm["']/.test(recording),
    "non-WebM chunks must never be force-labelled video/webm",
  );
});

test("restores recording UI state after failures before recorder activation", async () => {
  const source = await readFile(studioUrl, "utf8");
  const recording = blockFrom(source, "const recordAnimation", 9_000);
  const cleanup = blockFrom(recording, "finally", 2_000);

  const currentSessionCleanup = blockFrom(
    cleanup,
    "if (recordingSessionRef.current === session)",
    900,
  );
  assert.match(
    currentSessionCleanup,
    /paperDoll\??\.pauseAnimation\s*\(\s*\)/,
    "paper-doll recording failure must pause its preset",
  );
  assert.match(
    currentSessionCleanup,
    /(?:vrmMotion\??\.pause|stopVrmAnimation)\s*\(\s*\)/,
    "VRM recording failure must stop or restore its preset",
  );
  assert.match(
    currentSessionCleanup,
    /setAnimationPlaying\s*\(\s*false\s*\)[\s\S]{0,300}setIsRecording\s*\(\s*false\s*\)/,
    "every current-session failure must leave recording mode",
  );
});

test("keeps the 2D animation lab operable on touch and assistive technology", async () => {
  const [paperDollSource, studioSource, cssSource] = await Promise.all([
    readFile(paperDollUrl, "utf8"),
    readFile(studioUrl, "utf8"),
    readFile(studioCssUrl, "utf8"),
  ]);

  const panHandler = blockFrom(paperDollSource, "const beginPan", 900);
  assert.ok(
    !/pointerType\s*!==\s*["']mouse["']/.test(panHandler),
    "touch pointers must not be discarded while the canvas has touch-action: none",
  );
  assert.ok(/pointerType\s*===\s*["']touch["']/.test(panHandler), "touch drag must have an explicit pan path");
  assert.ok(
    /aria-pressed=\{selectedMotion\s*===\s*preset\.id\}/.test(studioSource),
    "screen readers must receive the selected preset state",
  );

  assert.ok(
    cssMinHeight(cssSource, ".motionGrid button") >= 44,
    "preset touch targets must be at least 44px high",
  );
  assert.ok(
    cssMinHeight(cssSource, ".playButton,\n.recordButton") >= 44,
    "play and record touch targets must be at least 44px high",
  );
  assert.ok(
    cssMinHeight(cssSource, ".speedControl") >= 44,
    "speed control touch target must be at least 44px high",
  );
});
