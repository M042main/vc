import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const studioUrl = new URL("../app/components/VrmStudio.tsx", import.meta.url);
const studioCssUrl = new URL(
  "../app/components/VrmStudio.module.css",
  import.meta.url,
);

test("places the studio tools on the right and removes the numbered walkthrough", async () => {
  const [studio, css] = await Promise.all([
    readFile(studioUrl, "utf8"),
    readFile(studioCssUrl, "utf8"),
  ]);

  const stagePosition = studio.indexOf("className={styles.stage}");
  const toolsPanelPosition = studio.indexOf(
    'aria-label="스튜디오 도구 및 무대 설정"',
  );
  assert.ok(stagePosition >= 0 && toolsPanelPosition > stagePosition);

  assert.doesNotMatch(studio, /aria-label="시작 단계"/);
  assert.doesNotMatch(studio, /styles\.step(?:List|Number|Top)?/);
  assert.doesNotMatch(studio, />0[123]</);
  assert.doesNotMatch(studio, /권한을 허용하면 얼굴과 전신 움직임/);
  assert.doesNotMatch(studio, /현재 포즈는 PNG로, 선택한 움직임은 WebM/);

  assert.match(
    css,
    /\.studio\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s+288px;/,
  );
  assert.match(css, /\.stage\s*\{[\s\S]*?min-height:\s*720px;/);
  assert.match(
    css,
    /\.stageTools\s*\{[\s\S]*?right:\s*18px;[\s\S]*?flex-direction:\s*column;/,
  );
});

test("toggles only the local webcam preview while tracking keeps its video source", async () => {
  const studio = await readFile(studioUrl, "utf8");

  assert.match(
    studio,
    /const \[cameraPreviewVisible, setCameraPreviewVisible\] = useState\(true\);/,
  );
  assert.match(
    studio,
    /onClick=\{\(\) => setCameraPreviewVisible\(\(visible\) => !visible\)\}/,
  );
  assert.match(studio, /"웹캠 화면 숨기기"/);
  assert.match(studio, /"웹캠 화면 보이기"/);
  assert.match(
    studio,
    /data-visible=\{[\s\S]{0,180}?cameraPreviewVisible[\s\S]{0,180}?trackingRunning/,
  );
  assert.match(studio, /video\.srcObject\s*=\s*stream;/);
  assert.doesNotMatch(
    studio,
    /setCameraPreviewVisible[\s\S]{0,140}?(?:stopTracking|\.stop\(\)|srcObject\s*=\s*null)/,
  );
});
