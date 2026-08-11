/**
 * Best-effort, device-local persistence for the studio.
 *
 * Large VRM/background blobs stay in IndexedDB. Small stage settings are also
 * mirrored to localStorage so private browsing, quota limits, or an unavailable
 * IndexedDB never prevent the live studio from working.
 */

export const MAX_PERSISTED_VRM_BYTES = 80 * 1024 * 1024;
export const MAX_STAGE_BACKGROUND_BYTES = 12 * 1024 * 1024;
export const STAGE_BACKGROUND_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type StudioBackgroundFit = "cover" | "contain";
export type StudioBackgroundMode = "solid" | "image";
export type PersistedMotionId = "idle" | "walk" | "dance" | "greeting";

export interface StudioSettings {
  stageColor: string;
  backgroundMode: StudioBackgroundMode;
  backgroundFit: StudioBackgroundFit;
  selectedMotion: PersistedMotionId;
  animationSpeed: number;
  legsLocked: boolean;
}

export interface PersistedStageBackground {
  blob: Blob;
  name: string;
  type: (typeof STAGE_BACKGROUND_TYPES)[number];
  size: number;
  savedAt: number;
}

export interface PersistedVrmFile {
  file: File;
  name: string;
  size: number;
  savedAt: number;
}

export interface PersistedStudioSnapshot {
  settings: StudioSettings | null;
  background: PersistedStageBackground | null;
  vrm: PersistedVrmFile | null;
}

export type StudioPersistenceResult =
  | { ok: true }
  | { ok: false; reason: "unsupported" | "quota" | "unavailable" };

type StoredSettingsRecord = StudioSettings & {
  key: "settings";
  version: 1;
};

type StoredBackgroundRecord = Omit<PersistedStageBackground, "blob"> & {
  key: "background";
  version: 1;
  blob: Blob;
};

type StoredVrmRecord = {
  key: "vrm";
  version: 1;
  blob: Blob;
  name: string;
  type: string;
  size: number;
  lastModified: number;
  savedAt: number;
};

type StoredStudioRecord =
  | StoredSettingsRecord
  | StoredBackgroundRecord
  | StoredVrmRecord;

const DATABASE_NAME = "virtual-creator-studio";
const DATABASE_VERSION = 1;
const STORE_NAME = "studio-state";
const SETTINGS_FALLBACK_KEY = "virtual-creator-studio-settings-v1";
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const MOTION_IDS = new Set<PersistedMotionId>([
  "idle",
  "walk",
  "dance",
  "greeting",
]);
const PLAYBACK_SPEEDS = new Set([0.75, 1, 1.25, 1.5]);
const BACKGROUND_TYPES = new Set<string>(STAGE_BACKGROUND_TYPES);

let writeQueue: Promise<void> = Promise.resolve();

function classifyFailure(error: unknown): StudioPersistenceResult {
  if (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED")
  ) {
    return { ok: false, reason: "quota" };
  }
  return { ok: false, reason: "unavailable" };
}

function queueWrite(
  operation: () => Promise<StudioPersistenceResult>,
): Promise<StudioPersistenceResult> {
  const result = writeQueue.then(operation, operation);
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction was aborted"));
  });
}

function openDatabase(): Promise<IDBDatabase | null> {
  let factory: IDBFactory;
  try {
    if (typeof window === "undefined" || !window.indexedDB) {
      return Promise.resolve(null);
    }
    factory = window.indexedDB;
  } catch {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => finish(null), 1500);
    const finish = (database: IDBDatabase | null) => {
      if (settled) {
        database?.close();
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(database);
    };

    try {
      const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      };
      request.onsuccess = () => finish(request.result);
      request.onerror = () => finish(null);
      request.onblocked = () => finish(null);
    } catch {
      finish(null);
    }
  });
}

function parseSettings(value: unknown): StudioSettings | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<StudioSettings>;
  if (
    typeof candidate.stageColor !== "string" ||
    !HEX_COLOR.test(candidate.stageColor) ||
    (candidate.backgroundMode !== "solid" && candidate.backgroundMode !== "image") ||
    (candidate.backgroundFit !== "cover" && candidate.backgroundFit !== "contain") ||
    !MOTION_IDS.has(candidate.selectedMotion as PersistedMotionId) ||
    typeof candidate.animationSpeed !== "number" ||
    !PLAYBACK_SPEEDS.has(candidate.animationSpeed ?? Number.NaN) ||
    typeof candidate.legsLocked !== "boolean"
  ) {
    return null;
  }
  return {
    stageColor: candidate.stageColor,
    backgroundMode: candidate.backgroundMode,
    backgroundFit: candidate.backgroundFit,
    selectedMotion: candidate.selectedMotion as PersistedMotionId,
    animationSpeed: candidate.animationSpeed,
    legsLocked: candidate.legsLocked,
  };
}

function readFallbackSettings(): StudioSettings | null {
  try {
    if (typeof window === "undefined") return null;
    const value = window.localStorage.getItem(SETTINGS_FALLBACK_KEY);
    return value ? parseSettings(JSON.parse(value)) : null;
  } catch {
    return null;
  }
}

function writeFallbackSettings(settings: StudioSettings) {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SETTINGS_FALLBACK_KEY, JSON.stringify(settings));
  } catch {
    // Settings still remain active in memory when storage is unavailable.
  }
}

function parseBackground(value: unknown): PersistedStageBackground | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<StoredBackgroundRecord>;
  if (
    !(candidate.blob instanceof Blob) ||
    typeof candidate.name !== "string" ||
    typeof candidate.type !== "string" ||
    !BACKGROUND_TYPES.has(candidate.type) ||
    candidate.blob.type !== candidate.type ||
    candidate.blob.size < 1 ||
    candidate.blob.size > MAX_STAGE_BACKGROUND_BYTES ||
    candidate.size !== candidate.blob.size ||
    typeof candidate.savedAt !== "number"
  ) {
    return null;
  }
  return {
    blob: candidate.blob,
    name: candidate.name.slice(0, 180),
    type: candidate.type as PersistedStageBackground["type"],
    size: candidate.blob.size,
    savedAt: candidate.savedAt,
  };
}

function parseVrm(value: unknown): PersistedVrmFile | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<StoredVrmRecord>;
  if (
    !(candidate.blob instanceof Blob) ||
    typeof candidate.name !== "string" ||
    !candidate.name.toLowerCase().endsWith(".vrm") ||
    candidate.blob.size < 1 ||
    candidate.blob.size > MAX_PERSISTED_VRM_BYTES ||
    candidate.size !== candidate.blob.size ||
    typeof candidate.savedAt !== "number"
  ) {
    return null;
  }
  const file = new File([candidate.blob], candidate.name.slice(0, 180), {
    type: typeof candidate.type === "string" ? candidate.type : "model/gltf-binary",
    lastModified:
      typeof candidate.lastModified === "number" ? candidate.lastModified : candidate.savedAt,
  });
  return {
    file,
    name: file.name,
    size: file.size,
    savedAt: candidate.savedAt,
  };
}

export function isSupportedStageBackground(file: Blob): boolean {
  return (
    file.size > 0 &&
    file.size <= MAX_STAGE_BACKGROUND_BYTES &&
    BACKGROUND_TYPES.has(file.type)
  );
}

export async function loadPersistedStudio(): Promise<PersistedStudioSnapshot> {
  const fallbackSettings = readFallbackSettings();
  const database = await openDatabase();
  if (!database) {
    return { settings: fallbackSettings, background: null, vrm: null };
  }

  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const [settingsRecord, backgroundRecord, vrmRecord] = await Promise.all([
      requestResult(store.get("settings")),
      requestResult(store.get("background")),
      requestResult(store.get("vrm")),
      transactionDone(transaction),
    ]);
    return {
      settings: parseSettings(settingsRecord) ?? fallbackSettings,
      background: parseBackground(backgroundRecord),
      vrm: parseVrm(vrmRecord),
    };
  } catch {
    return { settings: fallbackSettings, background: null, vrm: null };
  } finally {
    database.close();
  }
}

async function putRecord(record: StoredStudioRecord): Promise<StudioPersistenceResult> {
  const database = await openDatabase();
  if (!database) return { ok: false, reason: "unsupported" };
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(STORE_NAME).put(record);
    await done;
    return { ok: true };
  } catch (error) {
    return classifyFailure(error);
  } finally {
    database.close();
  }
}

async function deleteRecord(key: StoredStudioRecord["key"]): Promise<StudioPersistenceResult> {
  const database = await openDatabase();
  if (!database) return { ok: false, reason: "unsupported" };
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(STORE_NAME).delete(key);
    await done;
    return { ok: true };
  } catch (error) {
    return classifyFailure(error);
  } finally {
    database.close();
  }
}

export function saveStudioSettings(
  settings: StudioSettings,
): Promise<StudioPersistenceResult> {
  writeFallbackSettings(settings);
  return queueWrite(() =>
    putRecord({ key: "settings", version: 1, ...settings }),
  );
}

export function savePersistedVrmFile(file: File): Promise<StudioPersistenceResult> {
  if (
    !file.name.toLowerCase().endsWith(".vrm") ||
    file.size < 1 ||
    file.size > MAX_PERSISTED_VRM_BYTES
  ) {
    return Promise.resolve({ ok: false, reason: "unavailable" });
  }
  const record: StoredVrmRecord = {
    key: "vrm",
    version: 1,
    blob: file.slice(0, file.size, file.type || "model/gltf-binary"),
    name: file.name.slice(0, 180),
    type: file.type || "model/gltf-binary",
    size: file.size,
    lastModified: file.lastModified,
    savedAt: Date.now(),
  };
  return queueWrite(() => putRecord(record));
}

export function clearPersistedVrmFile(): Promise<StudioPersistenceResult> {
  return queueWrite(() => deleteRecord("vrm"));
}

export function savePersistedStageBackground(
  file: File,
): Promise<StudioPersistenceResult> {
  if (!isSupportedStageBackground(file)) {
    return Promise.resolve({ ok: false, reason: "unavailable" });
  }
  const record: StoredBackgroundRecord = {
    key: "background",
    version: 1,
    blob: file.slice(0, file.size, file.type),
    name: file.name.slice(0, 180),
    type: file.type as StoredBackgroundRecord["type"],
    size: file.size,
    savedAt: Date.now(),
  };
  return queueWrite(() => putRecord(record));
}

export function clearPersistedStageBackground(): Promise<StudioPersistenceResult> {
  return queueWrite(() => deleteRecord("background"));
}
