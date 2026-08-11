import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageUrl = new URL("../app/page.tsx", import.meta.url);
const layoutUrl = new URL("../app/layout.tsx", import.meta.url);
const globalsUrl = new URL("../app/globals.css", import.meta.url);

test("renames the product to Virtual Creator and removes the requested footer", async () => {
  const [page, layout] = await Promise.all([
    readFile(pageUrl, "utf8"),
    readFile(layoutUrl, "utf8"),
  ]);

  assert.match(page, /VIRTUAL CREATOR/);
  assert.match(layout, /Virtual Creator/);
  assert.match(layout, /og-virtual-creator\.png/);
  assert.doesNotMatch(page, /MOTION INK|<footer|Kalidoface 3D와|카메라 사용에는 HTTPS/i);
  assert.doesNotMatch(layout, /MOTION INK/);
});

test("opens m042 admin mode from the top-right gear and passes it to the gallery", async () => {
  const [page, globals] = await Promise.all([
    readFile(pageUrl, "utf8"),
    readFile(globalsUrl, "utf8"),
  ]);

  assert.match(page, /ADMIN_ID\s*=\s*"m042"/);
  assert.match(page, /<Settings[^>]*aria-hidden="true"/);
  assert.match(page, /관리자 m042 접근/);
  assert.match(page, /role="dialog"/);
  assert.match(page, /aria-modal="true"/);
  assert.match(page, /window\.sessionStorage\.setItem\(ADMIN_SESSION_KEY, "active"\)/);
  assert.match(page, /window\.sessionStorage\.removeItem\(ADMIN_SESSION_KEY\)/);
  assert.match(page, /isAdmin=\{adminMode\}/);
  assert.match(page, /관리자 모드 종료/);
  assert.match(globals, /\.admin-access-button/);
  assert.match(globals, /\.admin-dialog-backdrop/);
});
