import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const studioUrl = new URL("../app/components/VrmStudio.tsx", import.meta.url);
const studioCssUrl = new URL(
  "../app/components/VrmStudio.module.css",
  import.meta.url,
);
const pageUrl = new URL("../app/page.tsx", import.meta.url);

test("both full-body capture buttons open one accessible background choice dialog", async () => {
  const source = await readFile(studioUrl, "utf8");

  assert.match(source, /captureDialogOpen/);
  assert.match(source, /role="dialog"[\s\S]{0,100}aria-modal="true"/);
  assert.match(source, /배경 미포함/);
  assert.match(source, /배경 포함/);
  assert.match(source, /captureDialogFirstChoiceRef\.current\?\.focus\(\)/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /event\.key !== "Tab"/);
  assert.equal(
    [...source.matchAll(/onClick=\{\(event\) => openCaptureDialog\(event\.currentTarget\)\}/g)]
      .length,
    2,
  );
  assert.doesNotMatch(source, /onClick=\{capture\}/);
});

test("background capture composites the current photo or stage color after transparent auto-fit", async () => {
  const source = await readFile(studioUrl, "utf8");

  assert.match(source, /includeStageBackgroundInCapture\s*\(/);
  assert.match(source, /stageBackgroundImageRef\.current/);
  assert.match(source, /stageBackgroundFitRef\.current/);
  assert.match(source, /stageColorRef\.current/);
  assert.match(source, /const\s+captureBackground\s*=\s*\{[\s\S]{0,180}stageBackgroundFitRef\.current/);
  assert.match(source, /captureBackground\.color[\s\S]{0,120}captureBackground\.image[\s\S]{0,120}captureBackground\.fit/);
  assert.match(source, /context\.drawImage\(foreground,\s*0,\s*0,\s*width,\s*height\)/);
  assert.match(source, /paperDoll\.capturePng\(1600,\s*2000\)/);
  assert.match(source, /captureVrmFullBodyPng\s*\(/);
  assert.match(source, /includeBackground\s*\?[\s\S]{0,180}includeStageBackgroundInCapture/);
});

test("one capture downloads once and awaits immediate gallery publication", async () => {
  const [studio, page] = await Promise.all([
    readFile(studioUrl, "utf8"),
    readFile(pageUrl, "utf8"),
  ]);

  assert.match(studio, /downloadBlob\(blob,\s*fileName\)/);
  assert.match(studio, /await\s+onCaptureReady\(\{\s*imageDataUrl,\s*fileName\s*\}\)/);
  assert.match(page, /const\s+handleCaptureReady\s*=\s*useCallback/);
  assert.match(page, /await\s+prepareGalleryImageDataUrl\(\s*capture\.imageDataUrl/);
  assert.match(page, /await\s+publishGalleryEntry\(\{[\s\S]{0,120}imageDataUrl:\s*galleryImageDataUrl/);
  assert.match(page, /onCaptureReady=\{handleCaptureReady\}/);
  assert.doesNotMatch(page, /onCaptureReady=\{setLatestCapture\}/);
});

test("gallery publication resizes oversized PNG copies and locks the active profile", async () => {
  const page = await readFile(pageUrl, "utf8");

  assert.match(page, /GALLERY_IMAGE_TARGET_BYTES\s*=\s*Math\.floor/u);
  assert.match(page, /async function prepareGalleryImageDataUrl/u);
  assert.match(page, /dataUrl\.length <= GALLERY_IMAGE_TARGET_BYTES/u);
  assert.match(page, /canvas\.toBlob/u);
  assert.match(page, /context\.drawImage\(image,\s*0,\s*0,\s*canvas\.width,\s*canvas\.height\)/u);
  assert.match(page, /const mutationToken = beginLibraryMutation\(libraryMutationRef, profile\)/u);
  assert.match(page, /isLibraryMutationCurrent\(libraryMutationRef, mutationToken\)/u);
  assert.match(page, /setCharacterLibraryBusy\(true\)/u);
  assert.match(page, /finishLibraryMutation\(libraryMutationRef, mutationToken\)/u);
});

test("capture choice dialog remains usable on narrow screens", async () => {
  const css = await readFile(studioCssUrl, "utf8");

  assert.match(css, /\.captureDialogBackdrop\s*\{[\s\S]{0,160}position:\s*fixed/);
  assert.match(css, /\.captureDialogChoice:focus-visible/);
  assert.match(css, /\.captureDialogBackdrop\s*\{[\s\S]{0,240}overflow-y:\s*auto/);
  assert.match(css, /\.captureDialog\s*\{[\s\S]{0,220}max-height:\s*calc\(100dvh\s*-\s*48px\)[\s\S]{0,80}overflow-y:\s*auto/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*480px\)[\s\S]*\.captureDialogChoices\s*\{[\s\S]{0,80}grid-template-columns:\s*1fr/,
  );
});
