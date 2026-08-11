import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
  firebase: new URL("../app/lib/firebaseGallery.ts", import.meta.url),
  localLibrary: new URL(
    "../app/lib/profileCharacterLibrary.ts",
    import.meta.url,
  ),
  library: new URL(
    "../app/components/SavedCharacterLibrary.tsx",
    import.meta.url,
  ),
  page: new URL("../app/page.tsx", import.meta.url),
  studio: new URL("../app/components/VrmStudio.tsx", import.meta.url),
};

const PRIVATE_ROOM = "/000000/박근석_t7/motion_ink_gallery_a7f3c9";

async function sources() {
  const entries = await Promise.all(
    Object.entries(files).map(async ([name, url]) => [name, await readFile(url, "utf8")]),
  );
  return Object.fromEntries(entries);
}

function block(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : -1;
  return source.slice(start, end >= 0 ? end : undefined);
}

test("scopes all three cloud slots to the exact isolated artwork owner child", async () => {
  const { firebase } = await sources();
  assert.match(firebase, new RegExp(PRIVATE_ROOM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(
    firebase,
    /GALLERY_ARTWORKS_PATH\s*=\s*`\$\{GALLERY_DATABASE_PATH\}\/artworks`/u,
  );
  assert.match(firebase, /CHARACTER_SLOT_PATTERN\s*=\s*\/\^slot-\[1-3\]\$\/u/u);
  assert.match(firebase, /MAX_SAVED_CHARACTERS\s*=\s*3/u);
  assert.match(
    firebase,
    /type\s+SavedCharacterSlot\s*=\s*SavedCharacterArtwork\s*&\s*\{[\s\S]{0,100}id:\s*`slot-\$\{1\s*\|\s*2\s*\|\s*3\}`/u,
  );

  const save = block(
    firebase,
    "export async function saveCharacterSlot",
    "export async function deleteCharacterSlot",
  );
  assert.match(save, /validateCharacterSlotId\(slotId\)/u);
  assert.match(save, /visitorArtworkKey\(activeProfile\)/u);
  assert.match(
    save,
    /update\(ref\(database,\s*`\$\{GALLERY_ARTWORKS_PATH\}\/\$\{key\}`\),\s*\{[\s\S]{0,180}\[`slots\/\$\{id\}`\]:\s*record/u,
  );
  assert.doesNotMatch(save, /ref\(database,\s*(?:GALLERY_DATABASE_PATH|["']\/?["'])\)/u);

  const remove = block(firebase, "export async function deleteCharacterSlot");
  assert.match(remove, /validateCharacterSlotId\(slotId\)/u);
  assert.match(
    remove,
    /rootRef\s*=\s*ref\(database,\s*`\$\{GALLERY_ARTWORKS_PATH\}\/\$\{key\}`\)/u,
  );
  assert.match(remove, /\[`slots\/\$\{id\}`\]:\s*null/u);
  assert.doesNotMatch(remove, /GALLERY_ENTRIES_PATH|GALLERY_CLASSES_PATH/u);
});

test("loads only validated slot-1 through slot-3 records and preserves legacy slot one", async () => {
  const { firebase } = await sources();
  const parser = block(
    firebase,
    "function slotsFromArtworkRoot",
    "export async function loadSavedCharacterSlots",
  );
  assert.match(parser, /\.slots/u);
  assert.match(parser, /Object\.entries\(slotsValue\)/u);
  assert.match(parser, /validateCharacterSlotId\(id\)/u);
  assert.match(parser, /parseSavedCharacterArtwork\(candidate,\s*activeProfile\)/u);

  const load = block(
    firebase,
    "export async function loadSavedCharacterSlots",
    "export async function saveCharacterSlot",
  );
  assert.match(load, /slots\.slice\(0,\s*MAX_SAVED_CHARACTERS\)/u);
  assert.match(load, /legacy\s*\?\s*\[\{\s*id:\s*["']slot-1["'],\s*\.\.\.legacy\s*\}\]\s*:\s*\[\]/u);
  assert.match(load, /activeProfile\.guest[\s\S]{0,80}return\s*\[\]/u);
});

test("uses deterministic per-profile local IDs and rejects unrelated store records", async () => {
  const { localLibrary } = await sources();
  assert.match(localLibrary, /PROFILE_CHARACTER_LIBRARY_VERSION\s*=\s*["']t-pose-v3["']/u);
  assert.match(localLibrary, /PROFILE_CHARACTER_LIMIT\s*=\s*3/u);
  assert.match(
    localLibrary,
    /SLOT_IDS[\s\S]{0,160}["']slot-1["'][\s\S]{0,80}["']slot-2["'][\s\S]{0,80}["']slot-3["']/u,
  );
  assert.match(
    localLibrary,
    /profileCharacterLibraryPrefix[\s\S]{0,220}PROFILE_CHARACTER_LIBRARY_VERSION[\s\S]{0,100}localProfileKey\(profile\)/u,
  );
  assert.match(
    localLibrary,
    /profileCharacterStorageId[\s\S]{0,180}`\$\{profileCharacterLibraryPrefix\(profile\)\}:\$\{slotId\}`/u,
  );

  const loadLocal = block(
    localLibrary,
    "function slotFromLocalRecord",
    "export function mergeProfileCharacters",
  );
  assert.match(loadLocal, /record\.id\.startsWith\(prefix\)/u);
  assert.match(loadLocal, /SLOT_IDS\.includes/u);
  assert.match(loadLocal, /store\.list\(\)/u);
  assert.match(loadLocal, /\.sort\(\(left,\s*right\)\s*=>\s*left\.id\.localeCompare\(right\.id\)\)/u);

  assert.match(
    localLibrary,
    /nextAvailableCharacterSlot[\s\S]{0,260}SLOT_IDS\.find\(\(id\)\s*=>\s*!used\.has\(id\)\)\s*\?\?\s*null/u,
  );
});

test("merges local and cloud characters by slot, newest timestamp, and the three-slot order", async () => {
  const { localLibrary } = await sources();
  const merge = block(
    localLibrary,
    "export function mergeProfileCharacters",
    "export async function cacheProfileCharacters",
  );
  assert.match(merge, /new\s+Map<ProfileCharacterSlotId,\s*ProfileSavedCharacter>/u);
  assert.match(merge, /for\s*\(const\s+local\s+of\s+localCharacters\)\s*merged\.set\(local\.id,\s*local\)/u);
  assert.match(merge, /local\.updatedAt\s*>\s*cloud\.updatedAt[\s\S]{0,40}continue/u);
  assert.match(merge, /profileCharacterStorageId\(profile,\s*cloud\.id\)/u);
  assert.match(merge, /artwork:\s*cloud\.imageDataUrl/u);
  assert.match(merge, /SLOT_IDS\.flatMap/u);
  assert.match(merge, /\.slice\(0,\s*PROFILE_CHARACTER_LIMIT\)/u);
});

test("renders load, new, maximum-three, and two-step delete library controls", async () => {
  const { library } = await sources();
  assert.match(library, /const\s+MAX_CHARACTERS\s*=\s*3/u);
  assert.match(library, /characters\.length\s*>=\s*MAX_CHARACTERS/u);
  assert.match(library, /characters\.map\(\(character\)/u);
  assert.match(library, /onClick=\{\(\)\s*=>\s*onSelect\(character\.id\)\}/u);
  assert.match(library, /aria-pressed=\{active\}/u);
  assert.match(library, /onClick=\{onCreateNew\}/u);
  assert.match(library, /disabled=\{atLimit\s*\|\|\s*busy\}/u);
  assert.match(library, /\{characters\.length\}\s*\/\s*\{MAX_CHARACTERS\}/u);

  assert.match(library, /deleteCandidate\s*===\s*character\.id/u);
  assert.match(library, /setDeleteCandidate\(character\.id\)/u);
  assert.match(library, /confirmDelete\(character\.id\)/u);
  assert.match(library, /삭제 확인/u);
  assert.match(library, /setDeleteCandidate\(null\)[\s\S]{0,160}취소/u);
  assert.match(library, /await\s+onDelete\(id\)/u);
  assert.match(library, /deleteError[\s\S]{0,100}role=["']alert["']/u);
});

test("restores and migrates the profile library without mixing profile owners", async () => {
  const { page } = await sources();
  const restore = block(page, "useEffect(() => {\n    if (!profileReady)", "useEffect(() => {\n    const timer");
  assert.match(restore, /profileCharacterLibraryPrefix\(profile\)/u);
  assert.match(restore, /loadLocalProfileCharacters\(profile,\s*store\)/u);
  assert.match(restore, /loadSavedCharacterSlots\(profile\)/u);
  assert.match(restore, /mergeProfileCharacters\(profile,\s*localSaved,\s*cloudSaved\)/u);
  assert.match(restore, /profileCharacterStorageId\(profile,\s*["']slot-1["']\)/u);
  assert.match(restore, /cacheProfileCharacters\(profile,\s*restored,\s*store\)/u);
  assert.match(restore, /setSavedCharacters\(restored\)/u);
  assert.match(restore, /setActiveCharacterId\(active\?\.id\s*\?\?\s*null\)/u);
  assert.match(restore, /setStageCharacterId\(active\?\.id\s*\?\?\s*null\)/u);

  const migrate = block(
    page,
    "const handleProfileChange",
    "const selectCreatedCharacter",
  );
  assert.match(migrate, /profile\.classId\s*===\s*nextProfile\.classId/u);
  assert.match(migrate, /profile\.name\s*!==\s*nextProfile\.name/u);
  assert.match(migrate, /savedCharacters\.length\s*>\s*0/u);
  assert.match(migrate, /targetKey:\s*profileCharacterLibraryPrefix\(nextProfile\)/u);
  assert.match(migrate, /characters:\s*savedCharacters/u);
  assert.match(migrate, /activeId:\s*activeCharacterId/u);
  assert.match(migrate, /setProfile\(nextProfile\)/u);
  assert.match(page, /onProfileChange=\{handleProfileChange\}/gu);
});

test("saves into an existing or first empty slot and deletes both local and cloud copies", async () => {
  const { page } = await sources();
  const save = block(page, "const handleSendToStudio", "const profileGateBlocking");
  assert.match(save, /savedCharacters\.find\(\(character\)\s*=>\s*character\.id\s*===\s*activeCharacterId\)\?\.id/u);
  assert.match(save, /nextAvailableCharacterSlot\(savedCharacters\)/u);
  assert.match(save, /캐릭터는 3개까지 저장/u);
  assert.match(save, /profileCharacterStorageId\(profile,\s*slotId\)/u);
  assert.match(save, /characterStoreRef\.current[\s\S]{0,260}\.save\(\{/u);
  assert.match(save, /saveCharacterSlot\(profile,\s*slotId,\s*dataUrl\)/u);
  assert.match(save, /current\.filter\(\(character\)\s*=>\s*character\.id\s*!==\s*slotId\)/u);
  assert.match(save, /setActiveCharacterId\(slotId\)/u);
  assert.match(save, /setStageCharacterId\(slotId\)/u);

  const remove = block(
    page,
    "const deleteSavedCharacter",
    "const handleSendToStudio",
  );
  assert.match(remove, /store\.remove\(character\.storageId\)/u);
  assert.match(remove, /profile\.guest[\s\S]{0,100}deleteCharacterSlot\(profile,\s*character\.id\)/u);
  assert.match(remove, /await\s+Promise\.all\(\[localDelete,\s*cloudDelete\]\)/u);
  assert.match(remove, /savedCharacters\.filter\(\(item\)\s*=>\s*item\.id\s*!==\s*id\)/u);
  assert.match(remove, /setActiveCharacterId\(next\?\.id\s*\?\?\s*null\)/u);
  assert.match(remove, /setStageCharacterId\(remaining\[0\]\?\.id\s*\?\?\s*null\)/u);
});

test("wires the library, editor, and studio to the same active three-character state", async () => {
  const { library, page, studio } = await sources();
  assert.match(
    page,
    /<SavedCharacterLibrary[\s\S]{0,360}characters=\{savedCharacters\}[\s\S]{0,120}activeId=\{activeCharacterId\}[\s\S]{0,120}onSelect=\{selectCreatedCharacter\}[\s\S]{0,120}onCreateNew=\{createNewCharacter\}[\s\S]{0,120}onDelete=\{deleteSavedCharacter\}/u,
  );
  assert.match(
    page,
    /<CharacterCreator[\s\S]{0,260}initialArtwork=\{activeCharacterArtwork\}[\s\S]{0,160}initialArtworkKey=\{characterEditorKey\}[\s\S]{0,160}onSendToStudio=\{handleSendToStudio\}/u,
  );
  assert.match(
    page,
    /<VrmStudio[\s\S]{0,520}createdCharacters=\{savedCharacters\}[\s\S]{0,160}activeCreatedCharacterId=\{stageCharacterId\}[\s\S]{0,160}onSelectCreatedCharacter=\{selectCreatedCharacter\}[\s\S]{0,160}onSelectVrm=\{\(\)\s*=>\s*setStageCharacterId\(null\)\}/u,
  );
  assert.match(studio, /MAX_CREATED_CHARACTER_OPTIONS\s*=\s*3/u);
  assert.match(studio, /createdCharacters\?:\s*readonly\s+VrmStudioCreatedCharacter\[\]/u);
  assert.match(studio, /activeCreatedCharacterId\?:\s*string\s*\|\s*null/u);
  assert.match(library, /aria-labelledby=["']saved-character-title["']/u);
});
