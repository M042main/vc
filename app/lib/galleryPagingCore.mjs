export function selectGalleryPageChildren(orderedChildren, pageSize) {
  const hasNextPage = orderedChildren.length > pageSize;
  const selected = orderedChildren.slice(-pageSize);
  return {
    selected,
    hasNextPage,
    nextCursor:
      hasNextPage && selected[0]?.id ? { id: selected[0].id } : null,
  };
}

export function selectFilteredGalleryPage(orderedChildren, matches, pageSize) {
  return selectGalleryPageChildren(
    orderedChildren.filter((child) => matches(child.value)),
    pageSize,
  );
}

export function matchesGalleryClassFilter(value, classFilter) {
  if (classFilter === "all") return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (classFilter === "unclassified") {
    return typeof value.classId !== "string" || value.classId.length === 0;
  }
  return value.classId === classFilter;
}

export function matchesGalleryOwner(value, classId, name) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.classId === classId &&
      value.name === name,
  );
}

export function applyLegacyGalleryMigration(
  currentValue,
  expectedOriginal,
  thumbnailDataUrl,
) {
  if (
    !currentValue ||
    typeof currentValue !== "object" ||
    Array.isArray(currentValue) ||
    currentValue.imageDataUrl !== expectedOriginal
  ) {
    return undefined;
  }
  const next = { ...currentValue, thumbnailDataUrl };
  delete next.imageDataUrl;
  return next;
}

export function shouldCleanupStagedLegacyImage(entryExists) {
  return entryExists === false;
}
