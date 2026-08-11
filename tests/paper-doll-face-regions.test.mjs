import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const creatorUrl = new URL(
  "../app/components/CharacterCreator.tsx",
  import.meta.url,
);
const stageUrl = new URL(
  "../app/components/PaperDollStage.tsx",
  import.meta.url,
);

function blockFrom(source, marker, length = 4_000) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing source marker: ${marker}`);
  return source.slice(start, start + length);
}

test("shows a detailed non-exported face guide on the transparent creator canvas", async () => {
  const source = await readFile(creatorUrl, "utf8");
  const guide = blockFrom(source, "function drawGuide", 4_200);
  const exportArtwork = blockFrom(source, "const createExportDataUrl", 1_100);

  assert.match(guide, /Facial landmarks are display-only drawing anchors/);
  assert.match(guide, /context\.ellipse\(270, 111, 14, 7/);
  assert.match(guide, /context\.ellipse\(330, 111, 14, 7/);
  assert.match(guide, /context\.moveTo\(255, 91\)/);
  assert.match(guide, /context\.moveTo\(300, 113\)/);
  assert.match(guide, /context\.moveTo\(276, 151\)/);
  assert.match(guide, /context\.quadraticCurveTo\(300, 201, 337, 176\)/);
  assert.doesNotMatch(exportArtwork, /drawGuide\s*\(/);
  assert.doesNotMatch(exportArtwork, /drawWorkspace\s*\(/);
});

test("isolates a dense facial mesh while keeping hair and outer head pixels rigid", async () => {
  const source = await readFile(stageUrl, "utf8");
  const split = blockFrom(source, "function createFacialSprites", 3_200);
  const renderer = blockFrom(source, "function drawHead", 1_400);

  assert.match(split, /baseContext\.drawImage\(head\.canvas/);
  assert.match(split, /faceContext\.drawImage\(/);
  assert.match(split, /baseContext\.clearRect\(sourceX, sourceY, faceWidth, faceHeight\)/);
  assert.match(source, /headBase:\s*head\.base/);
  assert.match(source, /face:\s*head\.face/);
  assert.match(renderer, /context\.drawImage\(base\.canvas, base\.x, base\.y\)/);
  assert.match(renderer, /drawFacialFeatures\(context, face, expression\)/);
  assert.doesNotMatch(renderer, /sprite\.canvas\.width\s*\/\s*24/);
});

test("drives separate eye, brow, mouth, smile, and jaw regions from face landmarks", async () => {
  const source = await readFile(stageUrl, "utf8");
  const landmarkSolver = blockFrom(source, "function expressionFromFaceLandmarks", 4_500);
  const warp = blockFrom(source, "function warpFacialPoint", 3_500);

  for (const field of [
    "blinkLeft",
    "blinkRight",
    "browUpLeft",
    "browUpRight",
    "mouthOpen",
    "smile",
    "jawOpen",
  ]) {
    assert.match(source, new RegExp(`\\b${field}\\s*:\\s*number\\b`));
    assert.match(landmarkSolver, new RegExp(`\\b${field}\\b`));
    assert.match(warp, new RegExp(`expression\\.${field}\\b`));
  }
  assert.match(landmarkSolver, /landmarkDistance\(landmarks, 14, 152\)/);
  assert.match(landmarkSolver, /landmarks\[61\]/);
  assert.match(landmarkSolver, /landmarks\[291\]/);
  assert.match(warp, /regionInfluence\(source, centerX, 111/);
  assert.match(warp, /applyEye\(270, expression\.blinkLeft\)/);
  assert.match(warp, /applyEye\(330, expression\.blinkRight\)/);
  assert.match(warp, /regionInfluence\(source, 300, 152/);
  assert.match(warp, /regionInfluence\(source, 300, 169/);
});

test("composites an optional live background but omits it from transparent capture", async () => {
  const source = await readFile(stageUrl, "utf8");
  const drawTo = blockFrom(source, "const drawTo = useCallback", 4_500);
  const capture = blockFrom(source, "async capturePng", 1_500);

  assert.match(source, /backgroundImage\?:\s*CanvasImageSource\s*\|\s*null/);
  assert.match(source, /backgroundFit\?:\s*"cover"\s*\|\s*"contain"/);
  assert.match(drawTo, /if\s*\(!captureSafe\)/);
  assert.match(drawTo, /drawFittedBackground\(/);
  assert.ok(
    drawTo.indexOf("drawFittedBackground(") < drawTo.indexOf("drawLimb(context"),
    "live background must render before character artwork",
  );
  assert.match(capture, /drawTo\(scratch, width, height, "high", true\)/);
});
