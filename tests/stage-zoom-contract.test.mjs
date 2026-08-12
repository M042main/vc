import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const studioUrl = new URL("../app/components/VrmStudio.tsx", import.meta.url);
const paperDollUrl = new URL(
  "../app/components/PaperDollStage.tsx",
  import.meta.url,
);
const zoomUrl = new URL("../app/lib/stageZoom.ts", import.meta.url);

function numericConstant(source, name) {
  const match = source.match(
    new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(\\d+(?:\\.\\d+)?)`),
  );
  assert.ok(match, `${name} must be an explicit numeric constant`);
  return Number(match[1]);
}

test("gives the 3D tracking stage an effectively unbounded safe zoom range", async () => {
  const [studio, zoom] = await Promise.all([
    readFile(studioUrl, "utf8"),
    readFile(zoomUrl, "utf8"),
  ]);
  const minimum = numericConstant(zoom, "STAGE_CAMERA_MIN_DISTANCE");
  const maximum = numericConstant(zoom, "STAGE_CAMERA_MAX_DISTANCE");
  const nearPlane = numericConstant(zoom, "STAGE_CAMERA_NEAR_PLANE");
  const farPlane = numericConstant(zoom, "STAGE_CAMERA_FAR_PLANE");

  assert.ok(minimum > 0 && minimum <= 0.02);
  assert.ok(maximum >= 100 && Number.isFinite(maximum));
  assert.ok(maximum / minimum >= 5_000);
  assert.ok(nearPlane > 0 && nearPlane < minimum);
  assert.ok(farPlane >= maximum * 10, "the far plane must not clip maximum zoom-out");
  assert.match(studio, /controls\.minDistance\s*=\s*STAGE_CAMERA_MIN_DISTANCE/);
  assert.match(studio, /controls\.maxDistance\s*=\s*STAGE_CAMERA_MAX_DISTANCE/);
  assert.doesNotMatch(studio, /controls\.minDistance\s*=\s*1\s*;/);
  assert.doesNotMatch(studio, /controls\.maxDistance\s*=\s*8\s*;/);
  assert.match(
    studio,
    /new THREE\.PerspectiveCamera\([\s\S]{0,100}STAGE_CAMERA_NEAR_PLANE,[\s\S]{0,60}STAGE_CAMERA_FAR_PLANE/,
  );
  assert.match(
    studio,
    /camera\.far\s*=\s*Math\.max\(STAGE_CAMERA_FAR_PLANE,\s*distance\s*\*\s*20\)/,
  );
});

test("zooms the 2D character with wheel and keeps transparent capture fitted", async () => {
  const [paperDoll, zoom] = await Promise.all([
    readFile(paperDollUrl, "utf8"),
    readFile(zoomUrl, "utf8"),
  ]);
  const minimum = numericConstant(zoom, "STAGE_ZOOM_MIN");
  const maximum = numericConstant(zoom, "STAGE_ZOOM_MAX");

  assert.ok(minimum > 0 && minimum <= 0.02);
  assert.ok(maximum >= 100 && Number.isFinite(maximum));
  assert.match(zoom, /Number\.isFinite/);
  assert.match(zoom, /Math\.exp\(-delta\s*\*\s*WHEEL_ZOOM_SENSITIVITY\)/);
  assert.match(paperDoll, /manualZoomRef\s*=\s*useRef\(1\)/);
  assert.doesNotMatch(paperDoll, /onWheel=/);
  assert.match(
    paperDoll,
    /addEventListener\(\s*["']wheel["'],\s*zoomWithWheel,\s*\{\s*passive:\s*false\s*\}\s*\)/,
    "wheel zoom must use a non-passive native listener so it can stop page scrolling",
  );
  assert.match(
    paperDoll,
    /removeEventListener\(\s*["']wheel["'],\s*zoomWithWheel\s*\)/,
  );
  assert.match(paperDoll, /event\.preventDefault\(\)/);
  assert.match(paperDoll, /touchPointersRef\s*=\s*useRef\(new Map/);
  assert.match(paperDoll, /pinch\.startZoom\s*\*\s*\(distance\s*\/\s*pinch\.startDistance\)/);
  assert.match(paperDoll, /clampStageZoom\(/);
  assert.match(
    paperDoll,
    /captureSafe\s*\?\s*1\s*:\s*pose\.scale\s*\*\s*manualZoomRef\.current/,
    "viewport zoom must not crop or change full-body PNG capture",
  );
  assert.match(paperDoll, /manualZoomRef\.current\s*=\s*1/);
});

test("offers keyboard-operable zoom buttons for both 2D and 3D stages", async () => {
  const [studio, paperDoll, zoom] = await Promise.all([
    readFile(studioUrl, "utf8"),
    readFile(paperDollUrl, "utf8"),
    readFile(zoomUrl, "utf8"),
  ]);

  assert.match(paperDoll, /zoom:\s*\(direction:\s*-1\s*\|\s*1\)\s*=>\s*void/);
  assert.match(paperDoll, /zoom\(direction\)\s*\{[\s\S]{0,180}stepStageZoom/);
  assert.match(zoom, /export function stepStageZoom/);
  assert.match(studio, /paperDollRef\.current\?\.zoom\(direction\)/);
  assert.match(studio, /controls\.dollyIn\(dollyScale\)/);
  assert.match(studio, /controls\.dollyOut\(dollyScale\)/);

  for (const [direction, label] of [
    [-1, "캐릭터 화면 축소"],
    [1, "캐릭터 화면 확대"],
  ]) {
    const button = new RegExp(
      `<button[\\s\\S]{0,180}?type=["']button["'][\\s\\S]{0,180}?onClick=\\{\\(\\) => zoomModel\\(${direction}\\)\\}[\\s\\S]{0,180}?aria-label=["']${label}["']`,
    );
    assert.match(studio, button, `${label} must be a native keyboard-operable button`);
  }
});
