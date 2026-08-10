import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const appRoot = new URL("../app/", import.meta.url);
const REQUIRED_BASE_PATH = "/000000/박근석_t7/motion_ink_gallery_a7f3c9";

async function collectSources(directory = appRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  const sources = [];

  for (const entry of entries) {
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) {
      sources.push(...(await collectSources(url)));
    } else if (/\.(?:ts|tsx|js|jsx)$/.test(entry.name)) {
      sources.push({ url, source: await readFile(url, "utf8") });
    }
  }

  return sources;
}

async function gallerySources() {
  const sources = await collectSources();
  const firebase = sources.filter(({ source }) =>
    /firebase\/(?:app|database)|getDatabase\s*\(|initializeApp\s*\(/.test(source),
  );
  const ui = sources.filter(({ source }) =>
    /온라인\s*갤러리|OnlineGallery|publishGalleryEntry|subscribeGalleryEntries/.test(source),
  );

  assert.ok(firebase.length > 0, "a Firebase Realtime Database gallery module must exist");
  assert.ok(ui.length > 0, "an online gallery UI must exist");

  return {
    all: sources.map(({ source }) => source).join("\n"),
    firebase: firebase.map(({ source }) => source).join("\n"),
    ui: ui.map(({ source }) => source).join("\n"),
  };
}

test("isolates every Realtime Database operation inside the assigned room", async () => {
  const { firebase } = await gallerySources();

  assert.ok(
    firebase.includes(REQUIRED_BASE_PATH) ||
      firebase.includes(REQUIRED_BASE_PATH.slice(1)),
    `the gallery must use only ${REQUIRED_BASE_PATH}`,
  );
  assert.match(
    firebase,
    /\/\/\s*이 부분은 우리 반 공용 데이터베이스에서 내 방을 만드는 주소입니다/,
    "the requested Korean isolation comment must sit beside the room address",
  );
  assert.doesNotMatch(
    firebase,
    /\bref\s*\(\s*[^,\n]+(?:,\s*(?:["']\s*["']|["']\/["'])\s*)?\)/,
    "root and empty database refs are forbidden",
  );
  assert.doesNotMatch(
    firebase,
    /\bref\s*\(\s*[^,\n]+,\s*["'](?:프로젝트|links|gallery|entries)(?:\/|["'])/i,
    "short shared-class paths must never replace the assigned private room",
  );

  const refArguments = [
    ...firebase.matchAll(/\bref\s*\(\s*[^,\n]+,\s*([^\n;]+?)\s*\)/g),
  ].map((match) => match[1]);
  assert.ok(refArguments.length > 0, "the gallery must create a scoped database ref");
  for (const argument of refArguments) {
    assert.ok(
      /(?:GALLERY|BASE|ROOM|PROJECT)[A-Z0-9_]*(?:_PATH|_REF)?|motion_ink_gallery_a7f3c9/.test(
        argument,
      ),
      `database ref is not visibly scoped to the private room: ${argument}`,
    );
  }
});

test("publishes with push plus set and tears down the realtime listener", async () => {
  const { firebase, ui } = await gallerySources();

  assert.match(firebase, /\bpush\s*\(/, "gallery writes must allocate unique child keys");
  assert.match(firebase, /\bset\s*\(/, "gallery entries must be written through set");
  assert.match(firebase, /\bonValue\s*\(/, "gallery must update in realtime");
  assert.ok(
    /(?:const|let)\s+unsubscribe\s*=\s*onValue\s*\(/.test(firebase) ||
      /return\s+onValue\s*\(/.test(firebase),
    "the onValue unsubscribe callback must be retained",
  );
  assert.ok(
    /return\s+(?:\(\)\s*=>\s*)?unsubscribe\b/.test(firebase) ||
      /return\s+onValue\s*\(/.test(firebase),
    "subscribeGalleryEntries must return an unsubscribe callback",
  );
  assert.ok(
    /return\s+\(\)\s*=>\s*(?:\{[\s\S]{0,120}?)?unsubscribe\s*\(/.test(ui),
    "the gallery component must unsubscribe when it unmounts",
  );
});

test("accepts only bounded PNG data URLs before Firebase writes", async () => {
  const { firebase } = await gallerySources();

  assert.match(firebase, /data:image\/png;base64,/i);
  assert.ok(
    /(?:startsWith|test|match)\s*\([\s\S]{0,120}data:image\/png|data:image\/png[\s\S]{0,120}(?:startsWith|test|match)/i.test(
      firebase,
    ) ||
      /(?:startsWith|test|match)\s*\(\s*(?:PNG|IMAGE|DATA)[A-Z0-9_]*(?:PREFIX|PATTERN|REGEX)/.test(
        firebase,
      ),
    "PNG MIME/data-URL validation must run before publishing",
  );

  const byteLimit = firebase.match(
    /(?:MAX|LIMIT)[A-Z0-9_]*(?:IMAGE|PNG|DATA|GALLERY)[A-Z0-9_]*(?:BYTES|SIZE|CHARACTERS)[A-Z0-9_]*\s*=\s*([^;\n]+)/i,
  );
  assert.ok(byteLimit, "a named PNG/data URL size limit must be defined");
  assert.match(
    firebase,
    /(?:byteLength|\.size\b|length\b)[\s\S]{0,100}(?:MAX|LIMIT)|(?:MAX|LIMIT)[\s\S]{0,100}(?:byteLength|\.size\b|length\b)/i,
    "the size limit must be enforced, not merely declared",
  );
  assert.ok(
    firebase.indexOf("data:image/png") < firebase.lastIndexOf("set("),
    "validation must appear before the Firebase set call",
  );
});

test("persists an editable download name in a cookie and exposes gallery actions", async () => {
  const { ui } = await gallerySources();

  assert.match(ui, /document\.cookie/, "the visitor name must persist in a cookie");
  assert.match(ui, /SameSite=Lax/i, "the name cookie should use SameSite=Lax");
  assert.ok(
    /이름\s*(?:입력|수정|저장)|(?:aria-label|<label)[\s\S]{0,100}이름/.test(ui),
    "the saved name must have an accessible edit control",
  );
  assert.match(ui, /(?:업로드|갤러리에\s*저장)/);
  assert.match(ui, /다운로드/);
  assert.match(ui, /publishGalleryEntry\s*\(/);
  assert.match(
    ui,
    /\.download\s*=[^;\n]*(?:viewerName|downloaderName|safeFilename\s*\([^)]*name)/,
    "the cookie-backed visitor name must be used in the downloaded PNG filename",
  );
  assert.match(ui, /kind:\s*["']edit["']/, "the saved name must remain editable");
  assert.match(ui, /type=["']button["']/, "gallery actions must not submit a surrounding form");
  assert.match(ui, /alt=\{[^}]+\}|alt=["'][^"']+["']/, "gallery thumbnails need alt text");
  assert.match(ui, /aria-live=["'](?:polite|assertive)["']/, "async gallery status needs a live region");
});

test("wires the full-body PNG capture into the mounted online gallery", async () => {
  const { all } = await gallerySources();

  assert.match(all, /new\s+FileReader\s*\(/, "capture blobs must become Data URLs in the browser");
  assert.match(all, /onCaptureReady\s*=\{/, "the studio must expose completed full-body captures");
  assert.match(all, /<OnlineGallery\b/, "the online gallery must be mounted in the application");
  assert.match(
    all,
    /<OnlineGallery[\s\S]{0,300}(?:captureDataUrl|pendingCapture)=\{/,
    "the mounted gallery must receive the latest transparent full-body PNG",
  );
});

test("cleans up subscriptions and temporary download objects", async () => {
  const { ui } = await gallerySources();

  assert.match(ui, /URL\.createObjectURL\s*\(/, "downloads must use a temporary object URL");
  assert.match(ui, /URL\.revokeObjectURL\s*\(/, "temporary download URLs must be revoked");
  assert.ok(
    /\.remove\s*\(\)|removeChild\s*\(/.test(ui),
    "the temporary download anchor must be removed",
  );
  assert.ok(
    /finally\s*\{[\s\S]{0,240}URL\.revokeObjectURL/.test(ui) ||
      /setTimeout\s*\([\s\S]{0,160}URL\.revokeObjectURL/.test(ui),
    "object URLs must be revoked even after the click path finishes",
  );
});
