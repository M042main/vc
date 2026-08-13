import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const overlayUrl = new URL(
  "../app/components/TrackingLandmarkOverlay.tsx",
  import.meta.url,
);
const workerUrl = new URL("../app/workers/holistic.worker.ts", import.meta.url);

async function sources() {
  return Promise.all([readFile(overlayUrl, "utf8"), readFile(workerUrl, "utf8")]);
}

test("keeps the complete MediaPipe face result and renders every supplied point", async () => {
  const [overlay, worker] = await sources();

  assert.match(
    worker,
    /type:\s*"RESULT"[\s\S]{0,180}result:\s*HolisticLandmarkerResult/u,
  );
  assert.match(worker, /reply\(\{[\s\S]{0,120}type:\s*"RESULT",[\s\S]{0,80}\bresult\b/u);
  assert.match(
    overlay,
    /for\s*\(const landmark of landmarks\)\s*drawPoint\(landmark\)/u,
  );
  assert.match(overlay, /A 478-landmark face therefore[\s\S]{0,100}all 478 points/u);
  assert.doesNotMatch(
    overlay,
    /faceLandmarks\s*\?*\.?\s*(?:slice|filter|map)\s*\(/u,
  );
});

test("draws dense semantic face contours including both five-point irises", async () => {
  const [overlay] = await sources();

  for (const region of [
    "FACE_OVAL_CONNECTIONS",
    "RIGHT_EYE_CONNECTIONS",
    "LEFT_EYE_CONNECTIONS",
    "RIGHT_EYEBROW_CONNECTIONS",
    "LEFT_EYEBROW_CONNECTIONS",
    "NOSE_CONNECTIONS",
    "UPPER_LIP_CONNECTIONS",
    "LOWER_LIP_CONNECTIONS",
    "MOUTH_OUTLINE_CONNECTIONS",
    "RIGHT_IRIS_CONNECTIONS",
    "LEFT_IRIS_CONNECTIONS",
  ]) {
    assert.match(
      overlay,
      new RegExp(`const\\s+${region}\\s*:`),
      `${region} must remain an explicit readable face layer`,
    );
  }

  assert.match(overlay, /469,\s*470,\s*471,\s*472,\s*469/u);
  assert.match(overlay, /474,\s*475,\s*476,\s*477,\s*474/u);
  assert.match(overlay, /const IRIS_CENTER_INDICES = \[468, 473\] as const/u);
  assert.match(overlay, /const FACE_SEMANTIC_LAYERS:[\s\S]{0,1800}IRIS_CONNECTIONS/u);
  assert.match(
    overlay,
    /drawLandmarkPoints\([\s\S]{0,180}IRIS_CENTER_INDICES[\s\S]{0,180}"#ffffff"/u,
  );
});

test("continues to render complete pose and both hand skeletons", async () => {
  const [overlay] = await sources();

  assert.match(overlay, /const POSE_CONNECTIONS:[\s\S]{0,900}\[28, 32\]/u);
  assert.match(overlay, /const HAND_CONNECTIONS:[\s\S]{0,700}\[19, 20\]/u);
  assert.match(
    overlay,
    /drawLandmarkList\([\s\S]{0,100}frame\.poseLandmarks[\s\S]{0,100}POSE_CONNECTIONS/u,
  );
  assert.match(
    overlay,
    /drawLandmarkList\([\s\S]{0,100}frame\.leftHandLandmarks[\s\S]{0,100}HAND_CONNECTIONS/u,
  );
  assert.match(
    overlay,
    /drawLandmarkList\([\s\S]{0,100}frame\.rightHandLandmarks[\s\S]{0,100}HAND_CONNECTIONS/u,
  );
});

test("preserves the 15fps coalescing and capped high-DPI canvas", async () => {
  const [overlay] = await sources();

  assert.match(overlay, /const MAX_DPR = 2/u);
  assert.match(overlay, /const FRAME_INTERVAL_MS = 1000 \/ 15/u);
  assert.match(
    overlay,
    /timeoutRef\.current !== null \|\| animationFrameRef\.current !== null/u,
  );
  assert.match(
    overlay,
    /frameRef\.current = \{ \.\.\.frameRef\.current, \.\.\.frame \}[\s\S]{0,80}scheduleDraw\(\)/u,
  );
  assert.match(
    overlay,
    /dpr:\s*Math\.min\(MAX_DPR,\s*Math\.max\(1,\s*window\.devicePixelRatio \|\| 1\)\)/u,
  );
});
