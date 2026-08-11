import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const componentUrl = new URL(
  "../app/components/AiImageGenerator.tsx",
  import.meta.url,
);
const cssUrl = new URL(
  "../app/components/AiImageGenerator.module.css",
  import.meta.url,
);

async function sources() {
  const [component, css] = await Promise.all([
    readFile(componentUrl, "utf8"),
    readFile(cssUrl, "utf8"),
  ]);
  return { component, css };
}

test("opens generated AI images in a labelled modal without changing save actions", async () => {
  const { component } = await sources();
  assert.match(component, /const \[previewResult, setPreviewResult\]/u);
  assert.match(
    component,
    /className=\{styles\.resultImageButton\}[\s\S]{0,180}openPreview\(result, event\.currentTarget\)/u,
  );
  assert.match(component, /AI 생성 결과 전체보기:/u);
  assert.match(
    component,
    /className=\{styles\.previewDialog\}[\s\S]{0,120}role="dialog"[\s\S]{0,120}aria-modal="true"/u,
  );
  assert.match(component, />AI 생성 이미지 전체보기<\/h3>/u);
  assert.match(component, /전체보기 닫기/u);
  assert.match(component, /previewResult\.imageDataUrl/u);
  assert.match(component, /onClick=\{\(\) => void saveResult\(result\)\}/u);
  assert.match(component, /onClick=\{\(\) => void downloadResult\(result\)\}/u);
});

test("supports Escape, trapped Tab focus, backdrop close, and trigger restoration", async () => {
  const { component } = await sources();
  assert.match(component, /previewCloseRef\.current\?\.focus\(\)/u);
  assert.match(component, /event\.key === "Escape"[\s\S]{0,100}closePreview\(\)/u);
  assert.match(component, /event\.key !== "Tab"/u);
  assert.match(component, /previewDialogRef\.current/u);
  assert.match(component, /last\.focus\(\)/u);
  assert.match(component, /first\.focus\(\)/u);
  assert.match(component, /window\.setTimeout\(\(\) => trigger\?\.focus\(\), 0\)/u);
  assert.match(
    component,
    /className=\{styles\.previewBackdropClose\}[\s\S]{0,100}onClick=\{closePreview\}/u,
  );
  assert.match(component, /document\.body\.style\.overflow = "hidden"/u);
  assert.match(
    component,
    /document\.body\.style\.overflow = previousBodyOverflow/u,
  );
});

test("keeps the full-view and device-history dialogs mutually exclusive", async () => {
  const { component } = await sources();
  assert.match(
    component,
    /const openPreview = useCallback\([\s\S]{0,220}setHistoryOpen\(false\)[\s\S]{0,160}setPreviewResult\(result\)/u,
  );
  assert.match(
    component,
    /const openHistory = useCallback\([\s\S]{0,180}setPreviewResult\(null\)[\s\S]{0,100}setHistoryOpen\(true\)/u,
  );
  assert.match(component, /onClick=\{openHistory\}/u);
  assert.match(
    component,
    /if \(!historyOpen\) return;[\s\S]{0,180}document\.body\.style\.overflow = "hidden"[\s\S]{0,1600}document\.body\.style\.overflow = previousBodyOverflow/u,
  );
});

test("keeps the full-view image inside desktop and mobile viewport safe areas", async () => {
  const { css } = await sources();
  assert.match(
    css,
    /\.previewBackdrop\s*\{[\s\S]{0,260}env\(safe-area-inset-top\)/u,
  );
  assert.match(
    css,
    /\.previewDialog\s*\{[\s\S]{0,260}width:\s*min\(1100px, 100%\)[\s\S]{0,160}height:\s*min\(90dvh, 900px\)/u,
  );
  assert.match(
    css,
    /\.previewImageFrame img\s*\{[\s\S]{0,180}max-width:\s*100%[\s\S]{0,100}max-height:\s*100%[\s\S]{0,100}object-fit:\s*contain/u,
  );
  assert.match(
    css,
    /@media \(max-width: 520px\)[\s\S]{0,2000}\.previewDialog\s*\{[\s\S]{0,100}height:\s*100%/u,
  );
});
