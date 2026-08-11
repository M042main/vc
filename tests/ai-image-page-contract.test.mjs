import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageUrl = new URL("../app/page.tsx", import.meta.url);

test("adds a lazy AI image workspace directly beside the online gallery", async () => {
  const page = await readFile(pageUrl, "utf8");

  assert.match(page, /type WorkspaceMode = "studio" \| "creator" \| "gallery" \| "ai"/u);
  assert.match(page, /const AiImageGenerator = lazy/u);
  assert.match(page, /import\("\.\/components\/AiImageGenerator"\)/u);
  assert.match(
    page,
    /온라인 갤러리[\s\S]{0,900}className=\{mode === "ai" \? "is-active" : ""\}[\s\S]{0,300}AI 이미지 생성/u,
  );
  assert.match(
    page,
    /<AiImageGenerator[\s\S]{0,120}key=\{characterArtworkKey\}[\s\S]{0,120}profile=\{profile\}[\s\S]{0,160}onBusyChange=\{setAiImageBusy\}[\s\S]{0,80}\/>/u,
  );
  assert.match(page, /const pageBusy = characterLibraryBusy \|\| aiImageBusy/u);
});

test("never exposes a Gemini API credential through the client page", async () => {
  const page = await readFile(pageUrl, "utf8");

  assert.doesNotMatch(page, /AIza[0-9A-Za-z_-]+/u);
  assert.doesNotMatch(page, /GEMINI_API_KEY|x-goog-api-key/u);
});
