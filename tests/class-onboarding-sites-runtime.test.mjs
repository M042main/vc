import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
  onboarding: new URL("../app/components/ClassOnboarding.tsx", import.meta.url),
  onboardingCss: new URL(
    "../app/components/ClassOnboarding.module.css",
    import.meta.url,
  ),
  page: new URL("../app/page.tsx", import.meta.url),
  globals: new URL("../app/globals.css", import.meta.url),
};

async function sources() {
  const entries = await Promise.all(
    Object.entries(files).map(async ([key, url]) => [key, await readFile(url, "utf8")]),
  );
  return Object.fromEntries(entries);
}

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u"))?.[1] ?? "";
}

test("keeps the administrator gear fixed at the top-right above the onboarding gate", async () => {
  const { page, globals, onboarding, onboardingCss } = await sources();
  const topbarStart = page.indexOf('<header className="topbar">');
  const topbarEnd = page.indexOf("</header>", topbarStart);
  assert.ok(topbarStart >= 0 && topbarEnd > topbarStart, "the top bar must exist");

  const topbar = page.slice(topbarStart, topbarEnd);
  assert.match(topbar, /<nav className="mode-switch"/u);
  assert.doesNotMatch(topbar, /className="admin-access-button"/u);
  assert.match(
    page,
    /const\s+adminAccessButton\s*=\s*\([\s\S]{0,240}<button[\s\S]{0,180}className="admin-access-button"[\s\S]{0,420}<Settings[^>]*aria-hidden="true"/u,
  );
  assert.match(page, /\{profileGateBlocking\s*\?\s*null\s*:\s*adminAccessButton\}/u);
  assert.match(page, /blockingModalControl=\{adminAccessButton\}/u);
  assert.match(
    onboarding,
    /aria-modal=\{isBlocking\s*\?\s*true[\s\S]{0,120}\{isBlocking\s*\?\s*blockingModalControl\s*:\s*null\}[\s\S]{0,120}className=\{styles\.summary\}/u,
  );

  const adminRule = cssRule(globals, ".admin-access-button");
  const gateRule = cssRule(onboardingCss, ".blockingBackdrop");
  assert.match(adminRule, /position\s*:\s*fixed/u);
  assert.match(adminRule, /top\s*:\s*max\([^;]*safe-area-inset-top/u);
  assert.match(adminRule, /right\s*:\s*max\([^;]*safe-area-inset-right/u);
  const adminLayer = Number(adminRule.match(/z-index\s*:\s*(\d+)/u)?.[1] ?? NaN);
  const gateLayer = Number(gateRule.match(/z-index\s*:\s*(\d+)/u)?.[1] ?? NaN);
  assert.ok(
    Number.isFinite(adminLayer) && Number.isFinite(gateLayer) && adminLayer > gateLayer,
    "the fixed administrator gear must stay usable above the blocking onboarding gate",
  );
});

test("offers guest access as a separate action instead of a class-select option", async () => {
  const { onboarding } = await sources();

  assert.doesNotMatch(onboarding, /<option[^>]*>[\s\S]{0,80}게스트/iu);
  assert.doesNotMatch(onboarding, /type=["']radio["'][\s\S]{0,180}게스트/iu);
  assert.match(
    onboarding,
    /<button[\s\S]{0,260}className=\{styles\.guestButton\}[\s\S]{0,260}type="button"[\s\S]{0,360}onClick=\{\(\)\s*=>\s*saveProfile\(true\)\}[\s\S]{0,180}게스트로 체험하기/u,
  );
  assert.match(onboarding, /submitClassProfile[\s\S]{0,160}saveProfile\(false\)/u);
  assert.match(onboarding, /<select[\s\S]{0,600}classes\.map\s*\(/u);
});

test("surfaces class-list subscription failures as an actionable live error", async () => {
  const { onboarding } = await sources();
  const subscriptionStart = onboarding.indexOf("subscribeClassRecords({");
  const subscriptionEnd = onboarding.indexOf("});", subscriptionStart);
  assert.ok(
    subscriptionStart >= 0 && subscriptionEnd > subscriptionStart,
    "the class subscription must exist",
  );

  const subscription = onboarding.slice(subscriptionStart, subscriptionEnd + 3);
  assert.match(subscription, /onError:\s*\(error\)\s*=>/u);
  assert.match(subscription, /setClassesReady\(true\)/u);
  assert.match(subscription, /setClassesError\(/u);
  assert.match(subscription, /onData:[\s\S]{0,260}setClassesLoadedSuccessfully\(true\)/u);
  assert.doesNotMatch(
    subscription,
    /onError:[\s\S]{0,220}setClassesLoadedSuccessfully\(true\)/u,
  );
  assert.match(
    onboarding,
    /if\s*\([\s\S]{0,100}!classesLoadedSuccessfully[\s\S]{0,180}!profile\.classId[\s\S]{0,80}\)\s*return/u,
    "a failed initial read must not be mistaken for a deleted class",
  );
  assert.match(onboarding, /classesError[\s\S]{0,180}role="alert"/u);
  assert.match(
    onboarding,
    /학급 목록을 (?:불러오지|가져오지) 못했습니다/u,
    "the visible fallback should identify which operation failed",
  );
});

async function sitesWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("class-route-contract", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

function runtimeEnvironment() {
  return {
    ASSETS: {
      fetch: async () => new Response("Not found", { status: 404 }),
    },
  };
}

function executionContext() {
  return {
    waitUntil() {},
    passThroughOnException() {},
  };
}

test("registers the protected class route in the built Sites worker", async () => {
  const worker = await sitesWorker();
  const unauthorized = await worker.fetch(
    new Request("http://localhost/api/gallery/classes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "런타임 확인" }),
    }),
    runtimeEnvironment(),
    executionContext(),
  );

  assert.equal(unauthorized.status, 403);
  assert.match(unauthorized.headers.get("content-type") ?? "", /^application\/json\b/iu);
  assert.deepEqual(await unauthorized.json(), { error: "학급 관리 권한이 없습니다." });

  const invalidAuthorizedRequest = await worker.fetch(
    new Request("http://localhost/api/gallery/classes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "oai-authenticated-user-email": "m042@m042.kr",
      },
      body: JSON.stringify({ name: "" }),
    }),
    runtimeEnvironment(),
    executionContext(),
  );

  assert.equal(invalidAuthorizedRequest.status, 400);
  assert.deepEqual(await invalidAuthorizedRequest.json(), {
    error: "학급 이름이 올바르지 않습니다.",
  });
});
