import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const studioUrl = new URL("../app/components/VrmStudio.tsx", import.meta.url);
const cssUrl = new URL("../app/components/VrmStudio.module.css", import.meta.url);
const pageUrl = new URL("../app/page.tsx", import.meta.url);

async function sources() {
  return Promise.all([readFile(studioUrl, "utf8"), readFile(cssUrl, "utf8")]);
}

function blockFrom(source, marker, length = 2_800) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing source marker: ${marker}`);
  return source.slice(start, start + length);
}

test("exposes a bounded, backwards-compatible character selection API", async () => {
  const [studio] = await sources();

  assert.match(
    studio,
    /export\s+type\s+VrmStudioCreatedCharacter\s*=\s*\{[\s\S]{0,180}id:\s*string;[\s\S]{0,120}name:\s*string;[\s\S]{0,120}artwork:\s*string;/u,
  );
  assert.match(
    studio,
    /export\s+interface\s+VrmStudioProps\s*\{[\s\S]{0,700}artwork\?:\s*string\s*\|\s*null;[\s\S]{0,220}createdCharacters\?:\s*readonly\s+VrmStudioCreatedCharacter\[\];[\s\S]{0,220}activeCreatedCharacterId\?:\s*string\s*\|\s*null;[\s\S]{0,220}onSelectCreatedCharacter\?:\s*\(id:\s*string\)\s*=>\s*void;[\s\S]{0,160}onSelectVrm\?:\s*\(\)\s*=>\s*void;/u,
  );
  assert.match(studio, /MAX_CREATED_CHARACTER_OPTIONS\s*=\s*3/u);
  assert.match(
    studio,
    /for\s*\(const\s+character\s+of\s+createdCharacters\s*\?\?\s*\[\]\)[\s\S]{0,600}options\.length\s*===\s*MAX_CREATED_CHARACTER_OPTIONS[\s\S]{0,40}break/u,
  );
  assert.match(
    studio,
    /if\s*\(options\.length\s*>\s*0\s*\|\|\s*!artwork\)\s*return\s+options;[\s\S]{0,240}LEGACY_ARTWORK_ID[\s\S]{0,160}artwork/u,
    "the original single artwork prop must remain a usable fallback",
  );
});

test("renders the loaded VRM and up to three drawings as accessible selector cards", async () => {
  const [studio, css] = await sources();
  const selector = blockFrom(
    studio,
    '<div className={styles.characterChoices}',
    3_600,
  );

  assert.match(selector, /role="group"\s+aria-label="무대 캐릭터 선택"/u);
  assert.match(selector, /\{vrmAvailable\s*\?\s*\(/u);
  assert.match(selector, /aria-pressed=\{modelReady\}/u);
  assert.match(selector, /onClick=\{\(\)\s*=>\s*void\s+selectVrmCharacter\(\)\}/u);
  assert.match(selector, /selectableCreatedCharacters\.map\s*\(\(character\)/u);
  assert.match(selector, /aria-pressed=\{selected\}/u);
  assert.match(selector, /onClick=\{\(\)\s*=>\s*void\s+selectCreatedCharacter\(character\)\}/u);
  assert.match(selector, /<img\s+src=\{character\.artwork\}\s+alt=""/u);

  assert.match(css, /\.characterChoices\s*\{[\s\S]{0,180}grid-template-columns:\s*repeat\(2,/u);
  assert.match(css, /\.characterChoice\s*\{[\s\S]{0,220}min-height:\s*118px/u);
  assert.match(css, /\.characterChoice\[data-selected="true"\]/u);
  assert.match(css, /\.characterChoice:disabled/u);
});

test("switches both directions without discarding the in-memory or persisted VRM", async () => {
  const [studio] = await sources();
  const selectDrawing = blockFrom(studio, "const selectCreatedCharacter", 2_100);
  const selectVrm = blockFrom(studio, "const selectVrmCharacter", 1_700);

  for (const selection of [selectDrawing, selectVrm]) {
    assert.match(selection, /recordingBusyRef\.current/u);
    assert.match(selection, /await\s+exitStagePictureInPicture\(\)/u);
    assert.match(selection, /characterSelectionSessionRef\.current/u);
    assert.match(selection, /stopVrmAnimation\(\)/u);
    assert.doesNotMatch(selection, /disposeVrm|clearPersistedVrmFile|stopTracking/u);
  }

  assert.match(selectDrawing, /setSelectedCreatedCharacterId\(character\.id\)/u);
  assert.match(selectDrawing, /setPreferVrm\(false\)/u);
  assert.match(selectDrawing, /onSelectCreatedCharacter\?\.\(character\.id\)/u);
  assert.match(selectVrm, /!vrmAvailable\s*\|\|\s*!vrmRef\.current/u);
  assert.match(selectVrm, /setSelectedCreatedCharacterId\(null\)/u);
  assert.match(selectVrm, /setPreferVrm\(true\)/u);
  assert.match(selectVrm, /onSelectVrm\?\.\(\)/u);
});

test("keeps newer drawing selection ahead of stale VRM restoration and all live outputs", async () => {
  const [studio] = await sources();
  const modelLoad = blockFrom(studio, "const handleModelFile", 6_500);

  assert.match(modelLoad, /options\.restored[\s\S]{0,180}characterSelectionSessionRef\.current/u);
  assert.match(modelLoad, /controlledCreatedCharacterIdRef\.current/u);
  assert.match(
    modelLoad,
    /shouldActivateVrm\s*=\s*[\s\S]{0,160}selectionIsCurrent[\s\S]{0,160}!options\.restored\s*\|\|\s*controlledCharacterId\s*==\s*null/u,
  );
  assert.match(modelLoad, /savePersistedVrmFile\(file\)/u);

  assert.match(studio, /const\s+activeArtwork\s*=\s*selectedCreatedCharacter\?\.artwork\s*\?\?\s*null/u);
  assert.match(studio, /paperDollActive\s*&&\s*activeArtwork/u);
  assert.match(studio, /<PaperDollStage[\s\S]{0,180}artwork=\{activeArtwork\}/u);
  assert.match(studio, /paperDollActiveRef\.current/u);
  assert.match(studio, /captureVrmFullBodyPng/u);
  assert.match(studio, /const\s+canvas\s*=\s*paperDollActive[\s\S]{0,180}rendererRef\.current\?\.domElement/u);
});

test("keeps stage selection controlled without clearing the editor selection for VRM", async () => {
  const page = await readFile(pageUrl, "utf8");
  assert.match(
    page,
    /const\s*\[stageCharacterId,\s*setStageCharacterId\]\s*=\s*useState<string\s*\|\s*null>\(null\)/u,
  );
  assert.match(
    page,
    /<VrmStudio[\s\S]{0,420}createdCharacters=\{savedCharacters\}[\s\S]{0,180}activeCreatedCharacterId=\{stageCharacterId\}[\s\S]{0,160}onSelectCreatedCharacter=\{selectCreatedCharacter\}[\s\S]{0,160}onSelectVrm=\{\(\)\s*=>\s*setStageCharacterId\(null\)\}/u,
  );
  assert.match(
    page,
    /<SavedCharacterLibrary[\s\S]{0,260}activeId=\{activeCharacterId\}/u,
    "VRM stage selection must not erase which drawing the editor library owns",
  );
  assert.doesNotMatch(
    page,
    /onSelectVrm=\{\(\)\s*=>\s*\{?[\s\S]{0,120}setActiveCharacterId\(null\)/u,
  );
});
