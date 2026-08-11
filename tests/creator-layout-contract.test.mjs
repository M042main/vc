import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
  page: new URL("../app/page.tsx", import.meta.url),
  globals: new URL("../app/globals.css", import.meta.url),
  creator: new URL("../app/components/CharacterCreator.tsx", import.meta.url),
  creatorCss: new URL(
    "../app/components/CharacterCreator.module.css",
    import.meta.url,
  ),
  libraryCss: new URL(
    "../app/components/SavedCharacterLibrary.module.css",
    import.meta.url,
  ),
  onboarding: new URL(
    "../app/components/ClassOnboarding.tsx",
    import.meta.url,
  ),
  onboardingCss: new URL(
    "../app/components/ClassOnboarding.module.css",
    import.meta.url,
  ),
};

async function sources() {
  const entries = await Promise.all(
    Object.entries(files).map(async ([name, url]) => [name, await readFile(url, "utf8")]),
  );
  return Object.fromEntries(entries);
}

test("places the saved-character library to the editor right and below it on narrow screens", async () => {
  const { page, globals, libraryCss } = await sources();
  const workspaceStart = page.indexOf('<div className="creator-workspace">');
  const workspaceEnd = page.indexOf("</div>", page.indexOf("</div>", workspaceStart) + 6);
  const workspace = page.slice(workspaceStart, workspaceEnd + 6);

  assert.ok(workspaceStart >= 0 && workspaceEnd > workspaceStart);
  assert.ok(workspace.indexOf("<CharacterCreator") < workspace.indexOf("<SavedCharacterLibrary"));
  assert.match(workspace, /className="creator-library-column"/u);
  assert.match(
    globals,
    /\.creator-workspace\s*\{[\s\S]{0,220}grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(250px,\s*280px\)/u,
  );
  assert.match(
    globals,
    /@media\s*\(max-width:\s*1180px\)[\s\S]{0,220}\.creator-workspace\s*\{[\s\S]{0,100}grid-template-columns:\s*minmax\(0,\s*1fr\)/u,
  );
  assert.match(
    libraryCss,
    /\.grid\s*\{[\s\S]{0,100}grid-template-columns:\s*minmax\(0,\s*1fr\)/u,
  );
});

test("removes long visible creator guidance while retaining concise accessible canvas labels", async () => {
  const { creator, creatorCss } = await sources();

  assert.doesNotMatch(creator, /styles\.tipBox|팔은 수평 T-포즈/u);
  assert.doesNotMatch(creator, /체크무늬는 투명 영역|저장된 T-포즈/u);
  assert.doesNotMatch(
    creator,
    /T-포즈 · \{side === "front"|투명 원본 · T-포즈 관절·얼굴 가이드는 저장되지 않아요/u,
  );
  assert.doesNotMatch(creator, /styles\.(?:stageMeta|guideNotice)/u);
  assert.match(
    creator,
    /id="character-face-guide-help"\s+className=\{styles\.srOnly\}/u,
  );
  assert.match(
    creator,
    /id="character-canvas-help"\s+className=\{styles\.srOnly\}/u,
  );
  assert.match(
    creator,
    /className=\{styles\.srOnly\}\s+role="status"\s+aria-live="polite"/u,
  );
  assert.doesNotMatch(
    creatorCss,
    /\.(?:tipBox|faceGuideHint|canvasHelp|status|stageMeta|guideNotice)\s*\{/u,
  );
});

test("keeps class and student name on one line and renders an icon-only admin trigger", async () => {
  const { page, globals, onboarding, onboardingCss } = await sources();
  const adminStart = page.indexOf("const renderAdminAccessButton");
  const adminEnd = page.indexOf("  );", adminStart);
  const adminTrigger = page.slice(adminStart, adminEnd + 4);

  assert.match(
    onboarding,
    /<small>\{profile\.className\}<\/small>[\s\S]{0,120}profileSeparator[\s\S]{0,120}<strong>\{profile\.name\}<\/strong>/u,
  );
  assert.match(
    onboardingCss,
    /\.profileIdentity\s*>\s*span:last-child\s*\{[\s\S]{0,100}display:\s*flex;[\s\S]{0,100}align-items:\s*center/u,
  );
  assert.match(adminTrigger, /aria-label=\{adminMode[\s\S]{0,180}<Settings/u);
  assert.doesNotMatch(adminTrigger, /<span>/u);
  assert.match(
    globals,
    /\.admin-access-button\s*\{[\s\S]{0,100}width:\s*44px;[\s\S]{0,180}padding:\s*0;/u,
  );
});
