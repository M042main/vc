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

test("server-renders the Motion Ink studio", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /MOTION INK/);
  assert.match(html, /트래킹 스튜디오/);
  assert.match(html, /캐릭터 만들기/);
  assert.match(html, /VRM/);
  assert.doesNotMatch(html, /trust-strip|서비스 특징|영상은 기기 안에서만/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("ships the two interactive creation surfaces and removes the starter", async () => {
  const [page, studio, creator, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/VrmStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/CharacterCreator.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<VrmStudio/);
  assert.match(page, /<CharacterCreator/);
  assert.match(studio, /captureVrmFullBodyPng/);
  assert.match(studio, /createHolisticTrackingWorker/);
  assert.match(creator, /onSendToStudio/);
  assert.doesNotMatch(page, /trust-strip|ShieldCheck/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  await assert.rejects(
    access(new URL("../app/_sites-preview/SkeletonPreview.tsx", templateRoot)),
  );
});
