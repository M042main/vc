import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const studioUrl = new URL("../app/components/VrmStudio.tsx", import.meta.url);
const studioCssUrl = new URL(
  "../app/components/VrmStudio.module.css",
  import.meta.url,
);

test("groups character, background, and motion controls into accessible tabs", async () => {
  const [studio, css] = await Promise.all([
    readFile(studioUrl, "utf8"),
    readFile(studioCssUrl, "utf8"),
  ]);

  assert.match(studio, /type StudioToolTab = "character" \| "background" \| "motion";/u);
  assert.match(studio, /className=\{styles\.toolTabs\} role="tablist"/u);
  assert.match(studio, /id="studio-character-tab"[\s\S]{0,520}캐릭터/u);
  assert.match(studio, /id="studio-background-tab"[\s\S]{0,520}배경/u);
  assert.match(studio, /id="studio-motion-tab"[\s\S]{0,520}움직임/u);
  assert.match(studio, /id="studio-character-panel"[\s\S]{0,240}role="tabpanel"/u);
  assert.match(studio, /id="studio-background-panel"[\s\S]{0,240}role="tabpanel"/u);
  assert.match(studio, /id="studio-motion-panel"[\s\S]{0,240}role="tabpanel"/u);
  assert.match(css, /\.toolTabs\s*\{[\s\S]{0,180}grid-template-columns:\s*repeat\(3,/u);
  assert.doesNotMatch(studio, /<h3 className=\{styles\.settingsHeading\}>무대 설정<\/h3>/u);
});

test("puts tracking on a blue-to-red stage camera button", async () => {
  const [studio, css] = await Promise.all([
    readFile(studioUrl, "utf8"),
    readFile(studioCssUrl, "utf8"),
  ]);

  const stageEnd = studio.indexOf("</div>\n\n      <aside");
  const trackingButton = studio.indexOf("className={styles.trackingButton}");
  assert.ok(trackingButton >= 0 && trackingButton < stageEnd);
  assert.match(studio, /className=\{styles\.trackingButton\}[\s\S]{0,520}data-running=\{trackingRunning\}/u);
  assert.match(studio, /onClick=\{trackingRunning \? stopTracking : startTracking\}/u);
  assert.match(css, /\.trackingButton\s*\{[\s\S]{0,320}right:\s*18px;[\s\S]{0,160}bottom:\s*18px;[\s\S]{0,320}background:\s*#3478f6;/u);
  assert.match(css, /\.trackingButton\[data-running="true"\]\s*\{[\s\S]{0,100}background:\s*#ed3f4f;/u);
});

test("labels the bundled character as default instead of exposing its filename", async () => {
  const studio = await readFile(studioUrl, "utf8");
  assert.match(studio, /setModelName\(options\.defaultModel \? "기본" : file\.name\);/u);
});
