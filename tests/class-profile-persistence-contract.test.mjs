import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const basePath = "/000000/박근석_t7/motion_ink_gallery_a7f3c9";
const files = {
  firebase: new URL("../app/lib/firebaseGallery.ts", import.meta.url),
  profile: new URL("../app/lib/visitorProfile.ts", import.meta.url),
  onboarding: new URL("../app/components/ClassOnboarding.tsx", import.meta.url),
  onboardingCss: new URL(
    "../app/components/ClassOnboarding.module.css",
    import.meta.url,
  ),
  globals: new URL("../app/globals.css", import.meta.url),
  gallery: new URL("../app/components/OnlineGallery.tsx", import.meta.url),
  page: new URL("../app/page.tsx", import.meta.url),
  classesRoute: new URL("../app/api/gallery/classes/route.ts", import.meta.url),
};

async function sources() {
  const entries = await Promise.all(
    Object.entries(files).map(async ([key, url]) => [key, await readFile(url, "utf8")]),
  );
  return Object.fromEntries(entries);
}

test("keeps classes, gallery entries, and artwork inside the assigned Firebase room", async () => {
  const { firebase, classesRoute } = await sources();
  assert.match(firebase, new RegExp(basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(firebase, /GALLERY_CLASSES_PATH\s*=\s*`\$\{GALLERY_DATABASE_PATH\}\/classes`/);
  assert.match(firebase, /GALLERY_ARTWORKS_PATH\s*=\s*`\$\{GALLERY_DATABASE_PATH\}\/artworks`/);
  assert.match(classesRoute, new RegExp(`${basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/classes`));
  assert.doesNotMatch(classesRoute, /\/entries|\/artworks/);
});

test("keeps class create and delete behind exact Sites-email authorization", async () => {
  const { firebase, classesRoute } = await sources();
  assert.match(classesRoute, /oai-authenticated-user-email/);
  assert.match(classesRoute, /ADMIN_EMAIL\s*=\s*["']m042@m042\.kr["']/);
  assert.match(classesRoute, /export\s+async\s+function\s+POST/);
  assert.match(classesRoute, /export\s+async\s+function\s+DELETE/);
  assert.match(classesRoute, /if\s*\(\s*!isAdmin\s*\(request\)\s*\)[\s\S]{0,100}403/g);
  assert.match(classesRoute, /FIREBASE_PUSH_KEY_PATTERN/);
  assert.match(
    classesRoute,
    /`\$\{GALLERY_CLASSES_PATH\}\/\$\{id\}\.json`[\s\S]{0,420}method:\s*["']DELETE["']/,
  );
  assert.match(firebase, /classManagementRequest[\s\S]{0,900}fetch\s*\(\s*GALLERY_CLASSES_API_PATH/);
  assert.match(firebase, /createClassRecord[\s\S]{0,500}classManagementRequest\s*\(\s*["']POST["']/);
  assert.match(firebase, /deleteClassRecord[\s\S]{0,300}classManagementRequest\s*\(\s*["']DELETE["']/);
  assert.match(firebase, /export\s+class\s+GalleryServiceError[\s\S]{0,500}retryable/);
  assert.doesNotMatch(firebase, /remove\s*\(/);
});

test("persists a validated visitor profile locally and makes guest mode read-only", async () => {
  const { profile, firebase, onboarding } = await sources();
  assert.match(profile, /export\s+type\s+VisitorProfile[\s\S]{0,180}name:[\s\S]*classId:[\s\S]*className:[\s\S]*guest:/);
  assert.match(profile, /window\.localStorage\.setItem\s*\(\s*PROFILE_STORAGE_KEY/);
  assert.match(profile, /document\.cookie[\s\S]{0,180}SameSite=Lax/);
  assert.match(profile, /loadVisitorProfile/);
  assert.match(firebase, /activeProfile\.guest[\s\S]{0,180}게스트는 온라인 갤러리에 저장할 수 없습니다/);
  assert.match(firebase, /activeProfile\.guest[\s\S]{0,180}게스트는 클라우드 작품 저장을 사용할 수 없습니다/);
  assert.match(onboarding, /게스트는 트래킹과 다운로드를 체험할 수 있지만 갤러리·작품 클라우드/);
});

test("stores class metadata while keeping legacy gallery records readable and filterable", async () => {
  const { firebase, gallery } = await sources();
  assert.match(firebase, /classId:\s*string\s*\|\s*null/);
  assert.match(firebase, /className:\s*string\s*\|\s*null/);
  assert.match(firebase, /hasClassMetadata[\s\S]{0,500}classId:[\s\S]{0,180}:\s*null[\s\S]{0,180}className:[\s\S]{0,180}:\s*null/);
  assert.match(firebase, /classId:\s*activeProfile\.classId/);
  assert.match(firebase, /requireActiveClass\s*\(\s*activeProfile\s*\)/g);
  assert.match(firebase, /className:\s*activeClass\.name/g);
  assert.match(gallery, /subscribeClassRecords\s*\(/);
  assert.match(gallery, /return\s*\(\)\s*=>\s*\{[\s\S]{0,160}unsubscribe\s*\(\)/);
  assert.match(gallery, /activeClassIds\s*=\s*useMemo/);
  assert.match(gallery, /effectiveClassFilter\s*===\s*["']all["']/);
  assert.match(gallery, /effectiveClassFilter\s*===\s*["']unclassified["']/);
  assert.match(gallery, /!entry\.classId\s*\|\|\s*!activeClassIds\.has\s*\(\s*entry\.classId\s*\)/);
  assert.match(gallery, /visibleEntries\.map\s*\(/);
  assert.match(gallery, /profile\.guest[\s\S]{0,220}게스트는 로컬 체험만 가능/);
  assert.match(gallery, /profile\?\.guest[\s\S]{0,320}온라인\s*갤러리 업로드와 좋아요/);
});

test("uses deterministic class-plus-normalized-name keys and bounded PNG validation for artwork", async () => {
  const { profile, firebase } = await sources();
  assert.match(profile, /visitorArtworkKey/);
  assert.match(profile, /TextEncoder\s*\(\)[\s\S]{0,350}`\$\{validated\.classId\}_\$\{encodedName\}`/);
  assert.match(firebase, /saveLatestCharacterArtwork/);
  assert.match(firebase, /loadLatestCharacterArtwork/);
  assert.match(firebase, /visitorArtworkKey\s*\(\s*activeProfile\s*\)/g);
  assert.match(firebase, /imageDataUrl:\s*validatePngDataUrl\s*\(\s*imageDataUrl\s*\)/);
  assert.match(firebase, /MAX_PNG_DATA_URL_SIZE/);
  assert.match(firebase, /GALLERY_ARTWORK_PATH\s*=\s*`\$\{GALLERY_ARTWORKS_PATH\}\/\$\{key\}`/g);
});

test("provides a blocking, accessible first-run gate and inline admin class management", async () => {
  const { onboarding } = await sources();
  assert.match(onboarding, /blocking\?:\s*boolean/);
  assert.match(onboarding, /isBlocking\s*=\s*blocking\s*&&\s*profileReady\s*&&\s*!profile/);
  assert.match(onboarding, /role=\{isBlocking\s*\?\s*["']dialog["']/);
  assert.match(onboarding, /aria-modal=\{isBlocking\s*\?\s*true/);
  assert.match(onboarding, /nameInputRef\.current\?\.focus\s*\(\)/);
  assert.match(onboarding, /event\.key\s*===\s*["']Escape["'][\s\S]{0,100}preventDefault/);
  assert.match(onboarding, /event\.key\s*!==\s*["']Tab["']/);
  assert.match(onboarding, /const\s*\[classesLoadedSuccessfully,\s*setClassesLoadedSuccessfully\][\s\S]{0,80}useState\(false\)/);
  assert.match(onboarding, /onData:\s*\(nextClasses\)[\s\S]{0,220}setClassesLoadedSuccessfully\(true\)/);
  assert.doesNotMatch(onboarding, /onError:\s*\(error\)[\s\S]{0,220}setClassesLoadedSuccessfully\(true\)/);
  assert.match(onboarding, /if\s*\([\s\S]{0,80}!classesLoadedSuccessfully[\s\S]{0,180}!profile\.classId[\s\S]{0,80}\)\s*return/);
  assert.match(onboarding, /blockingModalControl\?:\s*ReactNode/);
  assert.match(onboarding, /aria-modal=\{isBlocking\s*\?\s*true[\s\S]{0,100}\{isBlocking\s*\?\s*blockingModalControl\s*:\s*null\}/);
  assert.doesNotMatch(onboarding, /onAdminRequest|adminRequestButton|관리자 설정/);
  assert.doesNotMatch(onboarding, /type=["']radio["']|name=["']profile-mode["']|profileMode/);
  assert.match(onboarding, /onSubmit=\{submitClassProfile\}/);
  assert.match(onboarding, /학급으로 시작하기/);
  assert.match(onboarding, /className=\{styles\.guestExperience\}[\s\S]{0,700}type=["']button["'][\s\S]{0,200}aria-describedby=["']guest-experience-note["'][\s\S]{0,200}onClick=\{\(\)\s*=>\s*saveProfile\(true\)\}[\s\S]{0,200}게스트로 체험하기/);
  assert.match(onboarding, /!isBlocking\s*\|\|\s*!isAdmin[\s\S]{0,180}newClassInputRef\.current\?\.focus\s*\(\)/);
  assert.match(onboarding, /\{isAdmin\s*\?\s*\([\s\S]{0,500}학급 관리/);
});

test("wires the active profile through onboarding, artwork restore, creator save, and gallery", async () => {
  const { page } = await sources();
  assert.match(page, /useVisitorProfile\s*\(\s*\)/);
  assert.match(page, /const\s+profileGateBlocking\s*=\s*!profile\s*&&\s*profileReady/);
  assert.match(page, /blocking=\{profileGateBlocking\}/);
  assert.match(page, /onProfileChange=\{[A-Za-z_$][A-Za-z0-9_$]*\}/);
  assert.match(page, /loadSavedCharacterSlots\(profile\)/);
  assert.match(page, /saveCharacterSlot\(profile,\s*slotId,\s*dataUrl\)/);
  assert.match(page, /characterArtworkOwnerKey\s*===\s*characterArtworkKey/);
  assert.match(page, /initialArtwork=\{activeCharacterArtwork\}/);
  assert.match(page, /initialArtworkKey=\{characterEditorKey\}/);
  assert.match(page, /<OnlineGallery[\s\S]{0,400}profile=\{profile\}/);
});

test("moves the active student profile into accessible header actions", async () => {
  const { onboarding, onboardingCss, globals, page } = await sources();
  const profileActions = onboarding.slice(
    onboarding.indexOf("export function VisitorProfileActions"),
    onboarding.indexOf("export interface ClassOnboardingProps"),
  );

  assert.match(page, /<div className=["']header-actions["']>[\s\S]{0,500}<VisitorProfileActions/);
  assert.match(page, /<VisitorProfileActions[\s\S]{0,180}profile=\{profile\}[\s\S]{0,180}onProfileChange=\{[A-Za-z_$][A-Za-z0-9_$]*\}/);
  assert.match(page, /\{profileReady\s*&&\s*!profile\s*\?\s*\([\s\S]{0,120}<ClassOnboarding/);
  assert.doesNotMatch(page, /className=["']profile-shell["']/);
  assert.match(
    page,
    /<div className=["']header-actions["']>[\s\S]{0,900}!profileGateBlocking[\s\S]{0,100}renderAdminAccessButton/,
  );
  assert.match(page, /blockingModalControl=\{renderAdminAccessButton\(true\)\}/);

  assert.match(profileActions, /profile\.className/);
  assert.match(profileActions, /profile\.name/);
  assert.match(profileActions, /aria-haspopup=["']dialog["']/);
  assert.match(profileActions, /role=["']dialog["'][\s\S]{0,100}aria-modal=["']true["']/);
  assert.match(profileActions, /aria-labelledby=\{titleId\}/);
  assert.match(profileActions, /inputRef\.current\?\.focus\(\)[\s\S]{0,80}select\(\)/);
  assert.match(profileActions, /event\.key\s*===\s*["']Escape["'][\s\S]{0,120}closeDialog\(\)/);
  assert.match(profileActions, /event\.key\s*!==\s*["']Tab["']/);
  assert.match(profileActions, /triggerRef\.current\?\.focus\(\)/);

  assert.match(profileActions, /createVisitorProfile\(\{\s*\.\.\.profile,\s*name:\s*nameDraft\s*\}\)/);
  assert.doesNotMatch(profileActions, /<select|classIdDraft|setClassIdDraft/);
  assert.match(profileActions, /onProfileChange\(null\)/);
  assert.match(profileActions, /학생 로그아웃/);
  assert.match(profileActions, /aria-label=["']학생 프로필 로그아웃["']/);

  assert.match(onboarding, /\{!profile\s*&&\s*!adminOnly\s*\?\s*\(/);
  assert.match(page, /adminOnly[\s\S]{0,100}onProfileChange=\{[A-Za-z_$][A-Za-z0-9_$]*\}/);
  assert.match(onboarding, /if\s*\(\s*!currentClass\s*\)[\s\S]{0,80}setProfile\(null\)/);
  assert.match(onboarding, /onError:\s*\(\)\s*=>\s*undefined/);

  assert.match(globals, /\.header-actions\s*\{[\s\S]{0,200}justify-self:\s*end/);
  assert.match(globals, /\.admin-access-button\[data-gate-control=["']true["']\]/);
  assert.match(onboardingCss, /@media\s*\(max-width:\s*620px\)[\s\S]*\.profileIdentity/);
  assert.match(onboardingCss, /\.profileDialogBackdrop[\s\S]{0,100}position:\s*fixed/);
});
