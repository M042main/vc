import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Virtual Creator studio", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /VIRTUAL CREATOR/);
  assert.match(html, /트래킹 스튜디오/);
  assert.match(html, /캐릭터 만들기/);
  assert.match(html, /온라인 갤러리/);
  assert.match(html, /VRM/);
  assert.doesNotMatch(
    html,
    /MOTION INK|trust-strip|서비스 특징|영상은 기기 안에서만|Kalidoface 3D와|카메라 사용에는 HTTPS|<footer/i,
  );
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("ships the two interactive creation surfaces and removes the starter", async () => {
  const [page, layout, studio, creator, gallery, firebaseGallery, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/VrmStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/CharacterCreator.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/OnlineGallery.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/firebaseGallery.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<VrmStudio/);
  assert.match(page, /<CharacterCreator/);
  assert.match(page, /<OnlineGallery/);
  assert.match(page, /onCaptureReady=\{handleCaptureReady\}/);
  assert.match(page, /handleCaptureReady[\s\S]{0,1200}publishGalleryEntry\s*\(/);
  assert.match(page, /isAdmin=\{adminMode\}/);
  assert.match(page, /ADMIN_ID\s*=\s*"m042"/);
  assert.match(page, /VIRTUAL CREATOR/);
  assert.doesNotMatch(page, /MOTION INK|<footer|Kalidoface 3D와|카메라 사용에는 HTTPS/i);
  assert.match(layout, /Virtual Creator/);
  assert.doesNotMatch(layout, /MOTION INK/);
  assert.match(studio, /captureVrmFullBodyPng/);
  assert.match(studio, /createHolisticTrackingWorker/);
  assert.match(creator, /onSendToStudio/);
  assert.doesNotMatch(gallery, /publishGalleryEntry/);
  assert.match(firebaseGallery, /publishGalleryEntry/);
  assert.match(gallery, /document\.cookie/);
  assert.match(firebaseGallery, /motion_ink_gallery_a7f3c9/);
  assert.match(packageJson, /"firebase":\s*"11\.6\.1"/);
  assert.doesNotMatch(page, /trust-strip/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  await assert.rejects(
    access(new URL("../app/_sites-preview/SkeletonPreview.tsx", templateRoot)),
  );
});
