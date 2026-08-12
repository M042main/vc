import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageUrl = new URL("../app/page.tsx", import.meta.url);
const onboardingUrl = new URL(
  "../app/components/ClassOnboarding.tsx",
  import.meta.url,
);
const galleryUrl = new URL(
  "../app/components/OnlineGallery.tsx",
  import.meta.url,
);

test("administrator login uses a synthetic all-classes header profile without replacing the student profile", async () => {
  const page = await readFile(pageUrl, "utf8");

  assert.match(
    page,
    /const ADMINISTRATOR_UI_PROFILE:[\s\S]{0,180}name:\s*["']관리자["'][\s\S]{0,100}classId:\s*null[\s\S]{0,100}className:\s*["']전체["']/u,
  );
  assert.match(
    page,
    /const headerProfile\s*=\s*adminMode\s*\?\s*ADMINISTRATOR_UI_PROFILE\s*:\s*profile/u,
  );
  assert.match(
    page,
    /<VisitorProfileActions[\s\S]{0,180}profile=\{headerProfile\}[\s\S]{0,180}administratorView=\{adminMode\}/u,
  );
  assert.match(
    page,
    /<OnlineGallery[\s\S]{0,160}isAdmin=\{adminMode\}[\s\S]{0,120}profile=\{adminMode\s*\?\s*null\s*:\s*profile\}/u,
  );

  const enterStart = page.indexOf("const enterAdminMode");
  const leaveStart = page.indexOf("const leaveAdminMode", enterStart);
  const enterAdminMode = page.slice(enterStart, leaveStart);
  assert.doesNotMatch(enterAdminMode, /setProfile\s*\(/u);
});

test("administrator session bypasses onboarding and opens the all-class gallery", async () => {
  const page = await readFile(pageUrl, "utf8");

  assert.match(
    page,
    /const profileGateBlocking\s*=\s*!adminMode\s*&&\s*!profile\s*&&\s*profileReady/u,
  );
  assert.match(
    page,
    /\{profileReady\s*&&\s*!profile\s*&&\s*!adminMode\s*\?\s*\([\s\S]{0,100}<ClassOnboarding/u,
  );
  assert.match(
    page,
    /const authenticated\s*=\s*response\.ok\s*&&\s*payload\.authenticated\s*===\s*true;[\s\S]{0,120}if\s*\(authenticated\)\s*setMode\(["']gallery["']\)/u,
  );
});

test("administrator header is read-only and gallery resets to every class", async () => {
  const [page, onboarding, gallery] = await Promise.all([
    readFile(pageUrl, "utf8"),
    readFile(onboardingUrl, "utf8"),
    readFile(galleryUrl, "utf8"),
  ]);

  assert.match(onboarding, /administratorView\?:\s*boolean/u);
  assert.match(
    onboarding,
    /aria-label=\{administratorView\s*\?\s*["']관리자 프로필["']\s*:\s*["']학생 프로필["']\}/u,
  );
  assert.match(onboarding, /\{!administratorView\s*\?\s*\([\s\S]{0,700}학생 로그아웃/u);
  assert.match(
    gallery,
    /if\s*\(!isAdmin\)\s*return;[\s\S]{0,140}setClassFilter\(["']all["']\);[\s\S]{0,80}setCurrentPage\(1\)/u,
  );
  assert.match(
    page,
    /관리자 모드 종료[\s\S]{0,220}adminError[\s\S]{0,160}role=["']alert["']/u,
  );
});
