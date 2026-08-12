import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const appRoot = new URL("../app/", import.meta.url);
const galleryDeleteRouteUrl = new URL(
  "../app/api/gallery/delete/route.ts",
  import.meta.url,
);
const adminSessionUrl = new URL("../app/lib/adminSession.ts", import.meta.url);
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

test("routes deletion through shared authenticated server code to isolated gallery paths", async () => {
  const [{ firebase }, route, adminSession] = await Promise.all([
    gallerySources(),
    readFile(galleryDeleteRouteUrl, "utf8"),
    readFile(adminSessionUrl, "utf8"),
  ]);

  assert.doesNotMatch(
    firebase,
    /import\s*\{[\s\S]*?\bremove\b[\s\S]*?\}\s*from\s*["']firebase\/database["']/,
    "browser Firebase code must not import the destructive remove helper",
  );
  assert.doesNotMatch(
    firebase,
    /\bremove\s*\(/,
    "browser Firebase code must never delete gallery data directly",
  );
  assert.match(firebase, /GALLERY_DELETE_API_PATH\s*=\s*["']\/api\/gallery\/delete["']/);
  assert.match(
    firebase,
    /fetch\s*\(\s*GALLERY_DELETE_API_PATH\s*,\s*\{[\s\S]{0,500}method:\s*["']POST["'][\s\S]{0,500}JSON\.stringify\s*\(\s*\{\s*id:\s*validatedId\s*\}\s*\)/,
    "the client must send only a validated ID to the same-origin POST route",
  );

  assert.match(route, /import\s*\{\s*isAdminMutationRequest\s*\}\s*from\s*["'][^"']*adminSession["']/u);
  assert.match(route, /await\s+isAdminMutationRequest\s*\(\s*request\s*\)/u);
  assert.match(adminSession, /oai-authenticated-user-email/);
  assert.match(adminSession, /ADMIN_EMAIL\s*=\s*["']m042@m042\.kr["']/);
  assert.match(adminSession, /TRUSTED_SITES_HOSTNAME\s*=\s*["']motion-ink-vrm-studio\.m042\.chatgpt\.site["']/);
  assert.match(
    adminSession,
    /new URL\(request\.url\)\.hostname\.toLowerCase\(\)\s*===\s*TRUSTED_SITES_HOSTNAME[\s\S]{0,220}request\.headers\.get\(AUTHENTICATED_USER_EMAIL_HEADER\)\s*===\s*ADMIN_EMAIL/u,
    "the shared session must trust the exact admin email only on the Sites production host",
  );
  assert.match(route, /FIREBASE_PUSH_KEY_PATTERN\s*=\s*\/\^\[-_A-Za-z0-9\]\{20\}\$\/u/);
  assert.match(route, new RegExp(REQUIRED_BASE_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(
    route,
    /new URL\s*\(\s*`\$\{GALLERY_ENTRIES_PATH\}\/\$\{id\}\.json`\s*,\s*FIREBASE_DATABASE_ORIGIN\s*,?\s*\)/,
    "the outbound Firebase URL must append only the validated push key child",
  );
  assert.match(
    route,
    /fetch\s*\(\s*firebaseEntryUrl\s*,\s*\{[\s\S]{0,240}method:\s*["']DELETE["']/,
  );
  assert.doesNotMatch(
    route,
    /fetch\s*\(\s*FIREBASE_DATABASE_ORIGIN\s*,/,
    "the route must never target the database origin",
  );
  assert.ok(
    route.indexOf("isAdminMutationRequest") < route.indexOf("firebaseEntryUrl"),
    "authorization must happen before constructing or issuing the delete request",
  );
});

test("surfaces client, payload, authorization, and upstream delete failures", async () => {
  const [{ firebase, ui }, route] = await Promise.all([
    gallerySources(),
    readFile(galleryDeleteRouteUrl, "utf8"),
  ]);

  assert.match(firebase, /if\s*\(\s*!response\.ok\s*\)/);
  assert.match(firebase, /await\s+response\.json\s*\(\)/);
  assert.match(firebase, /new\s+GalleryServiceError\s*\(\s*message/);
  assert.match(route, /request\.json\s*\(\)[\s\S]{0,160}400/);
  assert.match(
    route,
    /!firebaseResponse\.ok[\s\S]{0,100}firebaseFailureResponse\s*\(\s*firebaseResponse\s*\)/,
  );
  assert.match(route, /firebaseFailureResponse[\s\S]{0,1500}502/);
  assert.match(route, /catch\s*\{[\s\S]{0,160}Firebase 삭제 서비스에 연결하지 못했습니다[\s\S]{0,80}502/);
  assert.match(ui, /setDeleteError\s*\(\s*message\s*\)/);
  assert.match(ui, /deleteError[\s\S]{0,180}role=["']alert["']/);
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

test("persists an editable download name and exposes icon-only gallery actions", async () => {
  const { firebase, ui } = await gallerySources();

  assert.match(ui, /document\.cookie/, "the visitor name must persist in a cookie");
  assert.match(ui, /SameSite=Lax/i, "the name cookie should use SameSite=Lax");
  assert.ok(
    /이름\s*(?:입력|수정|저장)|(?:aria-label|<label)[\s\S]{0,100}이름/.test(ui),
    "the saved name must have an accessible edit control",
  );
  assert.match(ui, /다운로드/);
  assert.match(firebase, /publishGalleryEntry\s*\(/);
  assert.doesNotMatch(ui, /갤러리에 올리기/);
  assert.doesNotMatch(ui, /PNG 받기/);
  assert.doesNotMatch(ui, /현재 캡처를 올리고/);
  assert.match(ui, /title=\{`\$\{entry\.name\}님의 캐릭터 PNG 다운로드`\}/);
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

test("shows two-step deletion controls only behind the administrator UI gate", async () => {
  const { ui } = await gallerySources();

  assert.match(ui, /isAdmin\?:\s*boolean/);
  assert.match(ui, /isAdmin\s*=\s*false/);
  assert.match(ui, /\{isAdmin\s*\?\s*\([\s\S]{0,900}삭제 선택/);
  assert.match(ui, /deleteCandidateId\s*===\s*entry\.id/);
  assert.match(ui, /삭제 확인/);
  assert.match(ui, /취소/);
  assert.match(ui, /deleteGalleryEntry\s*\(entry\.id\)/);
  assert.match(ui, /deletingId\s*===\s*entry\.id[\s\S]{0,220}삭제 중/);
  assert.match(ui, /deleteError[\s\S]{0,180}role=["']alert["']/);
  assert.match(
    ui,
    /관리자 UI는 실수 방지용이며, 실제 삭제 권한은 동일 출처 서버 경로에서 인증 이메일로 확인합니다/,
  );
});

test("returns a complete named entry for the page-level automatic uploader", async () => {
  const { firebase, ui } = await gallerySources();

  assert.match(firebase, /publishGalleryEntry[\s\S]{0,250}Promise<GalleryEntry>/);
  assert.match(
    firebase,
    /return\s*\{\s*id\s*,\s*\.\.\.record\s*,\s*likeCount:\s*0\s*,\s*likeActorKeys:\s*\[\]\s*\}/,
  );
  assert.doesNotMatch(ui, /function\s+OnlineGallery[\s\S]{0,8000}publishGalleryEntry\s*\(/);
  assert.doesNotMatch(
    ui,
    /(?:pendingCapture|captureDataUrl|onUploadComplete)\?:/,
    "the gallery view must not retain the removed manual-upload handoff props",
  );
});

test("publishes completed full-body captures from the always-mounted page controller", async () => {
  const { all } = await gallerySources();

  assert.match(all, /new\s+FileReader\s*\(/, "capture blobs must become Data URLs in the browser");
  assert.match(
    all,
    /onCaptureReady\s*=\{handleCaptureReady\}/,
    "the studio must expose completed full-body captures to the page controller",
  );
  assert.match(
    all,
    /handleCaptureReady[\s\S]{0,1800}await\s+publishGalleryEntry\s*\(\{[\s\S]{0,260}imageDataUrl:\s*galleryImageDataUrl/,
    "the page controller must automatically publish the prepared capture",
  );
  assert.match(all, /<OnlineGallery\b/, "the online gallery must be mounted in the application");
  assert.doesNotMatch(
    all,
    /<OnlineGallery[\s\S]{0,300}(?:captureDataUrl|pendingCapture|onUploadComplete)=\{/,
    "the mounted gallery must not expose a second manual-upload path",
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
