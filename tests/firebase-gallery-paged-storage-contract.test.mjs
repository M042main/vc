import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../app/lib/firebaseGallery.ts", import.meta.url);

test("keeps gallery pages at 20 records plus one server cursor sentinel", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /export const GALLERY_PAGE_SIZE = 20/u);
  assert.match(
    source,
    /const GALLERY_PAGE_QUERY_SIZE = GALLERY_PAGE_SIZE \+ 1/u,
  );
  assert.match(source, /export function subscribeGalleryPage/u);
  assert.match(source, /orderByKey\(\)/u);
  assert.match(source, /endBefore\(validatedCursor\.id\)/u);
  assert.match(source, /limitToLast\(GALLERY_SCAN_CHUNK_SIZE\)/u);
  assert.match(source, /selectGalleryPageChildren\(children, GALLERY_PAGE_SIZE\)/u);
  assert.doesNotMatch(source, /orderByChild\(|equalTo\(/u);
});

test("stores small thumbnails separately and loads a full PNG only on demand", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /const GALLERY_IMAGES_PATH/u);
  assert.match(source, /thumbnailDataUrl:\s*string/u);
  assert.match(source, /createGalleryThumbnailDataUrl/u);
  assert.match(source, /canvas\.toDataURL\("image\/webp"/u);
  assert.match(source, /\[`entries\/\$\{id\}`\]: record/u);
  assert.match(
    source,
    /\[`galleryImages\/\$\{id\}\/imageDataUrl`\]: originalImageDataUrl/u,
  );
  assert.match(source, /export function loadGalleryEntryImage/u);
  assert.match(source, /GALLERY_IMAGES_PATH[\s\S]{0,100}imageDataUrl/u);
});

test("migrates legacy embedded originals sequentially without resurrecting deleted metadata", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /let legacyMigrationQueue: Promise<void> = Promise\.resolve\(\)/u);
  assert.match(source, /legacyMigrationQueue[\s\S]{0,140}\.then\(async/u);
  assert.match(source, /const MAX_PENDING_LEGACY_MIGRATIONS = 2/u);
  assert.match(source, /legacyMigrationPromises\.size >= MAX_PENDING_LEGACY_MIGRATIONS/u);
  assert.match(source, /runTransaction\([\s\S]{0,100}entryRef/u);
  assert.match(source, /applyLegacyGalleryMigration/u);
  assert.match(source, /const cleanupStagedImageIfEntryMissing = async/u);
  assert.match(source, /shouldCleanupStagedLegacyImage\(marker\.exists\(\)\)/u);
  assert.match(source, /if \(!transactionResult\.committed\)[\s\S]{0,220}cleanupStagedImageIfEntryMissing/u);
  assert.doesNotMatch(
    source,
    /Promise\.all\(\s*entries\.map\([^)]*createGalleryThumbnailDataUrl/u,
  );
});

test("rechecks the split original after a concurrent lazy migration", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const loader = source.slice(source.indexOf("export function loadGalleryEntryImage"));
  assert.match(loader, /await legacyMigrationPromises\.get\(id\)/u);
  assert.match(loader, /const migratedSnapshot = await get/u);
  assert.match(loader, /if \(migratedSnapshot\.exists\(\)\)/u);
});
