import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const studioUrl = new URL("../app/components/VrmStudio.tsx", import.meta.url);
const studioCssUrl = new URL("../app/components/VrmStudio.module.css", import.meta.url);
const pageUrl = new URL("../app/page.tsx", import.meta.url);
const globalsUrl = new URL("../app/globals.css", import.meta.url);

test("uses the full workspace and offers panel collapse plus browser fullscreen", async () => {
  const [studio, css, page, globals] = await Promise.all([
    readFile(studioUrl, "utf8"),
    readFile(studioCssUrl, "utf8"),
    readFile(pageUrl, "utf8"),
    readFile(globalsUrl, "utf8"),
  ]);

  assert.match(page, /workspace-\$\{mode\}/u);
  assert.match(globals, /\.workspace\.studio-workspace\s*\{[\s\S]*?width:\s*100%;[\s\S]*?padding:\s*0;/u);
  assert.match(css, /\.studio\s*\{[\s\S]*?height:\s*calc\(100dvh - 76px\);/u);
  assert.match(css, /\.studio\[data-panel-collapsed="true"\][\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/u);
  assert.match(css, /\.studio:fullscreen\s*\{[\s\S]*?height:\s*100dvh;/u);

  assert.match(studio, /const \[toolPanelCollapsed, setToolPanelCollapsed\] = useState\(false\);/u);
  assert.match(studio, /hidden=\{toolPanelCollapsed\}/u);
  assert.match(studio, /aria-controls="studio-tool-panel"/u);
  assert.match(studio, /"도구 패널 숨기기"/u);
  assert.match(studio, /"도구 패널 열기"/u);
  assert.match(studio, /className=\{styles\.panelMenuButton\}[\s\S]{0,280}<Menu/u);
  assert.match(studio, /className=\{styles\.panelReopenButton\}/u);
  assert.match(studio, /studio\.requestFullscreen\(\)/u);
  assert.match(studio, /document\.exitFullscreen\(\)/u);
  assert.match(studio, /"전체 화면으로 보기"/u);
  assert.match(studio, /"전체 화면 종료"/u);
});

test("expands every workspace mode to the available viewport", async () => {
  const [page, globals] = await Promise.all([
    readFile(pageUrl, "utf8"),
    readFile(globalsUrl, "utf8"),
  ]);

  assert.match(page, /workspace-\$\{mode\}/u);
  assert.match(globals, /\.workspace\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-height:\s*calc\(100dvh - 76px\);/u);
  assert.match(globals, /\.creator-workspace\s*\{[\s\S]*?min-height:\s*calc\(100dvh - 76px\);/u);
  assert.match(globals, /\.workspace-gallery\s*>\s*section,[\s\S]*?\.workspace-ai\s*>\s*section[\s\S]*?min-height:\s*calc\(100dvh - 76px\);/u);
});

test("loads the bundled VRM only when no saved model is available", async () => {
  const [studio, bundledVrm] = await Promise.all([
    readFile(studioUrl, "utf8"),
    stat(new URL("../public/default-character.vrm", import.meta.url)),
  ]);

  assert.ok(bundledVrm.size > 0);
  assert.match(studio, /const DEFAULT_VRM_URL = "\/default-character\.vrm";/u);
  assert.match(studio, /snapshot\.vrm[\s\S]*?restored:\s*true[\s\S]*?else if[\s\S]*?fetch\(DEFAULT_VRM_URL/u);
  assert.match(studio, /defaultModel:\s*true/u);
  assert.match(studio, /if \(!options\.restored && !options\.defaultModel\)/u);
});
