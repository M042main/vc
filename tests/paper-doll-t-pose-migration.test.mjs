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

  assert.match(source, /function characterStorageId\(profile/);
  assert.match(source, /`\$\{SAVED_CHARACTER_ID\}:\$\{visitorArtworkKey\(profile\)\}`/);

  const restore = blockFrom(source, "if (!profileReady) return;", 3_200);
  assert.match(restore, /if \(profile\.guest\)/);
  assert.match(restore, /loadGuestCharacterArtwork\(profile\)/);
  const guestMigration = blockFrom(source, "function loadGuestCharacterArtwork", 1_500);
  assert.match(guestMigration, /storage\.getItem\(SAVED_CHARACTER_KEY\)/);
  assert.match(guestMigration, /LEGACY_GUEST_CHARACTER_OWNER_KEY/);
  assert.match(restore, /\.get\(legacyStorageId\)/);
  assert.match(restore, /loadSavedCharacterSlots\(profile\)/);

  const save = blockFrom(source, "const handleSendToStudio", 2_000);
  assert.match(save, /const storageId = profileCharacterStorageId\(profile, slotId\)/);
  assert.match(save, /id:\s*storageId/);
  assert.match(save, /if \(profile\.guest\)/);
  assert.match(save, /localStorage\.setItem\(guestCharacterArtworkKey\(profile\), dataUrl\)/);
  assert.match(save, /saveCharacterSlot\(profile, slotId, dataUrl\)/);

  assert.doesNotMatch(source, /localStorage\.removeItem\(/);
  assert.doesNotMatch(source, /\.remove\(\s*["']motion-ink-latest-character["']/);
  assert.doesNotMatch(source, /\.clear\(\)/);
});
