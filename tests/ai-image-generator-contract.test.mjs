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

test("keeps secrets server-side and uses the AI generation route contract", async () => {
  const { component } = await sources();
  assert.match(component, /fetch\("\/api\/ai\/generate"/u);
  assert.match(component, /method:\s*"POST"/u);
  assert.match(component, /JSON\.stringify\(\{[\s\S]{0,180}prompt:\s*normalizedPrompt,[\s\S]{0,180}imageDataUrl:\s*source\.requestDataUrl/u);
  assert.match(component, /interface AiGenerateResponse[\s\S]{0,120}imageDataUrl:\s*string[\s\S]{0,120}mimeType:\s*string/u);
  assert.match(component, /generatedImageFromPayload\(value\)/u);
  assert.match(component, /\(value as Record<string, unknown>\)\.result/u);
  assert.doesNotMatch(component, /AIza|GEMINI_API_KEY|x-goog-api-key|generativelanguage\.googleapis/u);
});

test("validates supported source photos before sending them", async () => {
  const { component } = await sources();
  assert.match(component, /MAX_SOURCE_FILE_BYTES\s*=\s*8\s*\*\s*1024\s*\*\s*1024/u);
  assert.match(component, /MAX_SOURCE_PIXELS\s*=\s*25_000_000/u);
  assert.match(component, /MAX_REQUEST_EDGE\s*=\s*2_048/u);
  assert.match(component, /MAX_REQUEST_DATA_URL_CHARACTERS\s*=\s*9\s*\*\s*1024\s*\*\s*1024/u);
  assert.match(component, /new Set\(\["image\/jpeg",\s*"image\/png",\s*"image\/webp"\]\)/u);
  assert.match(component, /accept="image\/jpeg,image\/png,image\/webp"/u);
  assert.match(component, /readFileAsDataUrl\(file\)/u);
  assert.match(component, /inspectImage\(dataUrl\)/u);
  assert.match(component, /prepareRequestImage\([\s\S]{0,180}file\.type/u);
  assert.match(component, /sourceMimeType === "image\/jpeg" \? "image\/jpeg" : "image\/png"/u);
  assert.match(component, /dimensions\.width\s*\*\s*dimensions\.height\s*>\s*MAX_SOURCE_PIXELS/u);
});

test("supports presets, loading, errors, regeneration, reset, and PNG download", async () => {
  const { component } = await sources();
  assert.match(component, /PROMPT_PRESETS/u);
  assert.match(component, /aria-pressed=\{activePreset === preset\.id\}/u);
  assert.match(component, /AbortController/u);
  assert.match(component, /role="status"\s+aria-live="polite"/u);
  assert.match(component, /className=\{styles\.requestError\}\s+role="alert"/u);
  assert.match(component, /PNG 다운로드/u);
  assert.match(component, /return canvasToBlob\(canvas, "image\/png"\)/u);
  assert.match(component, /다시 생성/u);
  assert.match(component, /처음부터/u);
  assert.match(component, /resultHeadingRef\.current\?\.focus\(\)/u);
  assert.match(component, /선택한 사진이 Google Gemini API로 전송됩니다/u);
  assert.match(component, /Gemini 2\.5 Flash Image/u);
  assert.match(component, /selectFileButtonRef\.current\?\.focus\(\)/u);
});

test("provides responsive, reduced-motion, and touch-friendly styling", async () => {
  const { css } = await sources();
  assert.match(css, /min-height:\s*44px/u);
  assert.match(css, /@media\s*\(max-width:\s*900px\)[\s\S]{0,240}grid-template-columns:\s*minmax\(0,\s*1fr\)/u);
  assert.match(css, /@media\s*\(max-width:\s*590px\)/u);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/u);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/u);
});
