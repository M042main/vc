import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  getDatabase,
  limitToLast,
  onValue,
  push,
  query,
  ref,
  set,
  type DataSnapshot,
  type Database,
  type Unsubscribe,
} from "firebase/database";

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

const MAX_GALLERY_ENTRIES = 30;
const MAX_GALLERY_NAME_LENGTH = 60;
const MAX_PNG_DATA_URL_SIZE = 6 * 1024 * 1024;
const MAX_GALLERY_RECORD_BYTES = MAX_PNG_DATA_URL_SIZE + 4 * 1024;
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const PNG_BASE64_SIGNATURE = "iVBORw0KGgo";
const FIREBASE_PUSH_KEY_PATTERN = /^[-_A-Za-z0-9]{20}$/u;
const GALLERY_DELETE_API_PATH = "/api/gallery/delete";

export type GalleryEntry = {
  id: string;
  name: string;
  imageDataUrl: string;
  createdAt: number;
};

type GalleryRecord = Omit<GalleryEntry, "id">;

export type GallerySubscription = {
  onData: (entries: GalleryEntry[]) => void;
  onError: (error: Error) => void;
};

export type PublishGalleryEntryInput = Pick<
  GalleryEntry,
  "name" | "imageDataUrl"
>;

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
    throw new Error("삭제할 갤러리 항목 ID가 올바르지 않습니다.");
  }
  return value;
}

function validateRecordSize(record: GalleryRecord) {
  const byteLength = new TextEncoder().encode(JSON.stringify(record)).byteLength;
  if (byteLength > MAX_GALLERY_RECORD_BYTES) {
    throw new Error("갤러리 레코드 크기가 허용 범위를 초과했습니다.");
  }
}

function parseGalleryEntry(id: string, value: unknown): GalleryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("갤러리 레코드 형식이 올바르지 않습니다.");
  }

  const candidate = value as Record<string, unknown>;
  const record: GalleryRecord = {
    name: validateName(candidate.name),
    imageDataUrl: validatePngDataUrl(candidate.imageDataUrl),
    createdAt: validateCreatedAt(candidate.createdAt),
  };
  validateRecordSize(record);
  return { id, ...record };
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

export async function publishGalleryEntry({
  name,
  imageDataUrl,
}: PublishGalleryEntryInput): Promise<GalleryEntry> {
  const record: GalleryRecord = {
    name: validateName(name),
    imageDataUrl: validatePngDataUrl(imageDataUrl),
    createdAt: Date.now(),
  };
  validateRecordSize(record);

  const database = getGalleryDatabase();
  const entriesRef = ref(database, GALLERY_ENTRIES_PATH);
  const entryRef = push(entriesRef);
  const id = validateGalleryEntryId(entryRef.key);
  await set(entryRef, record);
  return { id, ...record };
}

export async function deleteGalleryEntry(id: string): Promise<void> {
  const validatedId = validateGalleryEntryId(id);
  let response: Response;

  try {
    response = await fetch(GALLERY_DELETE_API_PATH, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: validatedId }),
    });
  } catch (error) {
    throw new Error("관리자 삭제 요청을 전송하지 못했습니다.", {
      cause: error,
    });
  }

  if (!response.ok) {
    let message = "관리자 권한으로 캐릭터를 삭제하지 못했습니다.";
    try {
      const payload = (await response.json()) as unknown;
      if (
        payload &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        typeof (payload as Record<string, unknown>).error === "string"
      ) {
        message = (payload as Record<string, string>).error;
      }
    } catch {
      // Keep the safe fallback when an upstream response is not JSON.
    }
    throw new Error(message);
  }
}
