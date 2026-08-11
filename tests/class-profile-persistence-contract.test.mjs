import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const basePath = "/000000/박근석_t7/motion_ink_gallery_a7f3c9";
const files = {
  firebase: new URL("../app/lib/firebaseGallery.ts", import.meta.url),
  profile: new URL("../app/lib/visitorProfile.ts", import.meta.url),
  onboarding: new URL("../app/components/ClassOnboarding.tsx", import.meta.url),
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
  assert.match(firebase, /createClassRecord[\s\S]{0,900}fetch\s*\(\s*GALLERY_CLASSES_API_PATH/);
  assert.match(firebase, /deleteClassRecord[\s\S]{0,700}fetch\s*\(\s*GALLERY_CLASSES_API_PATH/);
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
  assert.match(gallery, /profile\.guest[\s\S]{0,180}게스트는 온라인 갤러리에 저장할 수 없습니다/);
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
  assert.match(onboarding, /onAdminRequest\?:\s*\(\)\s*=>\s*void/);
  assert.match(onboarding, /관리자 설정/);
  assert.match(onboarding, /!isBlocking\s*\|\|\s*!isAdmin[\s\S]{0,180}newClassInputRef\.current\?\.focus\s*\(\)/);
  assert.match(onboarding, /\{isAdmin\s*\?\s*\([\s\S]{0,500}학급 관리/);
});

test("wires the active profile through onboarding, artwork restore, creator save, and gallery", async () => {
  const { page } = await sources();
  assert.match(page, /useVisitorProfile\s*\(\s*\)/);
  assert.match(page, /blocking=\{!profile\s*&&\s*profileReady\}/);
  assert.match(page, /onProfileChange=\{setProfile\}/);
  assert.match(page, /loadLatestCharacterArtwork\(profile\)/);
  assert.match(page, /saveLatestCharacterArtwork\(profile,\s*dataUrl\)/);
  assert.match(page, /characterArtworkOwnerKey\s*===\s*characterArtworkKey/);
  assert.match(page, /initialArtwork=\{activeCharacterArtwork\}/);
  assert.match(page, /initialArtworkKey=\{characterArtworkKey\}/);
  assert.match(page, /<OnlineGallery[\s\S]{0,400}profile=\{profile\}/);
});
