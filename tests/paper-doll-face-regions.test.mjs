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
const creatorCssUrl = new URL(
  "../app/components/CharacterCreator.module.css",
  import.meta.url,
);

function blockFrom(source, marker, length = 4_000) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing source marker: ${marker}`);
  return source.slice(start, start + length);
}

test("shows a detailed non-exported face guide on the transparent creator canvas", async () => {
  const source = await readFile(creatorUrl, "utf8");
  const guide = blockFrom(source, "function drawGuide", 6_500);
  const exportArtwork = blockFrom(source, "const createExportDataUrl", 1_100);

  assert.match(guide, /Facial landmarks are display-only drawing anchors/);
  assert.match(guide, /Left\/right brows/);
  assert.match(guide, /Left\/right eyes/);
  assert.match(guide, /Nose bridge, tip, and left\/right wings/);
  assert.match(guide, /Upper lip, lower lip, and both corners/);
  assert.match(guide, /context\.moveTo\(255, 111\)/);
  assert.match(guide, /context\.moveTo\(315, 111\)/);
  assert.match(guide, /context\.moveTo\(300, 116\)/);
  assert.match(guide, /context\.moveTo\(288, 139\)/);
  assert.match(guide, /context\.moveTo\(275, 152\)/);
  assert.match(guide, /const semanticAnchors/);
  assert.match(guide, /joint === joints\.head\) continue/);
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

test("drives independent eye, brow, nose, lip, mouth-corner, and jaw regions from landmarks", async () => {
  const source = await readFile(stageUrl, "utf8");
  const landmarkSolver = blockFrom(source, "function expressionFromFaceLandmarks", 10_500);
  const warp = blockFrom(source, "function warpFacialPoint", 6_500);

  const solvedFields = [
    "blinkLeft",
    "blinkRight",
    "browUpLeft",
    "browUpRight",
    "mouthOpen",
    "smile",
    "jawOpen",
    "lookXLeft",
    "lookYLeft",
    "lookXRight",
    "lookYRight",
    "noseBridgeShiftX",
    "noseBridgeShiftY",
    "noseTipShiftX",
    "noseTipShiftY",
    "nostrilLeftFlare",
    "nostrilRightFlare",
    "upperLipLift",
    "lowerLipDrop",
    "mouthCornerLeftLift",
    "mouthCornerRightLift",
  ];
  for (const field of solvedFields) {
    assert.match(source, new RegExp(`\\b${field}\\s*:\\s*number\\b`));
    assert.match(landmarkSolver, new RegExp(`\\b${field}\\b`));
  }
  for (const field of solvedFields.filter(
    (field) => !["mouthOpen", "smile"].includes(field),
  )) {
    assert.match(warp, new RegExp(`expression\\.${field}\\b`));
  }
  assert.match(landmarkSolver, /landmarkDistance\(landmarks, 14, 152\)/);
  assert.match(landmarkSolver, /landmarks\[61\]/);
  assert.match(landmarkSolver, /landmarks\[291\]/);
  assert.match(landmarkSolver, /solveEyeLook\(468, 33, 133, 159, 145\)/);
  assert.match(landmarkSolver, /solveEyeLook\(473, 362, 263, 386, 374\)/);
  assert.match(landmarkSolver, /landmarks\[168\]/);
  assert.match(landmarkSolver, /landmarks\[1\]/);
  assert.match(landmarkSolver, /landmarks\[98\]/);
  assert.match(landmarkSolver, /landmarks\[327\]/);
  assert.match(warp, /regionInfluence\(source, centerX, 111/);
  assert.match(warp, /applyEye\(270, expression\.blinkLeft, expression\.lookXLeft, expression\.lookYLeft\)/);
  assert.match(warp, /applyEye\(330, expression\.blinkRight, expression\.lookXRight, expression\.lookYRight\)/);
  assert.match(warp, /regionInfluence\(source, 300, 126/);
  assert.match(warp, /regionInfluence\(source, 300, 139/);
  assert.match(warp, /regionInfluence\(source, 289, 139/);
  assert.match(warp, /regionInfluence\(source, 311, 139/);
  assert.match(warp, /regionInfluence\(source, 300, 148/);
  assert.match(warp, /regionInfluence\(source, 300, 158/);
  assert.match(warp, /regionInfluence\(source, 275, 152/);
  assert.match(warp, /regionInfluence\(source, 325, 152/);
  assert.match(warp, /regionInfluence\(source, 300, 169/);
});

test("keeps only the Studio save action at the bottom of the front-only tool panel", async () => {
  const [source, css] = await Promise.all([
    readFile(creatorUrl, "utf8"),
    readFile(creatorCssUrl, "utf8"),
  ]);
  const asideStart = source.indexOf("<aside");
  const actionsStart = source.indexOf("className={styles.panelActions}");
  const asideEnd = source.indexOf("</aside>", asideStart);
  const stageStart = source.indexOf("className={styles.stageColumn}");

  assert.doesNotMatch(source, /CHARACTER MAKER|내 손으로 만드는 캐릭터|styles\.heading|styles\.eyebrow/);
  assert.match(source, /<section className=\{styles\.creator\} aria-label="캐릭터 만들기">/);
  assert.match(source, /id="character-face-guide-help"/);
  assert.match(source, /"character-face-guide-help character-canvas-help"/);
  assert.ok(asideStart >= 0 && actionsStart > asideStart && actionsStart < asideEnd);
  assert.ok(stageStart > asideEnd, "save actions must not remain in the right stage column");
  assert.doesNotMatch(source, /현재 면 PNG 저장|downloadPng|styles\.downloadButton/u);
  assert.doesNotMatch(source, /보이는 면|캐릭터 면 선택|styles\.segmented|styles\.sideBadge/u);
  assert.match(source, /const EDITOR_SIDE = "front" as const/u);
  assert.match(source, /const dataUrl = createExportDataUrl\(\);/u);
  assert.equal(source.match(/저장하고 스튜디오로/g)?.length, 1);
  assert.match(css, /\.panelActions\s*\{[\s\S]{0,180}margin-top:\s*auto/);
  assert.doesNotMatch(css, /\.(?:segmented|segmentActive|sideBadge|downloadButton)\b/u);
  assert.match(css, /@media\s*\(max-width:\s*720px\)[\s\S]{0,700}\.panelActions\s*\{[\s\S]{0,160}grid-template-columns:\s*minmax\(0,\s*1fr\)/);
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
