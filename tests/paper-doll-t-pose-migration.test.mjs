import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageUrl = new URL("../app/page.tsx", import.meta.url);

function blockFrom(source, marker, length = 2_500) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing source marker: ${marker}`);
  return source.slice(start, start + length);
}

test("isolates T-pose artwork without deleting or restoring the legacy downward-arm record", async () => {
  const source = await readFile(pageUrl, "utf8");

  assert.match(
    source,
    /const SAVED_CHARACTER_KEY = "motion-ink\.saved-character\.t-pose\.v2"/,
  );
  assert.match(
    source,
    /const SAVED_CHARACTER_ID = "motion-ink-latest-character-t-pose-v2"/,
  );
  assert.doesNotMatch(source, /["']motion-ink\.saved-character\.v1["']/);
  assert.doesNotMatch(source, /["']motion-ink-latest-character["']/);

  const restore = blockFrom(source, "useEffect(() => {", 2_200);
  assert.match(restore, /localStorage\.getItem\(SAVED_CHARACTER_KEY\)/);
  assert.match(restore, /\.get\(SAVED_CHARACTER_ID\)/);

  const save = blockFrom(source, "const handleSendToStudio", 1_300);
  assert.match(save, /localStorage\.setItem\(SAVED_CHARACTER_KEY, dataUrl\)/);
  assert.match(save, /id:\s*SAVED_CHARACTER_ID/);

  assert.doesNotMatch(source, /localStorage\.removeItem\(/);
  assert.doesNotMatch(source, /\.remove\(\s*["']motion-ink-latest-character["']/);
  assert.doesNotMatch(source, /\.clear\(\)/);
});
