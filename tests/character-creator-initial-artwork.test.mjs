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
  assert.match(source, /artworkImportGenerationRef\.current\s*\+=\s*1/);
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
  assert.match(source, /aria-busy=\{sendingToStudio\}/);
});
