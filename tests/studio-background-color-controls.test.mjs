import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const studioUrl = new URL("../app/components/VrmStudio.tsx", import.meta.url);
const studioCssUrl = new URL(
  "../app/components/VrmStudio.module.css",
  import.meta.url,
);
const galleryUrl = new URL(
  "../app/components/OnlineGallery.tsx",
  import.meta.url,
);
const galleryCssUrl = new URL(
  "../app/components/OnlineGallery.module.css",
  import.meta.url,
);

test("offers black, gray, chroma-key, and one custom color control", async () => {
  const [studio, css] = await Promise.all([
    readFile(studioUrl, "utf8"),
    readFile(studioCssUrl, "utf8"),
  ]);

  const catalog = studio.match(/const\s+STAGE_COLORS\s*=\s*\[([\s\S]*?)\]\s*as const/);
  assert.ok(catalog, "stage color preset catalog must exist");
  assert.match(catalog[1], /value:\s*["']#000000["']\s*,\s*label:\s*["']검정["']/i);
  assert.match(catalog[1], /value:\s*["']#808080["']\s*,\s*label:\s*["']회색["']/i);
  assert.match(catalog[1], /value:\s*CHROMA_KEY_GREEN\s*,\s*label:\s*["']크로마키 초록["']/);
  assert.doesNotMatch(catalog[1], /바이올렛|딥 그린|#332d58|#254a48/i);
  assert.equal(
    [...catalog[1].matchAll(/\{\s*value:/g)].length,
    3,
    "the fourth choice is the custom color picker, not another fixed preset",
  );

  assert.match(studio, /type=["']color["']/);
  assert.match(studio, /aria-label=["']자유 배경색 선택["']/);
  assert.match(studio, /updateCustomStageColorDraft\(event\.target\.value\)/);
  assert.match(
    studio,
    /const\s+updateCustomStageColorDraft[\s\S]{0,240}setCustomStageColorDraft\(color\)[\s\S]{0,80}selectStageColor\(color\)/,
  );
  assert.doesNotMatch(studio, /applyCustomStageColor|applyCustomColorButton/);
  assert.doesNotMatch(studio, />\s*적용\s*<\/button>/);
  assert.match(studio, /className=\{styles\.customColorControl\}/);
  assert.match(css, /\.swatches\s*\{[\s\S]{0,180}grid-template-columns:\s*repeat\(4,/);
  assert.match(css, /\.customColorControl\s*\{[\s\S]{0,240}height:\s*44px/);
  assert.doesNotMatch(css, /\.applyCustomColorButton\b/);
});

test("keeps custom colors persistent while migrating the removed presets", async () => {
  const studio = await readFile(studioUrl, "utf8");

  assert.match(studio, /HEX_STAGE_COLOR\.test\(restoredColor\)/);
  assert.match(studio, /setStageColor\(restoredColor\)/);
  assert.match(studio, /setCustomStageColorDraft\(restoredColor\)/);
  assert.match(studio, /LEGACY_STAGE_COLORS\s*=\s*new Set\(\[[\s\S]*?#332d58[\s\S]*?#254a48/);
});

test("does not render the gallery CSS-module profile panel name", async () => {
  const [gallery, css] = await Promise.all([
    readFile(galleryUrl, "utf8"),
    readFile(galleryCssUrl, "utf8"),
  ]);

  assert.doesNotMatch(gallery, /styles\.namePanel/);
  assert.doesNotMatch(css, /\.namePanel\b/);
  assert.doesNotMatch(gallery, /<span>활성 프로필<\/span>/);
});

test("renders only the accessible gallery class filter select", async () => {
  const [gallery, css] = await Promise.all([
    readFile(galleryUrl, "utf8"),
    readFile(galleryCssUrl, "utf8"),
  ]);

  assert.doesNotMatch(gallery, /styles\.liveCount|formattedCount|CHARACTERS/);
  assert.doesNotMatch(css, /\.liveCount\b/);
  assert.doesNotMatch(gallery, /ONLINE GALLERY\s*·\s*LIVE|styles\.eyebrow/);
  assert.doesNotMatch(css, /\.eyebrow\b/);
  assert.match(gallery, /<h2 id=\{headingId\}>함께 만든 캐릭터를 둘러보세요<\/h2>/);
  assert.equal(
    [...gallery.matchAll(/className=\{styles\.galleryFilter\}/g)].length,
    1,
    "the class filter should render once",
  );
  assert.match(
    gallery,
    /<header className=\{styles\.header\}>[\s\S]{0,1800}<select[\s\S]{0,240}className=\{styles\.galleryFilter\}[\s\S]{0,240}value=\{effectiveClassFilter\}[\s\S]{0,240}onChange=\{\(event\) => setClassFilter\(event\.target\.value\)\}[\s\S]{0,180}aria-label=["']학급별 갤러리 필터["'][\s\S]{0,700}<\/header>/,
  );
  assert.doesNotMatch(gallery, /<label[^>]*>학급별 보기<\/label>/);
  assert.doesNotMatch(gallery, /개 표시<\/span>/);
  assert.doesNotMatch(css, /\.galleryFilter\s+(?:label|span|select)/);
  assert.match(css, /\.galleryFilter\s*\{[\s\S]{0,180}min-height:\s*38px/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*590px\)[\s\S]{0,700}\.galleryFilter\s*\{[\s\S]{0,120}width:\s*100%;/,
  );
});
