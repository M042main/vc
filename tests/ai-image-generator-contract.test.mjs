import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const componentUrl = new URL(
  "../app/components/AiImageGenerator.tsx",
  import.meta.url,
);
const cssUrl = new URL(
  "../app/components/AiImageGenerator.module.css",
  import.meta.url,
);
const pageUrl = new URL("../app/page.tsx", import.meta.url);
const firebaseUrl = new URL("../app/lib/firebaseGallery.ts", import.meta.url);

async function sources() {
  const [component, css, page, firebase] = await Promise.all([
    readFile(componentUrl, "utf8"),
    readFile(cssUrl, "utf8"),
    readFile(pageUrl, "utf8"),
    readFile(firebaseUrl, "utf8"),
  ]);
  return { component, css, page, firebase };
}

test("selects only the active profile's realtime Firebase gallery photos", async () => {
  const { component, firebase } = await sources();
  assert.match(component, /subscribeGalleryEntriesForProfile\(profile, \{/u);
  assert.doesNotMatch(component, /\bsubscribeGalleryEntries\(\{/u);
  assert.match(firebase, /\bequalTo\b/u);
  assert.match(firebase, /\borderByChild\b/u);
  assert.match(
    firebase,
    /export function subscribeGalleryEntriesForProfile\([\s\S]{0,220}createVisitorProfile\(profile\)/u,
  );
  assert.match(
    firebase,
    /orderByChild\("name"\)[\s\S]{0,100}equalTo\(activeProfile\.name\)[\s\S]{0,100}limitToLast\(MAX_AI_SOURCE_ENTRIES\)/u,
  );
  assert.match(firebase, /const MAX_AI_SOURCE_ENTRIES = 12/u);
  assert.match(firebase, /entry\.classId === activeProfile\.classId/u);
  assert.match(firebase, /activeProfile\.guest \|\| !activeProfile\.classId/u);
  assert.match(component, /\.sort\([\s\S]{0,100}right\.createdAt - left\.createdAt/u);
  assert.match(component, /aria-pressed=\{entry\.id === selectedEntryId\}/u);
  assert.match(component, /subscriptionRef\.current !== subscriptionToken/u);
  assert.match(component, /unsubscribe\(\)/u);
  assert.match(component, /게스트는 AI 생성과 온라인 저장을 사용할 수 없습니다/u);
});

test("keeps the generic gallery subscription unchanged for legacy entries", async () => {
  const { firebase } = await sources();
  const genericStart = firebase.indexOf("export function subscribeGalleryEntries({");
  const scopedStart = firebase.indexOf(
    "export function subscribeGalleryEntriesForProfile(",
  );
  assert.ok(genericStart >= 0 && scopedStart > genericStart);
  const genericSubscription = firebase.slice(genericStart, scopedStart);
  assert.match(genericSubscription, /ref\(database, GALLERY_ENTRIES_PATH\)/u);
  assert.match(genericSubscription, /onData\(entries\)/u);
  assert.doesNotMatch(genericSubscription, /orderByChild|equalTo|activeProfile/u);
  assert.match(
    firebase,
    /\/000000\/박근석_t7\/motion_ink_gallery_a7f3c9/u,
  );
});

test("runs exactly three internal variants with partial-success handling", async () => {
  const { component } = await sources();
  assert.match(component, /const GENERATION_VARIANTS = \[/u);
  assert.equal((component.match(/id: "(?:illustration|three-dimensional|sticker)"/gu) ?? []).length, 3);
  assert.match(component, /Promise\.allSettled\([\s\S]{0,220}GENERATION_VARIANTS\.map/u);
  assert.match(component, /successfulResults\.length === 0/u);
  assert.match(component, /setResults\(successfulResults\.slice\(0, MAX_RESULTS\)\)/u);
  assert.match(component, /const MAX_RESULTS = 3/u);
  assert.match(
    component,
    /\$\{GENERATION_VARIANTS\.length\}개 중 \$\{successfulResults\.length\}개 결과/u,
  );
  assert.match(component, /generationRef\.current !== generationToken/u);
  assert.match(component, /profileKeyRef\.current !== profileKey/u);
});

test("keeps the Gemini key server-side and follows the generation route contract", async () => {
  const { component } = await sources();
  assert.match(component, /fetch\("\/api\/ai\/generate"/u);
  assert.match(component, /method:\s*"POST"/u);
  assert.match(
    component,
    /JSON\.stringify\(\{[\s\S]{0,180}prompt:[\s\S]{0,180}imageDataUrl,/u,
  );
  assert.match(component, /generatedImageFromPayload\(value\)/u);
  assert.doesNotMatch(
    component,
    /AIza|GEMINI_API_KEY|x-goog-api-key|generativelanguage\.googleapis/u,
  );
});

test("removes local upload, style choices, and the three requested generated classes", async () => {
  const { component, css } = await sources();
  assert.doesNotMatch(component, /type="file"|accept="image\/|FileReader.*참고 사진/u);
  assert.doesNotMatch(component, /PROMPT_PRESETS|aria-pressed=\{activePreset|캐릭터 스타일/u);
  for (const removedClass of ["modelBadge", "iconBadge", "privacyNote"]) {
    assert.doesNotMatch(component, new RegExp(`styles\\.${removedClass}`, "u"));
    assert.doesNotMatch(css, new RegExp(`\\.${removedClass}\\b`, "u"));
  }
  assert.match(component, /aria-describedby=\{apiNoticeId\}/u);
  assert.match(component, /Google Gemini API로 전송됩니다/u);
});

test("saves each result once as a bounded PNG and guards profile transitions", async () => {
  const { component } = await sources();
  assert.match(component, /publishGalleryEntry\(\{ profile, imageDataUrl: pngDataUrl \}\)/u);
  assert.match(component, /MAX_GALLERY_IMAGE_DATA_URL_LENGTH\s*=\s*Math\.floor\(5\.5 \* 1024 \* 1024\)/u);
  assert.match(component, /for \(let attempt = 0; attempt < 7; attempt \+= 1\)/u);
  assert.match(component, /savingRef\.current\.has\(result\.id\)/u);
  assert.match(component, /savingRef\.current\.size > 0/u);
  assert.match(component, /savingRef\.current\.add\(result\.id\)/u);
  assert.match(component, /savedIds\.has\(result\.id\)/u);
  assert.match(component, /profileKeyRef\.current !== saveProfileKey/u);
  assert.match(component, /mountedRef\.current = true/u);
  assert.match(component, /onBusyChange\?\.\(true\)/u);
  assert.match(component, /갤러리에 저장됨/u);
});

test("wires an independent AI busy lock into profile and mode controls", async () => {
  const { page } = await sources();
  assert.match(page, /const \[aiImageBusy, setAiImageBusy\] = useState\(false\)/u);
  assert.match(page, /const pageBusy = characterLibraryBusy \|\| aiImageBusy/u);
  assert.match(page, /<VisitorProfileActions[\s\S]{0,160}disabled=\{pageBusy\}/u);
  assert.equal((page.match(/disabled=\{pageBusy\}/gu) ?? []).length >= 5, true);
  assert.match(page, /if \(aiImageBusy \|\| libraryMutationRef\.current\.busy\) return/u);
  assert.match(
    page,
    /className="admin-access-button"[\s\S]{0,260}disabled=\{pageBusy\}/u,
  );
  assert.match(
    page,
    /<AiImageGenerator[\s\S]{0,120}key=\{characterArtworkKey\}[\s\S]{0,120}profile=\{profile\}[\s\S]{0,160}onBusyChange=\{setAiImageBusy\}/u,
  );
});

test("clears stale generated results when the source gallery photo changes", async () => {
  const { component } = await sources();
  assert.match(
    component,
    /setSelectedEntryId\(entry\.id\);[\s\S]{0,180}setResults\(\[\]\);[\s\S]{0,180}setSavedIds\(new Set\(\)\);[\s\S]{0,180}setGenerationMessage\(""\)/u,
  );
});

test("provides accessible responsive result and source grids", async () => {
  const { component, css } = await sources();
  assert.match(component, /role="status"\s+aria-live="polite"/u);
  assert.match(component, /className=\{styles\.generationError\}\s+role="alert"/u);
  assert.match(component, /갤러리에 저장/u);
  assert.match(component, /PNG 다운로드/u);
  assert.match(component, /galleryEntries\.map\(\(entry, index\)/u);
  assert.match(component, /\$\{index \+ 1\}번째 사진/u);
  assert.match(component, /aria-labelledby=\{resultTitleId\}/u);
  assert.match(component, /<h4 id=\{resultTitleId\}>\{result\.label\}<\/h4>/u);
  assert.match(component, /aria-label=\{`\$\{result\.label\} 결과 \$\{/u);
  assert.match(css, /min-height:\s*44px/u);
  assert.match(css, /@media\s*\(max-width:\s*1050px\)/u);
  assert.match(css, /@media\s*\(max-width:\s*520px\)/u);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/u);
});

test("bounds PNG downloads and prevents synchronous duplicate downloads", async () => {
  const { component } = await sources();
  const start = component.indexOf("const downloadResult = useCallback");
  const end = component.indexOf("\n\n  return (", start);
  assert.ok(start >= 0 && end > start);
  const download = component.slice(start, end);
  assert.match(download, /downloadingRef\.current\.has\(result\.id\)/u);
  assert.match(download, /downloadingRef\.current\.add\(result\.id\)/u);
  assert.match(download, /prepareGalleryPngDataUrl\(result\.imageDataUrl\)/u);
  assert.match(download, /pngDataUrlToBlob/u);
  assert.match(download, /downloadingRef\.current\.delete\(result\.id\)/u);
  assert.doesNotMatch(download, /naturalWidth|naturalHeight|canvasToPngBlob/u);
});
