import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLegacyGalleryMigration,
  matchesGalleryClassFilter,
  matchesGalleryOwner,
  selectFilteredGalleryPage,
  selectGalleryPageChildren,
  shouldCleanupStagedLegacyImage,
} from "../app/lib/galleryPagingCore.mjs";

const PAGE_SIZE = 20;
const QUERY_SIZE = PAGE_SIZE + 1;

function galleryId(index) {
  return `key${String(index).padStart(17, "0")}`;
}

function records(count, valueForIndex = () => ({})) {
  return Array.from({ length: count }, (_, index) => ({
    id: galleryId(index),
    value: valueForIndex(index),
  }));
}

function queryNewestPage(allRecords, cursor = null) {
  const beforeCursor = cursor
    ? allRecords.filter((child) => child.id < cursor.id)
    : allRecords;
  return selectGalleryPageChildren(beforeCursor.slice(-QUERY_SIZE), PAGE_SIZE);
}

function scanFilteredOrderByKey(
  allRecords,
  predicate,
  cursor = null,
) {
  let scanCursor = cursor?.id ?? null;
  const scannedNewestFirst = [];
  let matchCount = 0;

  while (matchCount < QUERY_SIZE) {
    const beforeCursor = scanCursor
      ? allRecords.filter((child) => child.id < scanCursor)
      : allRecords;
    const chunk = beforeCursor.slice(-QUERY_SIZE);
    if (chunk.length === 0) break;

    for (let index = chunk.length - 1; index >= 0; index -= 1) {
      const child = chunk[index];
      scannedNewestFirst.push(child);
      if (predicate(child.value)) matchCount += 1;
      if (matchCount === QUERY_SIZE) break;
    }
    scanCursor = chunk[0].id;
  }

  return selectFilteredGalleryPage(
    scannedNewestFirst.reverse(),
    predicate,
    PAGE_SIZE,
  );
}

test("selects exact 0, 20, and 21 record page boundaries", () => {
  const empty = queryNewestPage(records(0));
  assert.deepEqual(empty, {
    selected: [],
    hasNextPage: false,
    nextCursor: null,
  });

  const exact = queryNewestPage(records(20));
  assert.equal(exact.selected.length, 20);
  assert.equal(exact.selected[0].id, galleryId(0));
  assert.equal(exact.selected.at(-1).id, galleryId(19));
  assert.equal(exact.hasNextPage, false);
  assert.equal(exact.nextCursor, null);

  const overflow = queryNewestPage(records(21));
  assert.equal(overflow.selected.length, 20);
  assert.equal(overflow.selected[0].id, galleryId(1));
  assert.equal(overflow.selected.at(-1).id, galleryId(20));
  assert.equal(overflow.hasNextPage, true);
  assert.deepEqual(overflow.nextCursor, { id: galleryId(1) });
});

test("walks 41 records without repeating the cursor record", () => {
  const allRecords = records(41);
  const first = queryNewestPage(allRecords);
  const second = queryNewestPage(allRecords, first.nextCursor);
  const third = queryNewestPage(allRecords, second.nextCursor);

  assert.deepEqual(
    [first.selected.length, second.selected.length, third.selected.length],
    [20, 20, 1],
  );
  assert.equal(first.hasNextPage, true);
  assert.equal(second.hasNextPage, true);
  assert.equal(third.hasNextPage, false);

  const ids = [first, second, third].flatMap((page) =>
    page.selected.map((child) => child.id),
  );
  assert.equal(new Set(ids).size, 41);
  assert.deepEqual([...ids].sort(), allRecords.map((child) => child.id));
  assert.equal(
    second.selected.some((child) => child.id === first.nextCursor.id),
    false,
  );
  assert.equal(
    third.selected.some((child) => child.id === second.nextCursor.id),
    false,
  );
});

test("a deletion between pages cannot duplicate or skip the remaining older keys", () => {
  const original = records(41);
  const first = queryNewestPage(original);
  const deletedCursorId = first.nextCursor.id;
  const afterDeletion = original.filter((child) => child.id !== deletedCursorId);
  const second = queryNewestPage(afterDeletion, first.nextCursor);
  const third = queryNewestPage(afterDeletion, second.nextCursor);

  assert.equal(second.selected.length, 20);
  assert.equal(second.hasNextPage, true);
  assert.equal(third.selected.length, 1);
  assert.equal(third.hasNextPage, false);
  assert.equal(
    second.selected.some((child) => child.id === deletedCursorId),
    false,
  );

  const firstIds = new Set(first.selected.map((child) => child.id));
  for (const child of [...second.selected, ...third.selected]) {
    assert.equal(firstIds.has(child.id), false);
    assert.ok(child.id < first.nextCursor.id);
  }
  assert.equal(
    new Set([...second.selected, ...third.selected].map((child) => child.id)).size,
    21,
  );
});

test("filtered orderByKey scans fill a page across sparse mixed-class chunks", () => {
  const targetClass = galleryId(900);
  const otherClass = galleryId(901);
  const allRecords = records(125, (index) => {
    if (index % 5 === 0) return { classId: targetClass, name: "민준" };
    if (index % 5 === 1) return { classId: "", name: "게스트" };
    if (index % 5 === 2) return { name: "미분류" };
    return { classId: otherClass, name: index % 2 ? "민준" : "서연" };
  });

  const targetPage = scanFilteredOrderByKey(
    allRecords,
    (value) => matchesGalleryClassFilter(value, targetClass),
  );
  assert.equal(targetPage.selected.length, 20);
  assert.equal(targetPage.hasNextPage, true);
  assert.ok(
    targetPage.selected.every(
      ({ value }) => value.classId === targetClass,
    ),
  );

  const targetOlderPage = scanFilteredOrderByKey(
    allRecords,
    (value) => matchesGalleryClassFilter(value, targetClass),
    targetPage.nextCursor,
  );
  assert.equal(targetOlderPage.selected.length, 5);
  assert.equal(targetOlderPage.hasNextPage, false);
  const targetIds = new Set([
    ...targetPage.selected,
    ...targetOlderPage.selected,
  ].map((child) => child.id));
  assert.equal(targetIds.size, 25);

  const unclassified = scanFilteredOrderByKey(
    allRecords,
    (value) => matchesGalleryClassFilter(value, "unclassified"),
  );
  assert.equal(unclassified.selected.length, 20);
  assert.ok(
    unclassified.selected.every(
      ({ value }) => !value.classId,
    ),
  );
});

test("owner matching prevents same-name records from another class leaking into AI sources", () => {
  const classA = galleryId(700);
  const classB = galleryId(701);
  assert.equal(matchesGalleryOwner({ classId: classA, name: "하늘" }, classA, "하늘"), true);
  assert.equal(matchesGalleryOwner({ classId: classB, name: "하늘" }, classA, "하늘"), false);
  assert.equal(matchesGalleryOwner({ classId: classA, name: "바다" }, classA, "하늘"), false);
  assert.equal(matchesGalleryOwner(null, classA, "하늘"), false);
});

test("legacy migration preserves metadata and removes only the embedded original", () => {
  const originalDataUrl = "data:image/png;base64,original";
  const thumbnailDataUrl = "data:image/webp;base64,thumbnail";
  const current = {
    name: "하늘",
    classId: galleryId(700),
    createdAt: 123,
    likes: { "like-a": true },
    imageDataUrl: originalDataUrl,
  };

  const migrated = applyLegacyGalleryMigration(
    current,
    originalDataUrl,
    thumbnailDataUrl,
  );
  assert.deepEqual(migrated, {
    name: "하늘",
    classId: galleryId(700),
    createdAt: 123,
    likes: { "like-a": true },
    thumbnailDataUrl,
  });
  assert.equal(current.imageDataUrl, originalDataUrl, "pure helper must not mutate transaction input");
});

test("concurrent migration loser aborts and only cleans a staged image after deletion", () => {
  const originalDataUrl = "data:image/png;base64,original";
  const initial = {
    imageDataUrl: originalDataUrl,
    createdAt: 123,
  };
  const winner = applyLegacyGalleryMigration(
    initial,
    originalDataUrl,
    "data:image/webp;base64,winner",
  );
  assert.ok(winner);

  const loser = applyLegacyGalleryMigration(
    winner,
    originalDataUrl,
    "data:image/webp;base64,loser",
  );
  assert.equal(loser, undefined, "a browser seeing the committed winner must abort");
  assert.equal(
    shouldCleanupStagedLegacyImage(true),
    false,
    "the loser must retain the shared original while metadata still exists",
  );

  assert.equal(
    applyLegacyGalleryMigration(null, originalDataUrl, "unused"),
    undefined,
  );
  assert.equal(shouldCleanupStagedLegacyImage(false), true);
  assert.equal(
    shouldCleanupStagedLegacyImage(undefined),
    false,
    "unknown read state must prefer preserving the original",
  );
});
