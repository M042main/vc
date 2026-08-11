import type {
  PaperDollCharacterStore,
  SavedPaperDollCharacter,
} from "./paperDollCharacterStore";
import type { SavedCharacterSlot } from "./firebaseGallery";
import {
  normalizeVisitorName,
  visitorArtworkKey,
  type VisitorProfile,
} from "./visitorProfile";

export const PROFILE_CHARACTER_LIBRARY_VERSION = "t-pose-v3";
export const PROFILE_CHARACTER_LIMIT = 3;
export type ProfileCharacterSlotId = SavedCharacterSlot["id"];

export type ProfileSavedCharacter = {
  id: ProfileCharacterSlotId;
  storageId: string;
  name: string;
  artwork: string;
  updatedAt: number;
};

const SLOT_IDS: readonly ProfileCharacterSlotId[] = [
  "slot-1",
  "slot-2",
  "slot-3",
];

export function guestCharacterOwnerKey(
  profile: Pick<VisitorProfile, "guest" | "name">,
) {
  if (!profile.guest) {
    throw new Error("게스트 캐릭터 키는 게스트 프로필에만 사용할 수 있어요.");
  }
  const normalizedName = normalizeVisitorName(profile.name);
  if (!normalizedName) throw new Error("게스트 이름을 입력해 주세요.");
  const encodedName = Array.from(
    new TextEncoder().encode(normalizedName),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `guest-${encodedName}`;
}

function localProfileKey(profile: VisitorProfile) {
  return profile.guest ? guestCharacterOwnerKey(profile) : visitorArtworkKey(profile);
}

export function profileCharacterLibraryPrefix(profile: VisitorProfile) {
  return `virtual-creator-character:${PROFILE_CHARACTER_LIBRARY_VERSION}:${localProfileKey(profile)}`;
}

export function profileCharacterStorageId(
  profile: VisitorProfile,
  slotId: ProfileCharacterSlotId,
) {
  return `${profileCharacterLibraryPrefix(profile)}:${slotId}`;
}

export function profileCharacterName(slotId: ProfileCharacterSlotId) {
  return `캐릭터 ${Number(slotId.slice(-1))}`;
}

export function nextAvailableCharacterSlot(
  characters: readonly Pick<ProfileSavedCharacter, "id">[],
): ProfileCharacterSlotId | null {
  const used = new Set(characters.map((character) => character.id));
  return SLOT_IDS.find((id) => !used.has(id)) ?? null;
}

function slotFromLocalRecord(
  profile: VisitorProfile,
  record: SavedPaperDollCharacter,
): ProfileSavedCharacter | null {
  const prefix = `${profileCharacterLibraryPrefix(profile)}:`;
  if (!record.id.startsWith(prefix)) return null;
  const id = record.id.slice(prefix.length);
  if (!SLOT_IDS.includes(id as ProfileCharacterSlotId)) return null;
  if (typeof record.artwork !== "string" || !record.artwork) return null;
  const slotId = id as ProfileCharacterSlotId;
  return {
    id: slotId,
    storageId: record.id,
    name: profileCharacterName(slotId),
    artwork: record.artwork,
    updatedAt: record.updatedAt,
  };
}

export async function loadLocalProfileCharacters(
  profile: VisitorProfile,
  store: PaperDollCharacterStore,
) {
  const records = await store.list();
  return records
    .map((record) => slotFromLocalRecord(profile, record))
    .filter((record): record is ProfileSavedCharacter => Boolean(record))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function mergeProfileCharacters(
  profile: VisitorProfile,
  localCharacters: readonly ProfileSavedCharacter[],
  cloudSlots: readonly SavedCharacterSlot[],
): ProfileSavedCharacter[] {
  const merged = new Map<ProfileCharacterSlotId, ProfileSavedCharacter>();
  for (const local of localCharacters) merged.set(local.id, local);
  for (const cloud of cloudSlots) {
    const local = merged.get(cloud.id);
    if (local && local.updatedAt > cloud.updatedAt) continue;
    merged.set(cloud.id, {
      id: cloud.id,
      storageId: profileCharacterStorageId(profile, cloud.id),
      name: profileCharacterName(cloud.id),
      artwork: cloud.imageDataUrl,
      updatedAt: cloud.updatedAt,
    });
  }
  return SLOT_IDS.flatMap((id) => {
    const character = merged.get(id);
    return character ? [character] : [];
  }).slice(0, PROFILE_CHARACTER_LIMIT);
}

export async function cacheProfileCharacters(
  profile: VisitorProfile,
  characters: readonly ProfileSavedCharacter[],
  store: PaperDollCharacterStore,
) {
  await Promise.all(
    characters.map((character) =>
      store.save({
        id: profileCharacterStorageId(profile, character.id),
        name: `${profile.className} · ${profile.name} · ${character.name}`,
        artwork: character.artwork,
        playback: { presetId: "idle", playbackRate: 1, loop: true },
      }),
    ),
  );
}
