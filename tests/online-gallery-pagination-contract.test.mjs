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

test("shows at most 30 filtered gallery entries on each numbered page", async () => {
  const [source, firebaseSource] = await Promise.all([
    readFile(galleryUrl, "utf8"),
    readFile(firebaseGalleryUrl, "utf8"),
  ]);

  assert.match(source, /const GALLERY_PAGE_SIZE = 30/u);
  assert.match(source, /Math\.ceil\(visibleEntries\.length \/ GALLERY_PAGE_SIZE\)/u);
  assert.match(
    source,
    /visibleEntries\.slice\([\s\S]{0,180}firstEntryIndex \+ GALLERY_PAGE_SIZE/u,
  );
  assert.match(source, /paginatedEntries\.map\(\(entry\) =>/u);
  assert.match(firebaseSource, /const MAX_GALLERY_ENTRIES = 90/u);
  assert.match(
    firebaseSource,
    /subscribeGalleryEntries[\s\S]{0,500}limitToLast\(MAX_GALLERY_ENTRIES\)/u,
  );
});

test("resets to page one after a class filter change and clamps a removed last page", async () => {
  const source = await readFile(galleryUrl, "utf8");

  assert.match(
    source,
    /setCurrentPage\(1\)[\s\S]{0,120}\[effectiveClassFilter\]/u,
  );
  assert.match(
    source,
    /currentPage <= totalPages[\s\S]{0,120}setCurrentPage\(totalPages\)/u,
  );
  assert.match(source, /const activePage = Math\.min\(currentPage, totalPages\)/u);
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
