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

test("gallery thumbnails open one labelled full-view dialog", async () => {
  const source = await readFile(galleryUrl, "utf8");

  assert.match(source, /const \[previewEntry, setPreviewEntry\]/u);
  assert.match(
    source,
    /className=\{styles\.cardImage\}[\s\S]{0,260}openPreview\(entry, event\.currentTarget\)[\s\S]{0,180}aria-haspopup="dialog"[\s\S]{0,160}캐릭터 전체보기/u,
  );
  assert.match(
    source,
    /className=\{styles\.previewDialog\}[\s\S]{0,120}role="dialog"[\s\S]{0,120}aria-modal="true"[\s\S]{0,120}aria-labelledby=\{previewHeadingId\}/u,
  );
  assert.match(source, /<span>전체보기<\/span>/u);
  assert.match(source, /aria-label="전체보기 닫기"/u);
  assert.match(source, /loadGalleryEntryImage\(entryId\)/u);
  assert.match(source, /setPreviewImageDataUrl\(imageDataUrl\)/u);
  assert.match(source, /src=\{previewImageDataUrl\}/u);
  assert.match(source, /원본 이미지를 불러오는 중입니다/u);
  assert.match(source, /원본 이미지를 불러오지 못했습니다/u);
});

test("full-view dialog closes accessibly and restores the thumbnail focus", async () => {
  const source = await readFile(galleryUrl, "utf8");

  assert.match(source, /previewTriggerRef\.current = trigger/u);
  assert.match(source, /setPreviewEntry\(null\)/u);
  assert.match(source, /previewRequestGenerationRef\.current \+= 1/u);
  assert.match(source, /setPreviewImageDataUrl\(null\)/u);
  assert.match(source, /window\.setTimeout\(\(\) => trigger\?\.focus\(\), 0\)/u);
  assert.match(source, /event\.key === "Escape"[\s\S]{0,100}closePreview\(\)/u);
  assert.match(source, /event\.key !== "Tab"/u);
  assert.match(source, /querySelectorAll<HTMLElement>/u);
  assert.match(source, /document\.body\.style\.overflow = "hidden"/u);
  assert.match(
    source,
    /document\.body\.style\.overflow = previousBodyOverflow/u,
  );
  assert.match(source, /window\.clearTimeout\(focusTimer\)/u);
  assert.match(source, /removeEventListener\("keydown", handlePreviewKeyDown\)/u);
  assert.match(
    source,
    /event\.target === event\.currentTarget\) closePreview\(\)/u,
  );
});

test("keeps image preview and the download-name dialog mutually exclusive", async () => {
  const source = await readFile(galleryUrl, "utf8");
  assert.match(
    source,
    /const openPreview = useCallback\([\s\S]{0,300}setNameAction\(null\)[\s\S]{0,180}setPreviewEntry\(entry\)/u,
  );
  assert.match(
    source,
    /const openNameDialog = useCallback\([\s\S]{0,320}setPreviewEntry\(null\)[\s\S]{0,220}setNameAction\(action\)/u,
  );
});

test("full-view image stays inside the viewport on desktop and mobile", async () => {
  const css = await readFile(galleryCssUrl, "utf8");

  assert.match(css, /\.cardImage\s*\{[\s\S]*?cursor:\s*zoom-in/u);
  assert.match(
    css,
    /\.previewBackdrop\s*\{[\s\S]{0,160}position:\s*fixed[\s\S]{0,240}env\(safe-area-inset-top\)/u,
  );
  assert.match(
    css,
    /\.previewDialog\s*\{[\s\S]{0,300}height:\s*min\(900px, calc\(100dvh - 24px\)\)[\s\S]{0,180}overflow:\s*hidden/u,
  );
  assert.match(
    css,
    /\.previewImage img\s*\{[\s\S]{0,180}max-width:\s*100%[\s\S]{0,120}max-height:\s*100%[\s\S]{0,80}object-fit:\s*contain/u,
  );
  assert.match(css, /@media\s*\(max-width:\s*590px\)[\s\S]*\.previewDialog/u);
});
