const DATABASE_NAME = "virtual-creator-device-data";
const DATABASE_VERSION = 1;
const STORE_NAME = "ai-generation-history";
const PROFILE_CREATED_AT_INDEX = "profile-created-at";

const MAX_ITEMS_PER_PROFILE = 8;
const MAX_ITEMS_TOTAL = 32;
const MAX_IMAGE_DATA_URL_LENGTH = 14 * 1024 * 1024;
const MAX_TOTAL_IMAGE_DATA_URL_LENGTH = 48 * 1024 * 1024;

export interface AiGenerationHistoryItem {
  id: string;
  profileKey: string;
  createdAt: number;
  imageDataUrl: string;
  mimeType: string;
  prompt: string;
  sourceEntryId: string;
  sourceName: string;
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("기기 저장소 요청에 실패했습니다."));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("기기 저장소 작업이 취소됐습니다."));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("기기 저장소 작업에 실패했습니다."));
  });
}

function openHistoryDatabase() {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("이 브라우저에서는 로컬 생성 기록을 사용할 수 없습니다."));
  }

  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.objectStoreNames.contains(STORE_NAME)
        ? request.transaction!.objectStore(STORE_NAME)
        : database.createObjectStore(STORE_NAME, { keyPath: "id" });
      if (!store.indexNames.contains(PROFILE_CREATED_AT_INDEX)) {
        store.createIndex(PROFILE_CREATED_AT_INDEX, ["profileKey", "createdAt"]);
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () =>
      reject(request.error ?? new Error("로컬 생성 기록을 열지 못했습니다."));
    request.onblocked = () =>
      reject(new Error("다른 탭에서 저장소를 사용 중입니다. 탭을 닫고 다시 시도해 주세요."));
  });
}

function assertHistoryItem(item: AiGenerationHistoryItem) {
  if (
    !item.id ||
    !item.profileKey ||
    !Number.isFinite(item.createdAt) ||
    !/^data:image\/(?:png|jpeg|webp);base64,/u.test(item.imageDataUrl) ||
    item.imageDataUrl.length > MAX_IMAGE_DATA_URL_LENGTH
  ) {
    throw new Error("로컬에 보관할 생성 이미지가 올바르지 않거나 너무 큽니다.");
  }
}

async function allHistoryItems(database: IDBDatabase) {
  const transaction = database.transaction(STORE_NAME, "readonly");
  return requestResult(
    transaction.objectStore(STORE_NAME).getAll() as IDBRequest<AiGenerationHistoryItem[]>,
  );
}

export async function listAiGenerationHistory(profileKey: string) {
  if (!profileKey) return [];
  const database = await openHistoryDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const range = IDBKeyRange.bound(
      [profileKey, 0],
      [profileKey, Number.MAX_SAFE_INTEGER],
    );
    const items = await requestResult(
      transaction
        .objectStore(STORE_NAME)
        .index(PROFILE_CREATED_AT_INDEX)
        .getAll(range) as IDBRequest<AiGenerationHistoryItem[]>,
    );
    return items.sort((left, right) => right.createdAt - left.createdAt);
  } finally {
    database.close();
  }
}

export async function saveAiGenerationHistory(item: AiGenerationHistoryItem) {
  assertHistoryItem(item);
  const database = await openHistoryDatabase();
  try {
    const existing = await allHistoryItems(database);
    const otherItems = existing.filter((candidate) => candidate.id !== item.id);
    const sameProfile = otherItems
      .filter((candidate) => candidate.profileKey === item.profileKey)
      .sort((left, right) => right.createdAt - left.createdAt);
    const deleteIds = new Set(
      sameProfile.slice(MAX_ITEMS_PER_PROFILE - 1).map((candidate) => candidate.id),
    );

    const retained = otherItems
      .filter((candidate) => !deleteIds.has(candidate.id))
      .sort((left, right) => right.createdAt - left.createdAt);
    let retainedImageLength = retained.reduce(
      (total, candidate) =>
        total +
        (typeof candidate.imageDataUrl === "string"
          ? candidate.imageDataUrl.length
          : 0),
      0,
    );
    while (
      retained.length >= MAX_ITEMS_TOTAL ||
      retainedImageLength + item.imageDataUrl.length >
        MAX_TOTAL_IMAGE_DATA_URL_LENGTH
    ) {
      const oldest = retained.pop();
      if (!oldest) break;
      deleteIds.add(oldest.id);
      retainedImageLength -=
        typeof oldest.imageDataUrl === "string"
          ? oldest.imageDataUrl.length
          : 0;
    }

    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    deleteIds.forEach((id) => store.delete(id));
    store.put(item);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function removeAiGenerationHistory(id: string, profileKey: string) {
  if (!id || !profileKey) return;
  const database = await openHistoryDatabase();
  try {
    const readTransaction = database.transaction(STORE_NAME, "readonly");
    const item = await requestResult(
      readTransaction.objectStore(STORE_NAME).get(id) as IDBRequest<
        AiGenerationHistoryItem | undefined
      >,
    );
    if (!item || item.profileKey !== profileKey) return;

    const writeTransaction = database.transaction(STORE_NAME, "readwrite");
    writeTransaction.objectStore(STORE_NAME).delete(id);
    await transactionDone(writeTransaction);
  } finally {
    database.close();
  }
}
