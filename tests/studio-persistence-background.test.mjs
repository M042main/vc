import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const persistenceUrl = new URL("../app/lib/studioPersistence.ts", import.meta.url);
const studioUrl = new URL("../app/components/VrmStudio.tsx", import.meta.url);
const paperDollUrl = new URL("../app/components/PaperDollStage.tsx", import.meta.url);
const vrmCaptureUrl = new URL("../app/lib/vrmCapture.ts", import.meta.url);

test("persists VRM, background blobs, and stage settings only on the local device", async () => {
  const source = await readFile(persistenceUrl, "utf8");

  assert.match(source, /\b(?:indexedDB|factory)\.open\s*\(/);
  assert.match(source, /createObjectStore\s*\([^)]*keyPath:\s*["']key["']/);
  assert.match(source, /key:\s*["']vrm["'][\s\S]{0,300}blob:/);
  assert.match(source, /key:\s*["']background["'][\s\S]{0,300}blob:/);
  assert.match(source, /localStorage[\s\S]{0,260}SETTINGS_FALLBACK_KEY/);
  assert.match(source, /QuotaExceededError|NS_ERROR_DOM_QUOTA_REACHED/);
  assert.match(source, /let\s+writeQueue:\s*Promise<void>/);
  assert.match(source, /function\s+queueWrite[\s\S]{0,260}writeQueue\s*=\s*result\.then/);
  assert.match(source, /onblocked[\s\S]{0,80}finish\(null\)/);
  assert.match(source, /setTimeout\([^,]+,\s*1500\)/);
  assert.doesNotMatch(
    source,
    /firebase|databaseURL|getDatabase|firebasedatabase/i,
    "studio drafts must never be written to the shared Firebase gallery",
  );
});

test("validates bounded PNG, JPEG, and WebP photo backgrounds", async () => {
  const source = await readFile(persistenceUrl, "utf8");

  assert.match(source, /image\/png/);
  assert.match(source, /image\/jpeg/);
  assert.match(source, /image\/webp/);
  assert.match(source, /MAX_STAGE_BACKGROUND_BYTES\s*=\s*12\s*\*\s*1024\s*\*\s*1024/);
  assert.match(
    source,
    /file\.size\s*>\s*0[\s\S]{0,140}file\.size\s*<=\s*MAX_STAGE_BACKGROUND_BYTES/,
  );
});

test("restores assets without stale model or background work replacing newer choices", async () => {
  const [studio, persistence] = await Promise.all([
    readFile(studioUrl, "utf8"),
    readFile(persistenceUrl, "utf8"),
  ]);

  assert.match(studio, /loadPersistedStudio\s*\(/);
  assert.match(studio, /modelInteractionRef\.current\s*===\s*modelInteraction/);
  assert.match(
    studio,
    /backgroundLoadSessionRef\.current\s*===\s*backgroundInteraction/,
  );
  assert.match(studio, /modelLoadSessionRef\.current\s*!==\s*loadSession/);
  assert.match(studio, /savePersistedVrmFile\s*\(/);
  assert.match(studio, /savePersistedStageBackground\s*\(/);
  assert.match(studio, /saveStudioSettings\s*\(/);
  assert.match(persistence, /parseSettings|parseBackground|parseVrm/);
});

test("renders one photo background into both live canvases while PNG capture stays transparent", async () => {
  const [studio, paperDoll, capture] = await Promise.all([
    readFile(studioUrl, "utf8"),
    readFile(paperDollUrl, "utf8"),
    readFile(vrmCaptureUrl, "utf8"),
  ]);

  assert.match(studio, /new\s+THREE\.CanvasTexture\s*\(/);
  assert.match(studio, /scene\.background\s*=\s*backgroundTexture/);
  assert.match(studio, /backgroundImage=\{stageBackgroundImage\}/);
  assert.match(studio, /backgroundFit=\{stageBackgroundFit\}/);
  assert.match(
    paperDoll,
    /if\s*\(\s*!captureSafe\s*\)\s*\{[\s\S]{0,300}if\s*\(\s*backgroundImage\s*\)/,
  );
  assert.match(capture, /scene\.background\s*=\s*null/);
  assert.match(capture, /scene\.background\s*=\s*previousBackground/);
  assert.match(studio, /canvas\.captureStream\s*\(\s*30\s*\)/);
});

test("releases photo object URLs and exposes cover/contain controls", async () => {
  const studio = await readFile(studioUrl, "utf8");

  assert.match(studio, /URL\.createObjectURL\s*\(/);
  assert.match(studio, /URL\.revokeObjectURL\s*\(/);
  assert.match(studio, /accept=["']image\/png,image\/jpeg,image\/webp["']/);
  assert.match(studio, /changeStageBackgroundFit\s*\(\s*["']cover["']\s*\)/);
  assert.match(studio, /changeStageBackgroundFit\s*\(\s*["']contain["']\s*\)/);
});
