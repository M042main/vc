export type OrderedGalleryChild = { id: string; value: unknown };

export function selectGalleryPageChildren<T extends OrderedGalleryChild>(
  orderedChildren: readonly T[],
  pageSize: number,
): {
  selected: T[];
  hasNextPage: boolean;
  nextCursor: { id: string } | null;
};

export function selectFilteredGalleryPage<T extends OrderedGalleryChild>(
  orderedChildren: readonly T[],
  matches: (value: unknown) => boolean,
  pageSize: number,
): {
  selected: T[];
  hasNextPage: boolean;
  nextCursor: { id: string } | null;
};

export function matchesGalleryClassFilter(
  value: unknown,
  classFilter: string,
): boolean;

export function matchesGalleryOwner(
  value: unknown,
  classId: string,
  name: string,
): boolean;

export function applyLegacyGalleryMigration(
  currentValue: unknown,
  expectedOriginal: string,
  thumbnailDataUrl: string,
): Record<string, unknown> | undefined;

export function shouldCleanupStagedLegacyImage(
  entryExists: boolean,
): boolean;
