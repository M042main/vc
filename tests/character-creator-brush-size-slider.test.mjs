import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const creatorUrl = new URL(
  "../app/components/CharacterCreator.tsx",
  import.meta.url,
);
const creatorCssUrl = new URL(
  "../app/components/CharacterCreator.module.css",
  import.meta.url,
);

test("offers a continuous, labelled brush-size range with a live value", async () => {
  const creator = await readFile(creatorUrl, "utf8");

  assert.match(creator, /const BRUSH_SIZE_MIN = 2;/);
  assert.match(creator, /const BRUSH_SIZE_MAX = 40;/);
  assert.match(creator, /const BRUSH_SIZE_STEP = 1;/);
  assert.match(creator, /const DEFAULT_BRUSH_SIZE = 14;/);
  assert.match(creator, /<legend className=\{styles\.groupLabel\}>선 굵기<\/legend>/);
  assert.match(creator, /<label className=\{styles\.srOnly\} htmlFor=\{brushSizeInputId\}>\s*선 굵기/);
  assert.match(creator, /type="range"/);
  assert.match(creator, /min=\{BRUSH_SIZE_MIN\}/);
  assert.match(creator, /max=\{BRUSH_SIZE_MAX\}/);
  assert.match(creator, /step=\{BRUSH_SIZE_STEP\}/);
  assert.match(creator, /value=\{brushSize\}/);
  assert.match(creator, /aria-valuetext=\{`\$\{brushSize\}px`\}/);
  assert.match(creator, /onChange=\{\(event\) => setBrushSize\(Number\(event\.target\.value\)\)\}/);
  assert.match(creator, /<output htmlFor=\{brushSizeInputId\} aria-live="polite">\s*\{brushSize\}px/);
  assert.doesNotMatch(creator, /BRUSH_SIZES\.map|aria-pressed=\{brushSize === size\.value\}/);
});

test("keeps the slider usable by pointer, touch, and keyboard", async () => {
  const css = await readFile(creatorCssUrl, "utf8");

  assert.match(css, /\.brushSizeSlider\s*\{[\s\S]{0,220}width:\s*100%;[\s\S]{0,220}cursor:\s*ew-resize;/);
  assert.match(css, /\.brushSizeSlider::-webkit-slider-runnable-track/);
  assert.match(css, /\.brushSizeSlider::-webkit-slider-thumb/);
  assert.match(css, /\.brushSizeSlider::-moz-range-track/);
  assert.match(css, /\.brushSizeSlider::-moz-range-thumb/);
  assert.match(css, /\.brushSizeSlider:focus-visible/);
});
