import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  equalTo,
  get,
  getDatabase,
  limitToLast,
  onValue,
  orderByChild,
  push,
  query,
  ref,
  runTransaction,
  set,
  update,
  type DataSnapshot,
  type Database,
  type Unsubscribe,
} from "firebase/database";
import {
  createVisitorProfile,
  visitorArtworkKey,
  type VisitorProfile,
} from "./visitorProfile";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDbqMEThRW9pXEbi-HuTpAgUzTcnCO_Luo",
  authDomain: "project-001-e7851.firebaseapp.com",
  databaseURL:
    "https://project-001-e7851-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "project-001-e7851",
  storageBucket: "project-001-e7851.firebasestorage.app",
  messagingSenderId: "99497999479",
  appId: "1:99497999479:web:5d0f8895eb9647b9419a72",
  measurementId: "G-XY9MGZ60E2",
} as const;

const FIREBASE_APP_NAME = "motion-ink-gallery-a7f3c9";
// 이 부분은 우리 반 공용 데이터베이스에서 내 방을 만드는 주소입니다
export const GALLERY_DATABASE_PATH =
  "/000000/박근석_t7/motion_ink_gallery_a7f3c9";
const GALLERY_ENTRIES_PATH = `${GALLERY_DATABASE_PATH}/entries`;
const GALLERY_CLASSES_PATH = `${GALLERY_DATABASE_PATH}/classes`;
const GALLERY_ARTWORKS_PATH = `${GALLERY_DATABASE_PATH}/artworks`;

// Keep three numbered pages available while bounding Firebase Data URL memory.
const MAX_GALLERY_ENTRIES = 90;
const MAX_AI_SOURCE_ENTRIES = 12;
const MAX_GALLERY_NAME_LENGTH = 60;
const MAX_PNG_DATA_URL_SIZE = 6 * 1024 * 1024;
const MAX_GALLERY_RECORD_BYTES = MAX_PNG_DATA_URL_SIZE + 4 * 1024;
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const PNG_BASE64_SIGNATURE = "iVBORw0KGgo";
const FIREBASE_PUSH_KEY_PATTERN = /^[-_A-Za-z0-9]{20}$/u;
const GALLERY_DELETE_API_PATH = "/api/gallery/delete";
const GALLERY_CLASSES_API_PATH = "/api/gallery/classes";
const MAX_CLASS_NAME_LENGTH = 40;
const CHARACTER_SLOT_PATTERN = /^slot-[1-3]$/u;
const GALLERY_LIKE_ACTOR_PATTERN = /^like-[0-9a-f]{32}$/u;
const GALLERY_LIKE_ACTOR_STORAGE_PREFIX =
  "virtual-creator.gallery-like-actor.v1";
const MAX_GALLERY_LIKES = 10_000;
const MAX_GALLERY_LIKE_CHILDREN_INSPECTED = MAX_GALLERY_LIKES * 2;
const volatileGalleryLikeActors = new Map<string, string>();
export const MAX_SAVED_CHARACTERS = 3;

export type GalleryEntry = {
  id: string;
  name: string;
  classId: string | null;
  className: string | null;
  imageDataUrl: string;
  createdAt: number;
  likeCount: number;
  likeActorKeys: readonly string[];
};

type GalleryRecord = Omit<
  GalleryEntry,
  "id" | "likeCount" | "likeActorKeys"
>;

export type ClassRecord = {
  id: string;
  name: string;
  createdAt: number;
  aiEnabled: boolean;
};

export type SavedCharacterArtwork = {
  name: string;
  classId: string;
  className: string;
  imageDataUrl: string;
  updatedAt: number;
};

export type SavedCharacterSlot = SavedCharacterArtwork & {
  id: `slot-${1 | 2 | 3}`;
};

export type GallerySubscription = {
  onData: (entries: GalleryEntry[]) => void;
  onError: (error: Error) => void;
};

export type PublishGalleryEntryInput = {
  profile: VisitorProfile;
  imageDataUrl: string;
};

export type ToggleGalleryEntryLikeInput = {
  entryId: string;
  actorKey: string;
  liked: boolean;
};

export class GalleryServiceError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(
    message: string,
    options: {
      code: string;
      retryable?: boolean;
      status?: number | null;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "GalleryServiceError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
  }
}

export function isRetryableGalleryServiceError(
  error: unknown,
): error is GalleryServiceError {
  return error instanceof GalleryServiceError && error.retryable;
}

function getGalleryApp(): FirebaseApp {
  const existingApp = getApps().find((app) => app.name === FIREBASE_APP_NAME);
  if (existingApp) return getApp(FIREBASE_APP_NAME);
  return initializeApp(FIREBASE_CONFIG, FIREBASE_APP_NAME);
}

function getGalleryDatabase(): Database {
  return getDatabase(getGalleryApp());
}

function toError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) return error;
  return new Error(fallbackMessage, { cause: error });
}

function classReadError(error: unknown): GalleryServiceError {
  const rawCode =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code).toLowerCase()
      : "";
  const permissionDenied = rawCode.includes("permission");
  return new GalleryServiceError(
    permissionDenied
      ? "Firebase에서 학급 목록 읽기 권한이 거부되었습니다. 데이터베이스 규칙을 확인해 주세요."
      : "학급 목록 서비스에 연결하지 못했습니다. 네트워크 연결을 확인하고 다시 시도해 주세요.",
    {
      code: permissionDenied
        ? "firebase_permission_denied"
        : "firebase_class_read_failed",
      retryable: !permissionDenied,
      status: null,
      cause: error,
    },
  );
}

function validateName(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("캐릭터 이름은 문자열이어야 합니다.");
  }

  const name = value.normalize("NFC").trim();
  if (!name) throw new Error("캐릭터 이름을 입력해 주세요.");
  if (Array.from(name).length > MAX_GALLERY_NAME_LENGTH) {
    throw new Error(
      `캐릭터 이름은 ${MAX_GALLERY_NAME_LENGTH}자 이하로 입력해 주세요.`,
    );
  }
  if (
    Array.from(name).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error("캐릭터 이름에는 제어 문자를 사용할 수 없습니다.");
  }
  return name;
}

function validateClassName(value: unknown): string {
  if (typeof value !== "string") throw new Error("학급 이름이 올바르지 않습니다.");
  const name = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!name || Array.from(name).length > MAX_CLASS_NAME_LENGTH) {
    throw new Error(`학급 이름은 ${MAX_CLASS_NAME_LENGTH}자 이하로 입력해 주세요.`);
  }
  if (
    Array.from(name).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error("학급 이름에는 제어 문자를 사용할 수 없습니다.");
  }
  return name;
}

function validatePngDataUrl(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("data:image/png;base64,")
  ) {
    throw new Error("이미지는 PNG Data URL 형식이어야 합니다.");
  }
  if (value.length > MAX_PNG_DATA_URL_SIZE) {
    throw new Error("PNG 이미지는 Data URL 기준 6MB 이하여야 합니다.");
  }

  const payload = value.slice(PNG_DATA_URL_PREFIX.length);
  if (
    !payload.startsWith(PNG_BASE64_SIGNATURE) ||
    payload.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(payload)
  ) {
    throw new Error("올바른 Base64 PNG 이미지가 아닙니다.");
  }
  return value;
}

function validateCreatedAt(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new Error("갤러리 생성 시간이 올바르지 않습니다.");
  }
  return value;
}

function validateGalleryEntryId(value: unknown): string {
  if (typeof value !== "string" || !FIREBASE_PUSH_KEY_PATTERN.test(value)) {
    throw new Error("갤러리 항목 ID가 올바르지 않습니다.");
  }
  return value;
}

function validateGalleryLikeActorKey(value: unknown): string {
  if (typeof value !== "string" || !GALLERY_LIKE_ACTOR_PATTERN.test(value)) {
    throw new Error("좋아요 사용자 키가 올바르지 않습니다.");
  }
  return value;
}

function createGalleryLikeActorKey() {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) {
    throw new Error("이 브라우저에서는 안전한 좋아요 사용자 키를 만들 수 없습니다.");
  }
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  const encoded = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return validateGalleryLikeActorKey(`like-${encoded}`);
}

export function getGalleryLikeActorKey(profile: VisitorProfile): string {
  const activeProfile = createVisitorProfile(profile);
  if (activeProfile.guest || !activeProfile.classId) {
    throw new Error("게스트 체험에서는 온라인 좋아요를 사용할 수 없습니다.");
  }
  const profileKey = visitorArtworkKey(activeProfile);
  const storageKey = `${GALLERY_LIKE_ACTOR_STORAGE_PREFIX}:${profileKey}`;

  if (typeof window !== "undefined") {
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored) return validateGalleryLikeActorKey(stored);
    } catch {
      // A stable in-memory key still prevents duplicate clicks in this session.
    }
  }

  const volatileActor = volatileGalleryLikeActors.get(profileKey);
  if (volatileActor) return volatileActor;
  const actorKey = createGalleryLikeActorKey();
  volatileGalleryLikeActors.set(profileKey, actorKey);

  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(storageKey, actorKey);
      const persisted = window.localStorage.getItem(storageKey);
      if (persisted) {
        const persistedActor = validateGalleryLikeActorKey(persisted);
        volatileGalleryLikeActors.set(profileKey, persistedActor);
        return persistedActor;
      }
    } catch {
      // Private browsing can deny storage; keep the session-scoped key above.
    }
  }
  return actorKey;
}

function validateCharacterSlotId(value: unknown): SavedCharacterSlot["id"] {
  if (typeof value !== "string" || !CHARACTER_SLOT_PATTERN.test(value)) {
    throw new Error("캐릭터 저장 칸은 1번부터 3번까지만 사용할 수 있습니다.");
  }
  return value as SavedCharacterSlot["id"];
}

function parseSavedCharacterArtwork(
  value: unknown,
  expectedProfile: VisitorProfile,
): SavedCharacterArtwork | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  try {
    const record: SavedCharacterArtwork = {
      name: validateName(candidate.name),
      classId: validateGalleryEntryId(candidate.classId),
      className: validateClassName(candidate.className),
      imageDataUrl: validatePngDataUrl(candidate.imageDataUrl),
      updatedAt: validateCreatedAt(candidate.updatedAt),
    };
    return record.classId === expectedProfile.classId &&
      record.name === expectedProfile.name
      ? record
      : null;
  } catch {
    return null;
  }
}

function validateRecordSize(record: GalleryRecord) {
  const byteLength = new TextEncoder().encode(JSON.stringify(record)).byteLength;
  if (byteLength > MAX_GALLERY_RECORD_BYTES) {
    throw new Error("갤러리 레코드 크기가 허용 범위를 초과했습니다.");
  }
}

function parseGalleryLikeActorKeys(value: unknown): readonly string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const candidate = value as Record<string, unknown>;
  const actorKeys: string[] = [];
  let inspected = 0;
  for (const actorKey in candidate) {
    if (!Object.prototype.hasOwnProperty.call(candidate, actorKey)) continue;
    inspected += 1;
    if (inspected > MAX_GALLERY_LIKE_CHILDREN_INSPECTED) break;
    if (
      candidate[actorKey] === true &&
      GALLERY_LIKE_ACTOR_PATTERN.test(actorKey)
    ) {
      actorKeys.push(actorKey);
      if (actorKeys.length >= MAX_GALLERY_LIKES) break;
    }
  }
  return actorKeys.sort();
}

function parseGalleryEntry(id: string, value: unknown): GalleryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("갤러리 레코드 형식이 올바르지 않습니다.");
  }

  const validatedId = validateGalleryEntryId(id);
  const candidate = value as Record<string, unknown>;
  const hasClassMetadata =
    typeof candidate.classId === "string" &&
    FIREBASE_PUSH_KEY_PATTERN.test(candidate.classId) &&
    typeof candidate.className === "string";
  const record: GalleryRecord = {
    name: validateName(candidate.name),
    classId: hasClassMetadata ? candidate.classId as string : null,
    className: hasClassMetadata ? validateClassName(candidate.className) : null,
    imageDataUrl: validatePngDataUrl(candidate.imageDataUrl),
    createdAt: validateCreatedAt(candidate.createdAt),
  };
  validateRecordSize(record);
  const likeActorKeys = parseGalleryLikeActorKeys(candidate.likes);
  return {
    id: validatedId,
    ...record,
    likeCount: likeActorKeys.length,
    likeActorKeys,
  };
}

function entriesFromSnapshot(snapshot: DataSnapshot) {
  const entries: GalleryEntry[] = [];
  const errors: Error[] = [];

  snapshot.forEach((child) => {
    if (!child.key) return;
    try {
      entries.push(parseGalleryEntry(child.key, child.val()));
    } catch (error) {
      errors.push(
        toError(error, `갤러리 항목 ${child.key}을(를) 읽지 못했습니다.`),
      );
    }
  });

  entries.sort(
    (left, right) =>
      right.createdAt - left.createdAt || right.id.localeCompare(left.id),
  );
  return { entries, errors };
}

function classesFromSnapshot(snapshot: DataSnapshot): ClassRecord[] {
  const classes: ClassRecord[] = [];
  snapshot.forEach((child) => {
    if (!child.key || !FIREBASE_PUSH_KEY_PATTERN.test(child.key)) return;
    const value = child.val() as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const candidate = value as Record<string, unknown>;
    try {
      classes.push({
        id: child.key,
        name: validateClassName(candidate.name),
        createdAt: validateCreatedAt(candidate.createdAt),
        // Classes created before this setting existed keep AI access enabled.
        aiEnabled: candidate.aiEnabled !== false,
      });
    } catch {
      // Invalid shared records are omitted without hiding the usable class list.
    }
  });
  return classes.sort(
    (left, right) => left.name.localeCompare(right.name, "ko") || left.id.localeCompare(right.id),
  );
}

export function subscribeGalleryEntries({
  onData,
  onError,
}: GallerySubscription): Unsubscribe {
  const database = getGalleryDatabase();
  const entriesQuery = query(
    ref(database, GALLERY_ENTRIES_PATH),
    limitToLast(MAX_GALLERY_ENTRIES),
  );

  return onValue(
    entriesQuery,
    (snapshot) => {
      const { entries, errors } = entriesFromSnapshot(snapshot);
      onData(entries);
      if (errors.length > 0) {
        onError(
          new AggregateError(
            errors,
            `유효하지 않은 갤러리 항목 ${errors.length}개를 제외했습니다.`,
          ),
        );
      }
    },
    (error) => onError(toError(error, "온라인 갤러리를 불러오지 못했습니다.")),
  );
}

export function subscribeGalleryEntriesForProfile(
  profile: VisitorProfile,
  { onData, onError }: GallerySubscription,
): Unsubscribe {
  const activeProfile = createVisitorProfile(profile);
  if (activeProfile.guest || !activeProfile.classId) {
    throw new Error("게스트는 개인 갤러리 사진을 불러올 수 없습니다.");
  }

  const database = getGalleryDatabase();
  const entriesQuery = query(
    ref(database, GALLERY_ENTRIES_PATH),
    orderByChild("name"),
    equalTo(activeProfile.name),
    limitToLast(MAX_AI_SOURCE_ENTRIES),
  );

  return onValue(
    entriesQuery,
    (snapshot) => {
      const { entries, errors } = entriesFromSnapshot(snapshot);
      onData(
        entries.filter(
          (entry) => entry.classId === activeProfile.classId,
        ),
      );
      if (errors.length > 0) {
        onError(
          new AggregateError(
            errors,
            `유효하지 않은 개인 갤러리 항목 ${errors.length}개를 제외했습니다.`,
          ),
        );
      }
    },
    (error) =>
      onError(toError(error, "내 갤러리 사진을 불러오지 못했습니다.")),
  );
}

export function subscribeClassRecords({
  onData,
  onError,
}: {
  onData: (classes: ClassRecord[]) => void;
  onError: (error: Error) => void;
}): Unsubscribe {
  const database = getGalleryDatabase();
  return onValue(
    ref(database, GALLERY_CLASSES_PATH),
    (snapshot) => onData(classesFromSnapshot(snapshot)),
    (error) => onError(classReadError(error)),
  );
}

async function requireActiveClass(profile: VisitorProfile): Promise<ClassRecord> {
  if (profile.guest || !profile.classId) {
    throw new Error("게스트는 클라우드 저장을 사용할 수 없습니다.");
  }
  const GALLERY_CLASS_PATH = `${GALLERY_CLASSES_PATH}/${profile.classId}`;
  const database = getGalleryDatabase();
  let snapshot: DataSnapshot;
  try {
    snapshot = await get(ref(database, GALLERY_CLASS_PATH));
  } catch (error) {
    throw classReadError(error);
  }
  if (!snapshot.exists()) throw new Error("선택한 학급이 더 이상 존재하지 않습니다.");
  const value = snapshot.val() as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("선택한 학급 정보가 올바르지 않습니다.");
  }
  const candidate = value as Record<string, unknown>;
  return {
    id: profile.classId,
    name: validateClassName(candidate.name),
    createdAt: validateCreatedAt(candidate.createdAt),
    aiEnabled: candidate.aiEnabled !== false,
  };
}

export async function publishGalleryEntry({
  profile,
  imageDataUrl,
}: PublishGalleryEntryInput): Promise<GalleryEntry> {
  const activeProfile = createVisitorProfile(profile);
  if (activeProfile.guest || !activeProfile.classId) {
    throw new Error("게스트는 온라인 갤러리에 저장할 수 없습니다.");
  }
  const activeClass = await requireActiveClass(activeProfile);
  const record: GalleryRecord = {
    name: validateName(activeProfile.name),
    classId: activeProfile.classId,
    className: activeClass.name,
    imageDataUrl: validatePngDataUrl(imageDataUrl),
    createdAt: Date.now(),
  };
  validateRecordSize(record);

  const database = getGalleryDatabase();
  const entriesRef = ref(database, GALLERY_ENTRIES_PATH);
  const entryRef = push(entriesRef);
  const id = validateGalleryEntryId(entryRef.key);
  await set(entryRef, record);
  return { id, ...record, likeCount: 0, likeActorKeys: [] };
}

export async function toggleGalleryEntryLike({
  entryId,
  actorKey,
  liked,
}: ToggleGalleryEntryLikeInput): Promise<boolean> {
  const id = validateGalleryEntryId(entryId);
  const validatedActorKey = validateGalleryLikeActorKey(actorKey);
  const database = getGalleryDatabase();
  const likeRef = ref(
    database,
    `${GALLERY_ENTRIES_PATH}/${id}/likes/${validatedActorKey}`,
  );

  try {
    const result = await runTransaction(
      likeRef,
      () => (liked ? true : null),
      { applyLocally: true },
    );
    if (!result.committed) {
      throw new Error("좋아요 변경이 완료되지 않았습니다.");
    }
    const entryMarker = await get(
      ref(database, `${GALLERY_ENTRIES_PATH}/${id}/createdAt`),
    );
    if (!entryMarker.exists()) {
      await set(likeRef, null);
      throw new GalleryServiceError(
        "삭제된 캐릭터에는 좋아요를 남길 수 없습니다.",
        {
          code: "gallery_entry_missing",
          retryable: false,
          status: null,
        },
      );
    }
    return result.snapshot.val() === true;
  } catch (error) {
    if (error instanceof GalleryServiceError) throw error;
    throw new GalleryServiceError(
      liked
        ? "좋아요를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요."
        : "좋아요 취소를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      {
        code: "gallery_like_write_failed",
        retryable: true,
        status: null,
        cause: error,
      },
    );
  }
}

export async function deleteGalleryEntry(id: string): Promise<void> {
  const validatedId = validateGalleryEntryId(id);
  let response: Response;

  try {
    response = await fetch(GALLERY_DELETE_API_PATH, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ id: validatedId }),
    });
  } catch (error) {
    throw new GalleryServiceError(
      "관리자 삭제 요청을 전송하지 못했습니다. 네트워크 연결을 확인하고 다시 시도해 주세요.",
      {
        code: "gallery_api_unreachable",
        retryable: true,
        status: null,
        cause: error,
      },
    );
  }

  if (!response.ok) {
    throw await apiError(
      response,
      "관리자 권한으로 캐릭터를 삭제하지 못했습니다.",
    );
  }
}

export async function deleteAllGalleryEntries(): Promise<void> {
  let response: Response;
  try {
    response = await fetch(GALLERY_DELETE_API_PATH, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        all: true,
        confirmation: "DELETE_ALL_GALLERY",
      }),
    });
  } catch (error) {
    throw new GalleryServiceError(
      "관리자 전체 삭제 요청을 전송하지 못했습니다. 네트워크 연결을 확인하고 다시 시도해 주세요.",
      {
        code: "gallery_api_unreachable",
        retryable: true,
        status: null,
        cause: error,
      },
    );
  }
  if (!response.ok) {
    throw await apiError(
      response,
      "관리자 권한으로 갤러리 사진 전체를 삭제하지 못했습니다.",
    );
  }
}

async function apiError(
  response: Response,
  fallback: string,
): Promise<GalleryServiceError> {
  let message = fallback;
  let code = "gallery_api_error";
  let retryable = response.status >= 500;
  try {
    const payload = (await response.json()) as unknown;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const candidate = payload as Record<string, unknown>;
      if (typeof candidate.error === "string" && candidate.error) {
        message = candidate.error;
      }
      if (typeof candidate.code === "string" && candidate.code) {
        code = candidate.code;
      }
      if (typeof candidate.retryable === "boolean") {
        retryable = candidate.retryable;
      }
    }
  } catch {
    // Keep the safe fallback for non-JSON failures.
  }
  return new GalleryServiceError(message, {
    code,
    retryable,
    status: response.status,
  });
}

async function classManagementRequest(
  method: "POST" | "PATCH" | "DELETE",
  payload: Record<string, unknown>,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(GALLERY_CLASSES_API_PATH, {
      method,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new GalleryServiceError(
      "학급 관리 서비스에 연결하지 못했습니다. 네트워크 연결을 확인하고 다시 시도해 주세요.",
      {
        code: "class_api_unreachable",
        retryable: true,
        status: null,
        cause: error,
      },
    );
  }
  if (!response.ok) {
    throw await apiError(response, "학급 관리 요청을 완료하지 못했습니다.");
  }
  return response;
}

export async function createClassRecord(name: string): Promise<ClassRecord> {
  const validatedName = validateClassName(name);
  const response = await classManagementRequest("POST", {
    name: validatedName,
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new GalleryServiceError("학급 생성 응답을 읽지 못했습니다.", {
      code: "class_api_invalid_response",
      retryable: true,
      status: response.status,
      cause: error,
    });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new GalleryServiceError("학급 생성 응답이 올바르지 않습니다.", {
      code: "class_api_invalid_response",
      status: response.status,
    });
  }
  const candidate = (payload as Record<string, unknown>).classRecord;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new GalleryServiceError("학급 생성 응답이 올바르지 않습니다.", {
      code: "class_api_invalid_response",
      status: response.status,
    });
  }
  const record = candidate as Record<string, unknown>;
  return {
    id: validateGalleryEntryId(record.id),
    name: validateClassName(record.name),
    createdAt: validateCreatedAt(record.createdAt),
    aiEnabled: record.aiEnabled !== false,
  };
}

export async function setClassAiEnabled(
  id: string,
  aiEnabled: boolean,
): Promise<void> {
  const validatedId = validateGalleryEntryId(id);
  if (typeof aiEnabled !== "boolean") {
    throw new Error("AI 이미지 생성 설정이 올바르지 않습니다.");
  }
  await classManagementRequest("PATCH", { id: validatedId, aiEnabled });
}

export async function deleteClassRecord(id: string): Promise<void> {
  const validatedId = validateGalleryEntryId(id);
  await classManagementRequest("DELETE", { id: validatedId });
}

export async function saveLatestCharacterArtwork(
  profile: VisitorProfile,
  imageDataUrl: string,
): Promise<SavedCharacterArtwork> {
  const activeProfile = createVisitorProfile(profile);
  if (activeProfile.guest || !activeProfile.classId) {
    throw new Error("게스트는 클라우드 작품 저장을 사용할 수 없습니다.");
  }
  const activeClass = await requireActiveClass(activeProfile);
  const record: SavedCharacterArtwork = {
    name: validateName(activeProfile.name),
    classId: activeProfile.classId,
    className: activeClass.name,
    imageDataUrl: validatePngDataUrl(imageDataUrl),
    updatedAt: Date.now(),
  };
  const key = visitorArtworkKey(activeProfile);
  const GALLERY_ARTWORK_PATH = `${GALLERY_ARTWORKS_PATH}/${key}`;
  const database = getGalleryDatabase();
  // Preserve the optional three-slot library while updating the legacy/latest
  // fields used by older deployed clients.
  await update(ref(database, GALLERY_ARTWORK_PATH), record);
  return record;
}

export async function loadLatestCharacterArtwork(
  profile: VisitorProfile,
): Promise<SavedCharacterArtwork | null> {
  const activeProfile = createVisitorProfile(profile);
  if (activeProfile.guest || !activeProfile.classId) return null;
  const key = visitorArtworkKey(activeProfile);
  const GALLERY_ARTWORK_PATH = `${GALLERY_ARTWORKS_PATH}/${key}`;
  const database = getGalleryDatabase();
  const snapshot = await get(ref(database, GALLERY_ARTWORK_PATH));
  if (!snapshot.exists()) return null;
  const value = snapshot.val() as unknown;
  const legacy = parseSavedCharacterArtwork(value, activeProfile);
  if (legacy) return legacy;
  const slots = await loadSavedCharacterSlots(activeProfile, value);
  return slots[0] ?? null;
}

function slotsFromArtworkRoot(
  value: unknown,
  activeProfile: VisitorProfile,
): SavedCharacterSlot[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const slotsValue = (value as Record<string, unknown>).slots;
  if (!slotsValue || typeof slotsValue !== "object" || Array.isArray(slotsValue)) {
    return [];
  }
  const slots: SavedCharacterSlot[] = [];
  for (const [id, candidate] of Object.entries(slotsValue)) {
    try {
      const slotId = validateCharacterSlotId(id);
      const record = parseSavedCharacterArtwork(candidate, activeProfile);
      if (record) slots.push({ id: slotId, ...record });
    } catch {
      // Ignore invalid shared records without hiding valid saved characters.
    }
  }
  return slots.sort(
    (left, right) =>
      right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
  );
}

export async function loadSavedCharacterSlots(
  profile: VisitorProfile,
  prefetchedRoot?: unknown,
): Promise<SavedCharacterSlot[]> {
  const activeProfile = createVisitorProfile(profile);
  if (activeProfile.guest || !activeProfile.classId) return [];
  const key = visitorArtworkKey(activeProfile);
  let rootValue = prefetchedRoot;
  if (rootValue === undefined) {
    const database = getGalleryDatabase();
    const snapshot = await get(
      ref(database, `${GALLERY_ARTWORKS_PATH}/${key}`),
    );
    if (!snapshot.exists()) return [];
    rootValue = snapshot.val() as unknown;
  }
  const slots = slotsFromArtworkRoot(rootValue, activeProfile);
  if (slots.length > 0) return slots.slice(0, MAX_SAVED_CHARACTERS);

  // A previous deployment stored one latest record directly at this path.
  // Expose it as slot 1 without deleting or rewriting the original record.
  const legacy = parseSavedCharacterArtwork(rootValue, activeProfile);
  return legacy ? [{ id: "slot-1", ...legacy }] : [];
}

export async function saveCharacterSlot(
  profile: VisitorProfile,
  slotId: SavedCharacterSlot["id"],
  imageDataUrl: string,
): Promise<SavedCharacterSlot> {
  const activeProfile = createVisitorProfile(profile);
  if (activeProfile.guest || !activeProfile.classId) {
    throw new Error("게스트는 클라우드 작품 저장을 사용할 수 없습니다.");
  }
  const id = validateCharacterSlotId(slotId);
  const activeClass = await requireActiveClass(activeProfile);
  const record: SavedCharacterArtwork = {
    name: validateName(activeProfile.name),
    classId: activeProfile.classId,
    className: activeClass.name,
    imageDataUrl: validatePngDataUrl(imageDataUrl),
    updatedAt: Date.now(),
  };
  const key = visitorArtworkKey(activeProfile);
  const database = getGalleryDatabase();
  await update(ref(database, `${GALLERY_ARTWORKS_PATH}/${key}`), {
    ...record,
    [`slots/${id}`]: record,
  });
  return { id, ...record };
}

export async function deleteCharacterSlot(
  profile: VisitorProfile,
  slotId: SavedCharacterSlot["id"],
): Promise<void> {
  const activeProfile = createVisitorProfile(profile);
  if (activeProfile.guest || !activeProfile.classId) {
    throw new Error("게스트는 클라우드 작품 저장을 사용할 수 없습니다.");
  }
  const id = validateCharacterSlotId(slotId);
  const key = visitorArtworkKey(activeProfile);
  const database = getGalleryDatabase();
  const rootRef = ref(database, `${GALLERY_ARTWORKS_PATH}/${key}`);
  const snapshot = await get(rootRef);
  if (!snapshot.exists()) return;
  const rootValue = snapshot.val() as unknown;
  const actualSlots = slotsFromArtworkRoot(rootValue, activeProfile);

  // Legacy-only data is represented as slot 1 by loadSavedCharacterSlots.
  if (actualSlots.length === 0) {
    if (id === "slot-1") await set(rootRef, null);
    return;
  }

  const remaining = actualSlots.filter((slot) => slot.id !== id);
  if (remaining.length === actualSlots.length) return;
  if (remaining.length === 0) {
    await set(rootRef, null);
    return;
  }
  const newest = remaining[0];
  await update(rootRef, {
    [`slots/${id}`]: null,
    name: newest.name,
    classId: newest.classId,
    className: newest.className,
    imageDataUrl: newest.imageDataUrl,
    updatedAt: newest.updatedAt,
  });
}
