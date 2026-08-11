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

function blockFrom(source, marker, length = 3_500) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing source marker: ${marker}`);
  return source.slice(start, start + length);
}

test("keeps authoring and exported artwork transparent beyond the body guide", async () => {
  const source = await readFile(creatorUrl, "utf8");
  const stroke = blockFrom(source, "function drawStroke", 1_800);
  const preview = blockFrom(source, "const paintVisibleCanvas", 1_400);
  const exportArtwork = blockFrom(source, "const createExportDataUrl", 1_300);

  assert.doesNotMatch(
    stroke,
    /clip\s*\(\s*createSilhouettePath\s*\(\s*\)\s*\)/,
    "freehand strokes must not be clipped to the body silhouette",
  );
  assert.doesNotMatch(
    preview,
    /clip\s*\(\s*createSilhouettePath|fillStyle\s*=\s*["']#FFFCF5/,
    "preview must not add an opaque default body",
  );
  assert.match(
    preview,
    /drawWorkspace\(context\)[\s\S]{0,300}context\.drawImage\(drawingLayer[\s\S]{0,300}drawGuide\(context/,
    "checkerboard and guide must remain display-only layers around the artwork",
  );
  assert.doesNotMatch(
    exportArtwork,
    /clip\s*\(\s*createSilhouettePath|fillRect\s*\(/,
    "export must not bake in a body fill or guide background",
  );
  assert.match(exportArtwork, /context\.drawImage\(drawingLayer, 0, 0\)/);
  assert.match(source, /const\s+joints\s*=\s*\{[\s\S]{0,900}leftShoulder[\s\S]{0,900}rightAnkle/);
  assert.match(source, /for\s*\(const\s+\[from,\s*to\]\s+of\s+bones\)/);
  assert.match(source, /모든\s+가이드와 체크무늬는 결과물에 저장되지 않습니다/);
});

test("auto-binds every opaque outside pixel to a nearby animated body region", async () => {
  const source = await readFile(stageUrl, "utf8");
  const ownerMap = blockFrom(source, "function getArtworkOwnerMap", 3_000);
  const ownedSprites = blockFrom(source, "function createOwnedSprites", 4_500);
  const dollSprites = blockFrom(source, "function createDollSprites", 1_000);

  for (const owner of [
    "head",
    "leftArm",
    "rightArm",
    "leftLeg",
    "rightLeg",
    "torso",
  ]) {
    assert.match(source, new RegExp(`ARTWORK_OWNERS[\\s\\S]{0,300}["']${owner}["']`));
  }
  assert.match(ownerMap, /distanceToHead\s*\(/);
  assert.match(ownerMap, /distanceToPolygons\s*\(/);
  assert.match(ownerMap, /ownerMask\s*=\s*1\s*<<\s*bestOwnerIndex/);
  assert.match(
    ownerMap,
    /secondDistance\s*-\s*bestDistance\s*<=\s*OWNER_SEAM_BLEED_PX/,
    "neighboring body owners must overlap slightly to prevent joint cracks",
  );
  assert.match(ownedSprites, /source\.data\[pixel\s*\*\s*4\s*\+\s*3\]\s*===\s*0/);
  assert.match(ownedSprites, /ownerMap\[sourcePixel\]\s*&\s*\(1\s*<<\s*ownerIndex\)/);
  assert.match(dollSprites, /createOwnedSprites\s*\(image\)/);
  assert.match(dollSprites, /createLimbMesh\s*\(sprites\[owner\]/);
  assert.doesNotMatch(source, /createCombinedSprite\s*\(\s*image/);
});
