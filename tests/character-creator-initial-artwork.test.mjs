import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const creatorUrl = new URL(
  "../app/components/CharacterCreator.tsx",
  import.meta.url,
);

function blockFrom(source, marker, length = 5_000) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing source marker: ${marker}`);
  return source.slice(start, start + length);
}

test("imports saved transparent artwork once per profile key without stale overwrite", async () => {
  const source = await readFile(creatorUrl, "utf8");
  const importEffect = blockFrom(source, "const importKey =", 5_200);

  assert.match(source, /initialArtwork\?:\s*string\s*\|\s*null/);
  assert.match(source, /initialArtworkKey\?:\s*string/);
  assert.match(importEffect, /importedArtworkKeyRef\.current\s*===\s*importKey/);
  assert.match(importEffect, /importedArtworkRef\.current\s*===\s*initialArtwork/);
  assert.match(importEffect, /artworkImportGenerationRef\.current\s*!==\s*generation/);
  assert.match(importEffect, /frontContext\.clearRect/);
  assert.match(importEffect, /backContext\.clearRect/);
  assert.match(importEffect, /frontContext\.drawImage\(loadedImage, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT\)/);
  assert.match(importEffect, /front:\s*loadedImage\s*\?\s*\[blankFront\]\s*:\s*\[\]/);
  assert.match(importEffect, /importedArtworkRef\.current\s*=\s*initialArtwork/);
  assert.match(importEffect, /artworkImportPendingRef\.current\s*=\s*false/);
});

test("clears the previous slot before decoding and never lets the first stroke cancel import", async () => {
  const source = await readFile(creatorUrl, "utf8");
  const importEffect = blockFrom(source, "const importKey =", 5_200);
  const snapshot = blockFrom(source, "const saveUndoSnapshot", 1_000);
  const pointerDown = blockFrom(source, "const handlePointerDown", 1_300);

  assert.match(
    source,
    /useLayoutEffect\(\(\)\s*=>\s*\{\s*const importKey\s*=/,
    "a slot switch must commit before the browser paints the old layer",
  );
  const clearFront = importEffect.indexOf("frontContext.clearRect");
  const clearBack = importEffect.indexOf("backContext.clearRect");
  const scheduleDecode = importEffect.indexOf("const image = initialArtwork ? new Image() : null");
  assert.ok(clearFront >= 0 && clearFront < scheduleDecode);
  assert.ok(clearBack >= 0 && clearBack < scheduleDecode);
  assert.doesNotMatch(
    importEffect.slice(0, scheduleDecode),
    /setTimeout/,
    "blanking the old owner cannot be deferred to a timer",
  );
  assert.match(importEffect, /undoHistoryRef\.current\s*=\s*\{\s*front:\s*\[\],\s*back:\s*\[\]\s*\}/);
  assert.match(importEffect, /paintVisibleCanvas\(\)[\s\S]*const image/);
  assert.match(
    pointerDown,
    /if\s*\(disabled\s*\|\|\s*artworkImportPendingRef\.current\)[\s\S]*return/,
  );
  assert.doesNotMatch(
    snapshot,
    /artworkImportGenerationRef/,
    "a user stroke must not invalidate the slot import generation",
  );
  assert.match(source, /disabled\?:\s*boolean/);
  assert.match(source, /const editorDisabled\s*=\s*disabled\s*\|\|\s*importingArtwork/);
  assert.match(source, /disabled=\{sendingToStudio\s*\|\|\s*editorDisabled\}/);
  assert.match(source, /aria-disabled=\{editorDisabled\}/);
});

test("awaits profile save before entering the studio and exposes busy feedback", async () => {
  const source = await readFile(creatorUrl, "utf8");
  const send = blockFrom(source, "const sendToStudio = async", 1_500);

  assert.match(
    source,
    /onSendToStudio\?:\s*\(dataUrl:\s*string\)\s*=>\s*void\s*\|\s*Promise<void>/,
  );
  assert.match(send, /await onSendToStudio\?\.\(dataUrl\)/);
  assert.match(send, /setSendingToStudio\(true\)/);
  assert.match(send, /finally[\s\S]{0,180}setSendingToStudio\(false\)/);
  assert.match(source, /저장하고 스튜디오로/);
  assert.match(
    source,
    /aria-busy=\{sendingToStudio\s*\|\|\s*editorDisabled\}/,
  );
});
