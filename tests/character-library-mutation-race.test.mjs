import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageUrl = new URL("../app/page.tsx", import.meta.url);
const onboardingUrl = new URL(
  "../app/components/ClassOnboarding.tsx",
  import.meta.url,
);

function block(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end >= 0, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test("uses one synchronous epoch lock and verifies the persisted profile owner", async () => {
  const page = await readFile(pageUrl, "utf8");
  const lock = block(
    page,
    "type LibraryMutationToken",
    "function guestCharacterArtworkKey",
  );

  assert.match(lock, /type LibraryMutationState[\s\S]{0,120}busy:\s*boolean/u);
  assert.match(lock, /function beginLibraryMutation/u);
  assert.match(lock, /mutationRef\.current\.busy\s*&&\s*!supersede/u);
  assert.match(lock, /epoch:\s*mutationRef\.current\.epoch\s*\+\s*1/u);
  assert.match(lock, /function isLibraryMutationCurrent/u);
  assert.match(lock, /current\.epoch\s*===\s*token\.epoch/u);
  assert.match(lock, /current\.profileKey\s*===\s*token\.profileKey/u);
  assert.match(
    lock,
    /libraryProfileKey\(loadVisitorProfile\(\)\)\s*===\s*token\.profileKey/u,
  );
  assert.match(lock, /function finishLibraryMutation/u);
  assert.match(lock, /mutationRef\.current\s*=\s*\{\s*\.\.\.current,\s*busy:\s*false\s*\}/u);
});

test("restore, save, delete, and profile transitions share the lock and reject stale commits", async () => {
  const page = await readFile(pageUrl, "utf8");
  const restore = block(
    page,
    "useEffect(() => {\n    if (!profileReady)",
    "useEffect(() => {\n    const timer",
  );
  const profileChange = block(
    page,
    "const handleProfileChange",
    "const selectCreatedCharacter",
  );
  const remove = block(
    page,
    "const deleteSavedCharacter",
    "const handleSendToStudio",
  );
  const save = block(
    page,
    "const handleSendToStudio",
    "const profileGateBlocking",
  );

  assert.match(restore, /beginLibraryMutation\(libraryMutationRef,\s*profile,\s*true\)/u);
  assert.match(restore, /isLibraryMutationCurrent\(libraryMutationRef,\s*mutationToken\)/u);
  assert.ok(
    restore.indexOf("if (!restoreIsCurrent()) return;", restore.indexOf("await cacheProfileCharacters")) >
      restore.indexOf("await cacheProfileCharacters"),
  );
  assert.match(restore, /\.finally\(finishRestore\)/u);

  assert.match(
    profileChange,
    /if \(aiImageBusy \|\| libraryMutationRef\.current\.busy\) return/u,
  );
  assert.match(
    profileChange,
    /beginLibraryMutation\(\s*libraryMutationRef,\s*nextProfile/u,
  );
  assert.match(profileChange, /pendingProfileTransitionRef\.current\s*=\s*mutationToken/u);
  assert.match(profileChange, /profile\.guest\s*&&\s*nextProfile\.guest/u);
  assert.match(profileChange, /setProfile\(nextProfile\)/u);

  assert.match(remove, /beginLibraryMutation\(libraryMutationRef,\s*profile\)/u);
  assert.ok(
    remove.indexOf("isLibraryMutationCurrent", remove.indexOf("await Promise.all")) >
      remove.indexOf("await Promise.all"),
  );
  assert.ok(remove.indexOf("setSavedCharacters") > remove.indexOf("isLibraryMutationCurrent"));
  assert.match(remove, /finishLibraryMutation\(libraryMutationRef,\s*mutationToken\)/u);

  assert.match(save, /beginLibraryMutation\(libraryMutationRef,\s*profile\)/u);
  assert.match(save, /isLibraryMutationCurrent\(libraryMutationRef,\s*mutationToken\)/u);
  assert.ok(save.indexOf("setSavedCharacters") > save.indexOf("isLibraryMutationCurrent"));
  assert.match(save, /finishLibraryMutation\(libraryMutationRef,\s*mutationToken\)/u);
});

test("busy state disables profile and creator mutation controls in addition to handler guards", async () => {
  const [page, onboarding] = await Promise.all([
    readFile(pageUrl, "utf8"),
    readFile(onboardingUrl, "utf8"),
  ]);

  assert.match(
    page,
    /<VisitorProfileActions[\s\S]{0,180}disabled=\{pageBusy\}/u,
  );
  assert.match(
    page,
    /<CharacterCreator[\s\S]{0,260}disabled=\{characterLibraryBusy\}/u,
  );
  assert.match(onboarding, /VisitorProfileActionsProps[\s\S]{0,140}disabled\?:\s*boolean/u);
  assert.match(onboarding, /const openDialog\s*=\s*\(\)\s*=>\s*\{\s*if \(disabled\) return/u);
  assert.match(onboarding, /const logout\s*=\s*\(\)\s*=>\s*\{\s*if \(disabled\) return/u);
  assert.match(onboarding, /aria-busy=\{disabled\}/u);
  assert.ok((onboarding.match(/disabled=\{disabled\}/gu) ?? []).length >= 4);
});
