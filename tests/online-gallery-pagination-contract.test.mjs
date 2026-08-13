import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const galleryUrl = new URL(
  "../app/components/OnlineGallery.tsx",
  import.meta.url,
);
const galleryCssUrl = new URL(
  "../app/components/OnlineGallery.module.css",
  import.meta.url,
);
const firebaseGalleryUrl = new URL("../app/lib/firebaseGallery.ts", import.meta.url);

test("loads at most 20 thumbnail records per Firebase page instead of all originals", async () => {
  const [source, firebaseSource] = await Promise.all([
    readFile(galleryUrl, "utf8"),
    readFile(firebaseGalleryUrl, "utf8"),
  ]);

  assert.match(firebaseSource, /export const GALLERY_PAGE_SIZE = 20/u);
  assert.match(
    firebaseSource,
    /GALLERY_PAGE_QUERY_SIZE\s*=\s*GALLERY_PAGE_SIZE\s*\+\s*1/u,
  );
  assert.match(
    firebaseSource,
    /function galleryKeyQuery[\s\S]{0,700}orderByKey\(\)[\s\S]{0,500}limitToLast\(GALLERY_SCAN_CHUNK_SIZE\)/u,
  );
  assert.match(firebaseSource, /endBefore\(validatedCursor\.id\)/u);
  assert.doesNotMatch(firebaseSource, /orderByChild\(|equalTo\(/u);
  assert.match(source, /subscribeGalleryPage\s*\(\{/u);
  assert.match(source, /entries\.map\(\(entry\) =>/u);
  assert.match(source, /src=\{entry\.thumbnailDataUrl\}/u);
  assert.doesNotMatch(source, /src=\{entry\.imageDataUrl\}/u);
});

test("resets cursor and page caches when filters or administrator state change", async () => {
  const source = await readFile(galleryUrl, "utf8");

  assert.match(
    source,
    /setPageCache\(\{\}\)[\s\S]{0,120}setPageCursors\(\{ 1: null \}\)[\s\S]{0,120}setCurrentPage\(1\)/u,
  );
  assert.match(
    source,
    /\[effectiveClassFilter, isAdmin, requestedPageScopeKey\]/u,
  );
  assert.match(source, /generation !== pageRequestGenerationRef\.current/u);
  assert.match(source, /pageScopeKey !== requestedPageScopeKey/u);
  assert.match(source, /const MAX_CACHED_PAGES = 3/u);
  assert.match(source, /\.slice\(MAX_CACHED_PAGES\)/u);
  assert.match(source, /return\s*\(\)\s*=>\s*\{[\s\S]{0,180}unsubscribe\(\)/u);
});

test("uses bounded key scans for class and unclassified filters", async () => {
  const [source, firebaseSource] = await Promise.all([
    readFile(galleryUrl, "utf8"),
    readFile(firebaseGalleryUrl, "utf8"),
  ]);

  assert.match(firebaseSource, /scanGalleryChildrenByKey\(\{[\s\S]{0,240}matchesGalleryClassFilter/u);
  assert.match(source, /<option value="unclassified">학급 정보 없음<\/option>/u);
  assert.match(source, /entry\.className \|\| "학급 정보 없음"/u);
  assert.match(source, /previewEntry\.className \|\| "학급 정보 없음"/u);
});

test("provides keyboard-sized, labelled numbered navigation on desktop and mobile", async () => {
  const [source, css] = await Promise.all([
    readFile(galleryUrl, "utf8"),
    readFile(galleryCssUrl, "utf8"),
  ]);

  assert.match(
    source,
    /<nav className=\{styles\.pagination\} aria-label="온라인 갤러리 페이지">/u,
  );
  assert.match(source, /aria-live="polite"[\s\S]{0,100}aria-atomic="true"/u);
  assert.match(source, /aria-label="이전 갤러리 페이지"/u);
  assert.match(source, /aria-label="다음 갤러리 페이지"/u);
  assert.match(source, /aria-current=\{pageNumber === activePage \? "page" : undefined\}/u);
  assert.match(source, /visitedPageNumbers\.map\(\(pageNumber\) =>/u);
  assert.match(source, /activePageData\?\.hasNextPage/u);
  assert.match(source, /activePageData\.nextCursor/u);
  assert.match(
    css,
    /\.paginationPages\s*\{[\s\S]{0,220}overflow-x:\s*auto/u,
  );
  assert.match(
    css,
    /\.paginationArrow,[\s\S]{0,80}\.paginationNumber\s*\{[\s\S]{0,140}min-width:\s*44px[\s\S]{0,100}min-height:\s*44px/u,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*590px\)[\s\S]*?\.pagination\s*\{/u,
  );
});
