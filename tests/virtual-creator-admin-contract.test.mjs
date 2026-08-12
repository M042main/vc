import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageUrl = new URL("../app/page.tsx", import.meta.url);
const layoutUrl = new URL("../app/layout.tsx", import.meta.url);
const globalsUrl = new URL("../app/globals.css", import.meta.url);
const adminSessionUrl = new URL("../app/lib/adminSession.ts", import.meta.url);
const adminRouteUrl = new URL("../app/api/admin/session/route.ts", import.meta.url);

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

test("opens server-authenticated admin mode from the top-right gear and passes it to the gallery", async () => {
  const [page, globals, adminSession, adminRoute] = await Promise.all([
    readFile(pageUrl, "utf8"),
    readFile(globalsUrl, "utf8"),
    readFile(adminSessionUrl, "utf8"),
    readFile(adminRouteUrl, "utf8"),
  ]);

  assert.match(page, /<Settings[^>]*aria-hidden="true"/);
  assert.match(page, /관리자 m042 접근/);
  assert.match(page, /role="dialog"/);
  assert.match(page, /aria-modal="true"/);
  assert.match(page, /fetch\("\/api\/admin\/session"[\s\S]{0,220}method:\s*"POST"[\s\S]{0,220}credentials:\s*"same-origin"/);
  assert.match(page, /fetch\("\/api\/admin\/session"[\s\S]{0,220}method:\s*"DELETE"/);
  assert.doesNotMatch(page, /ADMIN_ID|ADMIN_SESSION_KEY|sessionStorage/);
  assert.match(adminSession, /ADMIN_COOKIE_NAME\s*=\s*"__Host-vc-admin"/);
  assert.match(adminSession, /HttpOnly; Secure; SameSite=Strict/);
  assert.match(adminSession, /ADMIN_ACCESS_CODE/);
  assert.match(adminSession, /ADMIN_SESSION_SECRET/);
  assert.match(adminRoute, /createAdminSessionCookie/);
  assert.match(adminRoute, /export async function GET/);
  assert.match(adminRoute, /export async function POST/);
  assert.match(adminRoute, /export async function DELETE/);
  assert.match(page, /isAdmin=\{adminMode\}/);
  assert.match(page, /관리자 모드 종료/);
  assert.match(
    page,
    /const\s+profileGateBlocking\s*=\s*!adminMode\s*&&\s*!profile\s*&&\s*profileReady/,
  );
  assert.match(page, /const\s+renderAdminAccessButton\s*=\s*\(gateControl\s*=\s*false\)\s*=>\s*\([\s\S]{0,220}className="admin-access-button"[\s\S]{0,320}aria-haspopup="dialog"/);
  assert.match(page, /!profileGateBlocking\s*\?\s*renderAdminAccessButton\(\)\s*:\s*null[\s\S]{0,300}blocking=\{profileGateBlocking\}[\s\S]{0,180}blockingModalControl=\{renderAdminAccessButton\(true\)\}/);
  assert.match(page, /restoreAdminTriggerFocus[\s\S]{0,150}adminButtonRef\.current\?\.focus\(\)/);
  assert.match(globals, /\.admin-access-button\[data-gate-control=["']true["']\]\s*\{[\s\S]{0,160}position:\s*fixed;[\s\S]{0,120}z-index:\s*95;[\s\S]{0,160}top:\s*max\([\s\S]{0,100}right:\s*max\(/);
  assert.match(globals, /@media\s*\(max-width:\s*560px\)[\s\S]{0,900}\.admin-access-button\s*\{[\s\S]{0,220}width:\s*44px;/);
  assert.match(globals, /button:focus-visible,[\s\S]{0,100}select:focus-visible/);
  assert.match(globals, /\.admin-dialog-backdrop/);
});
