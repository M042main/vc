import type {
  PaperDollExpression,
  PaperDollMotionPresetId,
} from "./paperDollMotion";

export const PAPER_DOLL_CHARACTER_SCHEMA_VERSION = 1 as const;

export type PaperDollArtwork = string | Blob;

export interface SavedPaperDollPlaybackSettings {
  presetId: PaperDollMotionPresetId;
  playbackRate: number;
  loop?: boolean;
}

/**
 * Persisted representation of a browser-created character.
 *
 * `rig` is generic so the store can accept today's single-artwork puppet as
 * well as a future Scroobly-style joint rig without a database migration.
 */
export interface SavedPaperDollCharacter<TRig = unknown> {
  schemaVersion: typeof PAPER_DOLL_CHARACTER_SCHEMA_VERSION;
  id: string;
  name: string;
  artwork: PaperDollArtwork;
  thumbnail?: PaperDollArtwork;
  rig?: TRig;
  playback: SavedPaperDollPlaybackSettings;
  expression: PaperDollExpression;
  createdAt: number;
  updatedAt: number;
}

export interface SavePaperDollCharacterInput<TRig = unknown> {
  id?: string;
  name: string;
  artwork: PaperDollArtwork;
  thumbnail?: PaperDollArtwork;
  rig?: TRig;
  playback?: Partial<SavedPaperDollPlaybackSettings>;
  expression?: Partial<PaperDollExpression>;
}

export interface PaperDollArtworkUrl {
  url: string;
  revoke: () => void;
}

export interface PaperDollCharacterStoreOptions {
  databaseName?: string;
}

const DATABASE_NAME = "motion-ink-paper-dolls";
const DATABASE_VERSION = 1;
const CHARACTER_STORE = "characters";

const DEFAULT_EXPRESSION: PaperDollExpression = {
  blinkLeft: 0,
  blinkRight: 0,
  smile: 0,
  mouthOpen: 0,
  browUp: 0,
  lookX: 0,
  lookY: 0,
};

const DEFAULT_PLAYBACK: SavedPaperDollPlaybackSettings = {
  presetId: "idle",
  playbackRate: 1,
};

function assertBrowserStorage() {
  if (typeof indexedDB === "undefined") {
    throw new Error("캐릭터 저장은 IndexedDB를 지원하는 브라우저에서만 사용할 수 있습니다.");
  }
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("캐릭터 저장소 요청에 실패했습니다."));
  });
}

function transactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("캐릭터 저장에 실패했습니다."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("캐릭터 저장이 취소되었습니다."));
  });
}

function createCharacterId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `paper-doll-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function validateArtwork(artwork: PaperDollArtwork) {
  if (typeof artwork === "string") {
    if (!artwork.trim()) throw new Error("저장할 캐릭터 그림이 비어 있습니다.");
    return;
  }
  if (!(artwork instanceof Blob) || artwork.size === 0) {
    throw new Error("저장할 캐릭터 그림이 비어 있습니다.");
  }
}

function clampPlaybackRate(value: number | undefined) {
  const playbackRate = value ?? DEFAULT_PLAYBACK.playbackRate;
  if (!Number.isFinite(playbackRate) || playbackRate < 0.1 || playbackRate > 4) {
    throw new Error("사전 모션 재생 속도는 0.1배에서 4배 사이여야 합니다.");
  }
  return playbackRate;
}

function clampUnit(value: number | undefined, fallback = 0) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function clampSignedUnit(value: number | undefined, fallback = 0) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(-1, Math.min(1, value));
}

function resolveExpression(
  expression?: Partial<PaperDollExpression>,
): PaperDollExpression {
  return {
    blinkLeft: clampUnit(expression?.blinkLeft, DEFAULT_EXPRESSION.blinkLeft),
    blinkRight: clampUnit(expression?.blinkRight, DEFAULT_EXPRESSION.blinkRight),
    smile: clampUnit(expression?.smile, DEFAULT_EXPRESSION.smile),
    mouthOpen: clampUnit(expression?.mouthOpen, DEFAULT_EXPRESSION.mouthOpen),
    browUp: clampUnit(expression?.browUp, DEFAULT_EXPRESSION.browUp),
    lookX: clampSignedUnit(expression?.lookX, DEFAULT_EXPRESSION.lookX),
    lookY: clampSignedUnit(expression?.lookY, DEFAULT_EXPRESSION.lookY),
  };
}

/**
 * Converts stored string/Blob artwork into a source accepted by img elements
 * and PaperDollStage. Call `revoke` after the character is no longer mounted.
 */
export function createPaperDollArtworkUrl(
  artwork: PaperDollArtwork,
): PaperDollArtworkUrl {
  if (typeof artwork === "string") {
    return { url: artwork, revoke: () => undefined };
  }
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error("캐릭터 그림 URL은 브라우저 환경에서만 만들 수 있습니다.");
  }
  const url = URL.createObjectURL(artwork);
  let revoked = false;
  return {
    url,
    revoke: () => {
      if (revoked) return;
      URL.revokeObjectURL(url);
      revoked = true;
    },
  };
}

export class PaperDollCharacterStore<TRig = unknown> {
  private readonly databaseName: string;
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(options: PaperDollCharacterStoreOptions = {}) {
    this.databaseName = options.databaseName?.trim() || DATABASE_NAME;
  }

  async save(
    input: SavePaperDollCharacterInput<TRig>,
  ): Promise<SavedPaperDollCharacter<TRig>> {
    const name = input.name.trim();
    if (!name) throw new Error("캐릭터 이름을 입력해 주세요.");
    validateArtwork(input.artwork);

    const id = input.id?.trim() || createCharacterId();
    const existing = input.id ? await this.get(input.id) : null;
    const now = Date.now();
    const record: SavedPaperDollCharacter<TRig> = {
      schemaVersion: PAPER_DOLL_CHARACTER_SCHEMA_VERSION,
      id,
      name,
      artwork: input.artwork,
      thumbnail: input.thumbnail,
      rig: input.rig,
      playback: {
        presetId:
          input.playback?.presetId ??
          existing?.playback.presetId ??
          DEFAULT_PLAYBACK.presetId,
        playbackRate: clampPlaybackRate(
          input.playback?.playbackRate ?? existing?.playback.playbackRate,
        ),
        loop: input.playback?.loop ?? existing?.playback.loop,
      },
      expression: resolveExpression(input.expression ?? existing?.expression),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    const database = await this.open();
    const transaction = database.transaction(CHARACTER_STORE, "readwrite");
    transaction.objectStore(CHARACTER_STORE).put(record);
    await transactionComplete(transaction);
    return record;
  }

  async get(id: string): Promise<SavedPaperDollCharacter<TRig> | null> {
    const normalizedId = id.trim();
    if (!normalizedId) return null;
    const database = await this.open();
    const transaction = database.transaction(CHARACTER_STORE, "readonly");
    const result = await requestResult(
      transaction
        .objectStore(CHARACTER_STORE)
        .get(normalizedId) as IDBRequest<SavedPaperDollCharacter<TRig> | undefined>,
    );
    await transactionComplete(transaction);
    return result ?? null;
  }

  async list(): Promise<readonly SavedPaperDollCharacter<TRig>[]> {
    const database = await this.open();
    const transaction = database.transaction(CHARACTER_STORE, "readonly");
    const records = await requestResult(
      transaction
        .objectStore(CHARACTER_STORE)
        .getAll() as IDBRequest<SavedPaperDollCharacter<TRig>[]>,
    );
    await transactionComplete(transaction);
    return records.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async remove(id: string) {
    const normalizedId = id.trim();
    if (!normalizedId) return;
    const database = await this.open();
    const transaction = database.transaction(CHARACTER_STORE, "readwrite");
    transaction.objectStore(CHARACTER_STORE).delete(normalizedId);
    await transactionComplete(transaction);
  }

  async clear() {
    const database = await this.open();
    const transaction = database.transaction(CHARACTER_STORE, "readwrite");
    transaction.objectStore(CHARACTER_STORE).clear();
    await transactionComplete(transaction);
  }

  async close() {
    if (!this.databasePromise) return;
    const database = await this.databasePromise;
    database.close();
    this.databasePromise = null;
  }

  private open() {
    assertBrowserStorage();
    if (!this.databasePromise) {
      this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(this.databaseName, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(CHARACTER_STORE)) {
            const store = database.createObjectStore(CHARACTER_STORE, {
              keyPath: "id",
            });
            store.createIndex("updatedAt", "updatedAt");
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
          this.databasePromise = null;
          reject(
            request.error ?? new Error("브라우저 캐릭터 저장소를 열지 못했습니다."),
          );
        };
        request.onblocked = () => {
          this.databasePromise = null;
          reject(new Error("다른 탭에서 캐릭터 저장소를 사용 중입니다."));
        };
      });
    }
    return this.databasePromise;
  }
}
