import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

  assert.match(page, /mode === "studio" \? "studio-workspace" : ""/u);
  assert.match(globals, /\.workspace\.studio-workspace\s*\{[\s\S]*?width:\s*100%;[\s\S]*?padding:\s*0;/u);
  assert.match(css, /\.studio\s*\{[\s\S]*?height:\s*calc\(100dvh - 76px\);/u);
  assert.match(css, /\.studio\[data-panel-collapsed="true"\][\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/u);
  assert.match(css, /\.studio:fullscreen\s*\{[\s\S]*?height:\s*100dvh;/u);

  assert.match(studio, /const \[toolPanelCollapsed, setToolPanelCollapsed\] = useState\(false\);/u);
  assert.match(studio, /hidden=\{toolPanelCollapsed\}/u);
  assert.match(studio, /aria-controls="studio-tool-panel"/u);
  assert.match(studio, /"도구 패널 숨기기"/u);
  assert.match(studio, /"도구 패널 열기"/u);
  assert.match(studio, /studio\.requestFullscreen\(\)/u);
  assert.match(studio, /document\.exitFullscreen\(\)/u);
  assert.match(studio, /"전체 화면으로 보기"/u);
  assert.match(studio, /"전체 화면 종료"/u);
});
