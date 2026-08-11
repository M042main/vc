import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const studioUrl = new URL("../app/components/VrmStudio.tsx", import.meta.url);
const studioCssUrl = new URL(
  "../app/components/VrmStudio.module.css",
  import.meta.url,
);

test("removes technical tracking and export info panels without removing save actions", async () => {
  const [studio, css] = await Promise.all([
    readFile(studioUrl, "utf8"),
    readFile(studioCssUrl, "utf8"),
  ]);

  assert.doesNotMatch(studio, />Tracking health</);
  assert.doesNotMatch(studio, />ENGINE</);
  assert.doesNotMatch(studio, />INFERENCE</);
  assert.doesNotMatch(studio, />Export</);
  assert.doesNotMatch(studio, />SIZE</);
  assert.doesNotMatch(studio, />FORMAT</);
  assert.doesNotMatch(studio, /styles\.metrics|styles\.metric|styles\.exportNote/);
  assert.doesNotMatch(css, /\.metrics\b|\.metric\b|\.exportNote\b/);

  assert.doesNotMatch(studio, /\bsetDelegate\b|\bsetInferenceMs\b|\blastStatsRef\b/);
  assert.match(studio, /전신 PNG 자동 저장/);
  assert.match(studio, /애니메이션 WebM 저장/);
  assert.match(studio, /현재 포즈는 PNG로, 선택한 움직임은 WebM으로 저장할 수 있어요\./);
  assert.match(studio, /paperDoll\.capturePng\(1600, 2000\)/);
  assert.match(studio, /new\s+MediaRecorder\s*\(/);
});
