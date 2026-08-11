import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const firebaseUrl = new URL("../app/lib/firebaseGallery.ts", import.meta.url);
const galleryUrl = new URL(
  "../app/components/OnlineGallery.tsx",
  import.meta.url,
);
const galleryCssUrl = new URL(
  "../app/components/OnlineGallery.module.css",
  import.meta.url,
);
const PRIVATE_ROOM = "/000000/박근석_t7/motion_ink_gallery_a7f3c9";

async function sources() {
  const [firebase, gallery, css] = await Promise.all([
    readFile(firebaseUrl, "utf8"),
    readFile(galleryUrl, "utf8"),
    readFile(galleryCssUrl, "utf8"),
  ]);
  return { firebase, gallery, css };
}

function block(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end >= 0, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test("stores one profile-device vote at the exact validated entry like child", async () => {
  const { firebase } = await sources();
  assert.match(
    firebase,
    new RegExp(PRIVATE_ROOM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.match(firebase, /GALLERY_LIKE_ACTOR_PATTERN\s*=\s*\/\^like-\[0-9a-f\]\{32\}\$\/u/u);
  assert.match(firebase, /import\s*\{[\s\S]{0,220}\brunTransaction\b[\s\S]{0,220}\}\s*from\s*"firebase\/database"/u);

  const toggle = block(
    firebase,
    "export async function toggleGalleryEntryLike",
    "export async function deleteGalleryEntry",
  );
  assert.match(toggle, /validateGalleryEntryId\(entryId\)/u);
  assert.match(toggle, /validateGalleryLikeActorKey\(actorKey\)/u);
  assert.match(
    toggle,
    /`\$\{GALLERY_ENTRIES_PATH\}\/\$\{id\}\/likes\/\$\{validatedActorKey\}`/u,
  );
  assert.match(toggle, /runTransaction\s*\([\s\S]{0,220}\(\)\s*=>\s*\(liked\s*\?\s*true\s*:\s*null\)/u);
  assert.match(toggle, /applyLocally:\s*true/u);
  assert.match(toggle, /`\$\{GALLERY_ENTRIES_PATH\}\/\$\{id\}\/createdAt`/u);
  assert.match(toggle, /const entryMarker = await get\s*\(/u);
  assert.match(toggle, /!entryMarker\.exists\(\)/u);
  assert.match(toggle, /await set\(likeRef,\s*null\)/u);
  assert.match(toggle, /gallery_entry_missing/u);
  assert.match(toggle, /gallery_like_write_failed/u);
});

test("uses a safe random key scoped to the active class profile and blocks guests", async () => {
  const { firebase } = await sources();
  const actor = block(
    firebase,
    "export function getGalleryLikeActorKey",
    "function validateCharacterSlotId",
  );
  assert.match(actor, /createVisitorProfile\(profile\)/u);
  assert.match(actor, /activeProfile\.guest/u);
  assert.match(actor, /visitorArtworkKey\(activeProfile\)/u);
  assert.match(actor, /localStorage\.getItem\(storageKey\)/u);
  assert.match(actor, /localStorage\.setItem\(storageKey,\s*actorKey\)/u);
  assert.match(actor, /volatileGalleryLikeActors/u);
  assert.match(firebase, /getRandomValues\(new Uint8Array\(16\)\)/u);
  assert.doesNotMatch(
    block(firebase, "function createGalleryLikeActorKey", "export function getGalleryLikeActorKey"),
    /Math\.random/u,
  );
});

test("aggregates only bounded true votes and keeps legacy entries at zero", async () => {
  const { firebase } = await sources();
  const likes = block(
    firebase,
    "function parseGalleryLikeActorKeys",
    "function parseGalleryEntry",
  );
  assert.match(likes, /!value\s*\|\|\s*typeof value\s*!==\s*"object"\s*\|\|\s*Array\.isArray\(value\)\)\s*return\s*\[\]/u);
  assert.match(likes, /candidate\[actorKey\]\s*===\s*true/u);
  assert.match(likes, /GALLERY_LIKE_ACTOR_PATTERN\.test\(actorKey\)/u);
  assert.match(likes, /MAX_GALLERY_LIKE_CHILDREN_INSPECTED/u);
  assert.match(likes, /MAX_GALLERY_LIKES/u);

  const parser = block(firebase, "function parseGalleryEntry", "function entriesFromSnapshot");
  assert.match(parser, /validateGalleryEntryId\(id\)/u);
  assert.match(parser, /parseGalleryLikeActorKeys\(candidate\.likes\)/u);
  assert.match(parser, /likeCount:\s*likeActorKeys\.length/u);
  assert.match(parser, /likeActorKeys/u);
});

test("renders accessible optimistic heart toggles with per-card race and error state", async () => {
  const { gallery, css } = await sources();
  assert.match(gallery, /getGalleryLikeActorKey\(profile\)/u);
  assert.match(gallery, /likeInFlightRef\.current\.has\(entry\.id\)/u);
  assert.match(gallery, /likeInFlightRef\.current\.add\(entry\.id\)/u);
  assert.match(gallery, /setOptimisticLikes/u);
  assert.match(gallery, /toggleGalleryEntryLike\s*\(\{[\s\S]{0,180}entryId:\s*entry\.id[\s\S]{0,180}liked:\s*nextLiked/u);
  assert.match(gallery, /finally\s*\{[\s\S]{0,180}likeInFlightRef\.current\.delete\(entry\.id\)[\s\S]{0,500}delete next\[entry\.id\][\s\S]{0,500}next\.delete\(entry\.id\)/u);
  assert.match(gallery, /<Heart[\s\S]{0,180}fill=\{displayedLiked/u);
  assert.match(gallery, /aria-pressed=\{displayedLiked\}/u);
  assert.match(gallery, /현재 \$\{displayedLikeCount\}개/u);
  assert.match(gallery, /likeErrors\[entry\.id\][\s\S]{0,180}role="alert"/u);
  assert.match(gallery, /error instanceof AggregateError[\s\S]{0,120}setActionMessage\(error\.message\)/u);
  assert.match(gallery, /게스트는 로컬 체험만 가능/u);
  assert.match(css, /\.likeButton\[data-liked="true"\]/u);
});

test("removes the manual upload surface and leaves download as a labelled icon", async () => {
  const { gallery, css } = await sources();
  assert.doesNotMatch(gallery, /publishGalleryEntry|requestUpload|uploadCapture/u);
  assert.doesNotMatch(gallery, /갤러리에 올리기|PNG 받기|현재 캡처를 올리고/u);
  assert.doesNotMatch(css, /\.uploadButton|\.capturePanel/u);
  assert.match(gallery, /<Download\s+size=\{17\}\s+aria-hidden="true"\s*\/>/u);
  assert.match(gallery, /aria-label=\{[\s\S]{0,180}캐릭터 PNG 다운로드/u);
  assert.match(gallery, /title=\{`\$\{entry\.name\}님의 캐릭터 PNG 다운로드`\}/u);
  assert.match(gallery, /게스트 체험에서는 캐릭터와 캡처가 이 기기에만 남습니다/u);
});
