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
const historyUrl = new URL("../app/lib/aiGenerationHistory.ts", import.meta.url);

async function sources() {
  const [component, css, page, firebase, history] = await Promise.all([
    readFile(componentUrl, "utf8"),
    readFile(cssUrl, "utf8"),
    readFile(pageUrl, "utf8"),
    readFile(firebaseUrl, "utf8"),
    readFile(historyUrl, "utf8"),
  ]);
  return { component, css, page, firebase, history };
}

test("selects only the active profile's gallery photos with bounded key scans", async () => {
  const { component, firebase } = await sources();
  assert.match(component, /subscribeGalleryEntriesForProfile\(profile, \{/u);
  assert.doesNotMatch(component, /\bsubscribeGalleryEntries\(\{/u);
  assert.doesNotMatch(firebase, /\bequalTo\b|\borderByChild\b/u);
  assert.match(
    firebase,
    /export function subscribeGalleryEntriesForProfile\([\s\S]{0,220}createVisitorProfile\(profile\)/u,
  );
  assert.match(
    firebase,
    /scanGalleryChildrenByKey\(\{[\s\S]{0,250}matchesGalleryOwner\(value, activeProfile\.classId as string, activeProfile\.name\)[\s\S]{0,180}targetSize: MAX_AI_SOURCE_ENTRIES/u,
  );
  assert.match(firebase, /const MAX_AI_SOURCE_ENTRIES = 12/u);
  assert.match(firebase, /orderByKey\(\)/u);
  assert.match(firebase, /limitToLast\(GALLERY_SCAN_CHUNK_SIZE\)/u);
  assert.match(firebase, /activeProfile\.guest \|\| !activeProfile\.classId/u);
  assert.match(component, /\.sort\([\s\S]{0,100}right\.createdAt - left\.createdAt/u);
  assert.match(component, /aria-pressed=\{entry\.id === selectedEntryId\}/u);
  assert.match(component, /subscriptionRef\.current !== subscriptionToken/u);
  assert.match(component, /unsubscribe\(\)/u);
  assert.match(component, /게스트는 AI 생성과 온라인 저장을 사용할 수 없습니다/u);
});

test("keeps the legacy generic subscription bounded by the server page API", async () => {
  const { firebase } = await sources();
  const genericStart = firebase.indexOf("export function subscribeGalleryEntries({");
  const scopedStart = firebase.indexOf(
    "export function subscribeGalleryEntriesForProfile(",
  );
  assert.ok(genericStart >= 0 && scopedStart > genericStart);
  const genericSubscription = firebase.slice(genericStart, scopedStart);
  assert.match(genericSubscription, /return subscribeGalleryPage\(\{/u);
  assert.match(genericSubscription, /classFilter: "all"/u);
  assert.match(genericSubscription, /onData: \(page\) => onData\(page\.entries\)/u);
  assert.doesNotMatch(genericSubscription, /orderByChild|equalTo|activeProfile/u);
  assert.match(firebase, /export const GALLERY_PAGE_SIZE = 20/u);
  assert.match(
    firebase,
    /\/000000\/박근석_t7\/motion_ink_gallery_a7f3c9/u,
  );
});

test("makes exactly one image request from one source photo and the user's prompt", async () => {
  const { component } = await sources();
  assert.doesNotMatch(component, /GENERATION_VARIANTS|Promise\.allSettled|MAX_RESULTS/u);
  assert.equal((component.match(/await generateImage\(\{/gu) ?? []).length, 1);
  assert.match(
    component,
    /originalImageDataUrl\s*=\s*await loadGalleryEntryImage\(selectedEntry\.id\)[\s\S]{0,360}sourceImageDataUrl\s*=\s*await prepareGalleryPngDataUrl\([\s\S]{0,80}originalImageDataUrl[\s\S]{0,360}imageDataUrl:\s*sourceImageDataUrl,[\s\S]{0,120}prompt:\s*normalizedPrompt/u,
  );
  assert.match(component, /<img src=\{entry\.thumbnailDataUrl\} alt="" \/>/u);
  assert.doesNotMatch(component, /<img src=\{entry\.imageDataUrl\} alt="" \/>/u);
  assert.match(component, /classId: profile\.classId/u);
  assert.match(component, /setResults\(\[result\]\)/u);
  assert.match(
    component,
    /body: JSON\.stringify\(\{[\s\S]{0,120}prompt,[\s\S]{0,120}imageDataUrl,[\s\S]{0,120}classId,/u,
  );
  assert.match(component, /generationRef\.current !== generationToken/u);
  assert.match(component, /profileKeyRef\.current !== profileKey/u);
  assert.equal(
    (component.match(/profileKeyRef\.current !== profileKey/gu) ?? []).length >= 3,
    true,
  );
});

test("keeps the Gemini key server-side and follows the generation route contract", async () => {
  const { component } = await sources();
  assert.match(component, /fetch\("\/api\/ai\/generate"/u);
  assert.match(component, /method:\s*"POST"/u);
  assert.match(
    component,
    /JSON\.stringify\(\{[\s\S]{0,180}prompt,[\s\S]{0,180}imageDataUrl,/u,
  );
  assert.match(component, /generatedImageFromPayload\(value\)/u);
  assert.doesNotMatch(
    component,
    /AIza|GEMINI_API_KEY|x-goog-api-key|generativelanguage\.googleapis/u,
  );
});

test("uses the requested title and removes model, comparison, upload, and style UI", async () => {
  const { component, css } = await sources();
  assert.doesNotMatch(component, /type="file"|accept="image\/|FileReader.*참고 사진/u);
  assert.doesNotMatch(component, /PROMPT_PRESETS|aria-pressed=\{activePreset|캐릭터 스타일/u);
  for (const removedClass of ["modelBadge", "iconBadge", "privacyNote"]) {
    assert.doesNotMatch(component, new RegExp(`styles\\.${removedClass}`, "u"));
    assert.doesNotMatch(css, new RegExp(`\\.${removedClass}\\b`, "u"));
  }
  assert.match(component, />AI로 내 캐릭터 꾸미기</u);
  assert.doesNotMatch(component, /GEMINI 2\.5 FLASH IMAGE|한 번 생성하면 서로 다른 세 가지/u);
  assert.doesNotMatch(component, /AI 캐릭터 3개 만들기|세 가지 캐릭터 만드는 중/u);
  assert.match(component, /aria-describedby=\{apiNoticeId\}/u);
  assert.match(component, /Google Gemini API로 전송됩니다/u);
});

test("saves the single result once, then removes its device-local history", async () => {
  const { component, history } = await sources();
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
  assert.match(component, /await removeAiGenerationHistory\(result\.id, saveProfileKey\)/u);
  assert.match(component, /setHistoryItems\(\(current\) => current\.filter/u);
  assert.match(component, /saveAiGenerationHistory\(historyItem\)/u);
  assert.match(history, /const MAX_ITEMS_PER_PROFILE = 8/u);
  assert.match(history, /const MAX_ITEMS_TOTAL = 32/u);
  assert.match(history, /const MAX_IMAGE_DATA_URL_LENGTH = 14 \* 1024 \* 1024/u);
  assert.match(history, /const MAX_TOTAL_IMAGE_DATA_URL_LENGTH = 48 \* 1024 \* 1024/u);
  assert.match(history, /while \([\s\S]{0,260}retained\.pop\(\)/u);
  assert.match(history, /deleteIds\.add\(oldest\.id\)/u);
});

test("defaults to enabled but blocks disabled classes in both UI and handler", async () => {
  const { component, page } = await sources();
  assert.match(component, /aiEnabled\?: boolean/u);
  assert.match(component, /aiEnabled = true/u);
  assert.match(component, /if \(!aiEnabled\) \{[\s\S]{0,160}관리자가 이 학급의 AI 이미지 생성을 비활성화했습니다/u);
  assert.match(component, /disabled=\{!aiEnabled \|\| !selectedEntry/u);
  assert.match(component, /이 학급은 관리자가 AI 이미지 생성을 꺼 두었습니다/u);
  assert.match(page, /subscribeClassRecords\(\{[\s\S]{0,420}record\.id === aiClassId/u);
  assert.match(page, /aiClassAccess\.classId === aiClassId/u);
  assert.match(page, /setAiClassAccess\(\{ classId: aiClassId, enabled: false \}\)/u);
  assert.match(page, /<AiImageGenerator[\s\S]{0,180}aiEnabled=\{aiEnabled\}/u);
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

test("provides an accessible device-history dialog and one-line source carousel", async () => {
  const { component, css } = await sources();
  assert.match(component, /role="status"\s+aria-live="polite"/u);
  assert.match(component, /className=\{styles\.generationError\}\s+role="alert"/u);
  assert.match(component, /갤러리에 저장/u);
  assert.match(component, /PNG 다운로드/u);
  assert.match(component, /galleryEntries\.map\(\(entry, index\)/u);
  assert.match(component, /\$\{index \+ 1\}번째 사진/u);
  assert.match(component, /aria-labelledby=\{resultTitleId\}/u);
  assert.match(component, /<h4 id=\{resultTitleId\}>AI 생성<\/h4>/u);
  assert.match(component, /aria-haspopup="dialog"/u);
  assert.match(component, /role="dialog"[\s\S]{0,100}aria-modal="true"/u);
  assert.match(component, /아직 갤러리에 저장하지 않은 결과만 이 기기에 보관됩니다/u);
  assert.match(component, /showHistoryItem\(item\)/u);
  assert.match(component, /생성 기록 닫기/u);
  assert.match(component, /historyDialogRef\.current/u);
  assert.match(component, /event\.key !== "Tab"/u);
  assert.match(component, /last\.focus\(\)/u);
  assert.match(component, /first\.focus\(\)/u);
  assert.match(css, /\.sourceGrid\s*\{[\s\S]{0,220}display:\s*flex[\s\S]{0,220}overflow-x:\s*auto/u);
  assert.match(css, /scroll-snap-type:\s*x mandatory/u);
  assert.match(css, /\.sourceButton\s*\{[\s\S]{0,180}flex:\s*0 0/u);
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
