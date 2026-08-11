import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const libraryUrl = new URL(
  "../app/lib/profileCharacterLibrary.ts",
  import.meta.url,
);
const pageUrl = new URL("../app/page.tsx", import.meta.url);

function block(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end >= 0, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function normalizeVisitorName(value) {
  if (typeof value !== "string") return "";
  return Array.from(value.normalize("NFKC").trim().replace(/\s+/gu, " "))
    .slice(0, 24)
    .join("");
}

async function loadGuestOwnerKey() {
  const source = await readFile(libraryUrl, "utf8");
  const implementation = block(
    source,
    "export function guestCharacterOwnerKey",
    "function localProfileKey",
  )
    .replace("export ", "")
    .replace(
      /profile:\s*Pick<VisitorProfile,\s*"guest"\s*\|\s*"name">,/u,
      "profile,",
    );
  return new Function(
    "normalizeVisitorName",
    `${implementation}; return guestCharacterOwnerKey;`,
  )(normalizeVisitorName);
}

async function loadPageGuestStorageHelpers() {
  const source = await readFile(pageUrl, "utf8");
  const savedKey = source.match(
    /const SAVED_CHARACTER_KEY\s*=\s*"([^"]+)";/u,
  )?.[1];
  assert.equal(savedKey, "motion-ink.saved-character.t-pose.v2");
  const ownerKey = `${savedKey}:migration-owner`;
  const implementation = block(
    source,
    "function guestCharacterArtworkKey",
    "function characterStorageId",
  ).replace(/profile:\s*VisitorProfile/gu, "profile");
  const factory = new Function(
    "window",
    "SAVED_CHARACTER_KEY",
    "LEGACY_GUEST_CHARACTER_OWNER_KEY",
    "guestCharacterOwnerKey",
    `${implementation}; return { guestCharacterArtworkKey, loadGuestCharacterArtwork };`,
  );
  return { factory, ownerKey, savedKey, source };
}

function createStorage(initialEntries = []) {
  const values = new Map(initialEntries);
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    snapshot() {
      return new Map(values);
    },
  };
}

test("guest character owner keys are normalized, deterministic, safe, and name-isolated", async () => {
  const guestCharacterOwnerKey = await loadGuestOwnerKey();
  const alice = guestCharacterOwnerKey({ guest: true, name: " Alice " });
  const normalizedAlice = guestCharacterOwnerKey({ guest: true, name: "Ａlice" });
  const bob = guestCharacterOwnerKey({ guest: true, name: "Bob" });

  assert.equal(alice, normalizedAlice);
  assert.notEqual(alice, bob);
  assert.match(alice, /^guest-[0-9a-f]+$/u);
  assert.throws(
    () => guestCharacterOwnerKey({ guest: false, name: "Alice" }),
    /게스트 프로필/u,
  );

  const source = await readFile(libraryUrl, "utf8");
  const localKey = block(
    source,
    "function localProfileKey",
    "export function profileCharacterLibraryPrefix",
  );
  assert.match(localKey, /guestCharacterOwnerKey\(profile\)/u);
  assert.doesNotMatch(localKey, /\?\s*["']guest["']/u);
});

test("only one named guest can claim the untouched shared v2 artwork", async () => {
  const guestCharacterOwnerKey = await loadGuestOwnerKey();
  const { factory, ownerKey, savedKey } = await loadPageGuestStorageHelpers();
  const legacyArtwork = "data:image/png;base64,legacy";
  const storage = createStorage([[savedKey, legacyArtwork]]);
  const helpers = factory(
    { localStorage: storage },
    savedKey,
    ownerKey,
    guestCharacterOwnerKey,
  );
  const alice = { guest: true, name: "Alice" };
  const bob = { guest: true, name: "Bob" };

  assert.equal(helpers.loadGuestCharacterArtwork(alice), legacyArtwork);
  assert.equal(
    storage.getItem(ownerKey),
    guestCharacterOwnerKey(alice),
  );
  assert.equal(
    storage.getItem(helpers.guestCharacterArtworkKey(alice)),
    legacyArtwork,
  );
  assert.equal(storage.getItem(savedKey), legacyArtwork, "legacy key must remain");

  assert.equal(helpers.loadGuestCharacterArtwork(bob), null);
  assert.equal(storage.getItem(helpers.guestCharacterArtworkKey(bob)), null);
});

test("page legacy IDs and new guest saves use only the normalized name-scoped key", async () => {
  const { source } = await loadPageGuestStorageHelpers();
  const storageId = block(
    source,
    "function characterStorageId",
    "export default function Home",
  );
  assert.match(storageId, /guestCharacterOwnerKey\(profile\)/u);
  assert.doesNotMatch(storageId, /SAVED_CHARACTER_ID\}:guest/u);

  const save = block(
    source,
    "const handleSendToStudio",
    "const profileGateBlocking",
  );
  assert.match(
    save,
    /localStorage\.setItem\(guestCharacterArtworkKey\(profile\),\s*dataUrl\)/u,
  );
  assert.doesNotMatch(
    save,
    /localStorage\.setItem\(SAVED_CHARACTER_KEY,\s*dataUrl\)/u,
  );
  assert.doesNotMatch(source, /removeItem\(SAVED_CHARACTER_KEY\)/u);
});
