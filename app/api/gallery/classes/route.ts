import { isAdminRequest } from "../../../lib/adminSession";

const FIREBASE_DATABASE_ORIGIN =
  "https://project-001-e7851-default-rtdb.asia-southeast1.firebasedatabase.app";
// 이 부분은 우리 반 공용 데이터베이스에서 내 방을 만드는 주소입니다
const GALLERY_CLASSES_PATH =
  "/000000/박근석_t7/motion_ink_gallery_a7f3c9/classes";
const FIREBASE_PUSH_KEY_PATTERN = /^[-_A-Za-z0-9]{20}$/u;
const MAX_CLASS_NAME_LENGTH = 40;

type ApiErrorCode =
  | "firebase_conflict"
  | "firebase_invalid_response"
  | "firebase_network_error"
  | "firebase_not_found"
  | "firebase_permission_denied"
  | "firebase_rate_limited"
  | "firebase_request_failed"
  | "firebase_unavailable";

export const dynamic = "force-dynamic";

function errorResponse(
  error: string,
  status: number,
  options?: {
    code?: ApiErrorCode;
    retryable?: boolean;
    upstreamStatus?: number;
  },
) {
  return Response.json(
    {
      error,
      ...(options?.code ? { code: options.code } : {}),
      ...(options?.retryable !== undefined
        ? { retryable: options.retryable }
        : {}),
      ...(options?.upstreamStatus !== undefined
        ? { upstreamStatus: options.upstreamStatus }
        : {}),
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
function validatedClassId(value: unknown): string | null {
  return typeof value === "string" && FIREBASE_PUSH_KEY_PATTERN.test(value)
    ? value
    : null;
}

function validatedClassName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!name || Array.from(name).length > MAX_CLASS_NAME_LENGTH) return null;
  return Array.from(name).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  })
    ? null
    : name;
}

async function requestPayload(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const payload = (await request.json()) as unknown;
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function firebaseFailureResponse(
  response: Response,
  action: "create" | "update" | "delete",
) {
  const upstreamStatus = response.status;
  const actionLabel =
    action === "create"
      ? "학급을 만들"
      : action === "update"
        ? "학급 설정을 변경하"
        : "학급을 삭제하";

  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return errorResponse(
      "Firebase Realtime Database 쓰기 권한이 거부되었습니다. 데이터베이스 규칙을 확인해 주세요.",
      502,
      {
        code: "firebase_permission_denied",
        retryable: false,
        upstreamStatus,
      },
    );
  }
  if (upstreamStatus === 404) {
    return errorResponse(
      "Firebase 데이터베이스 주소 또는 전용 학급 경로를 찾지 못했습니다.",
      502,
      {
        code: "firebase_not_found",
        retryable: false,
        upstreamStatus,
      },
    );
  }
  if (upstreamStatus === 408 || upstreamStatus === 429) {
    return errorResponse(
      "Firebase 요청이 지연되거나 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      502,
      {
        code: "firebase_rate_limited",
        retryable: true,
        upstreamStatus,
      },
    );
  }
  if (upstreamStatus >= 500) {
    return errorResponse(
      "Firebase 학급 서비스가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해 주세요.",
      502,
      {
        code: "firebase_unavailable",
        retryable: true,
        upstreamStatus,
      },
    );
  }
  return errorResponse(`Firebase에서 ${actionLabel}지 못했습니다.`, 502, {
    code: "firebase_request_failed",
    retryable: false,
    upstreamStatus,
  });
}

export async function POST(request: Request) {
  if (!(await isAdminRequest(request))) {
    return errorResponse("학급 관리 권한이 없습니다.", 403);
  }
  const payload = await requestPayload(request);
  const name = validatedClassName(payload?.name);
  if (!name) return errorResponse("학급 이름이 올바르지 않습니다.", 400);

  const createdAt = Date.now();
  let firebaseResponse: Response;
  try {
    firebaseResponse = await fetch(
      new URL(`${GALLERY_CLASSES_PATH}.json`, FIREBASE_DATABASE_ORIGIN),
      {
        method: "POST",
        // Cloudflare subrequests may receive a regional Firebase redirect.
        // Following it is safe here because no Firebase credential is forwarded.
        redirect: "follow",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ name, createdAt, aiEnabled: true }),
      },
    );
  } catch {
    return errorResponse(
      "Firebase 학급 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      502,
      { code: "firebase_network_error", retryable: true },
    );
  }
  if (!firebaseResponse.ok) return firebaseFailureResponse(firebaseResponse, "create");

  let result: unknown;
  try {
    result = await firebaseResponse.json();
  } catch {
    return errorResponse("Firebase 학급 생성 응답을 읽지 못했습니다.", 502, {
      code: "firebase_invalid_response",
      retryable: true,
      upstreamStatus: firebaseResponse.status,
    });
  }
  const id =
    result && typeof result === "object" && !Array.isArray(result)
      ? validatedClassId((result as Record<string, unknown>).name)
      : null;
  if (!id) {
    return errorResponse("Firebase 학급 생성 응답이 올바르지 않습니다.", 502, {
      code: "firebase_invalid_response",
      retryable: false,
      upstreamStatus: firebaseResponse.status,
    });
  }
  return Response.json(
    { classRecord: { id, name, createdAt, aiEnabled: true } },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}

export async function PATCH(request: Request) {
  if (!(await isAdminRequest(request))) {
    return errorResponse("학급 관리 권한이 없습니다.", 403);
  }
  const payload = await requestPayload(request);
  const id = validatedClassId(payload?.id);
  if (!id) return errorResponse("변경할 학급 ID가 올바르지 않습니다.", 400);
  if (typeof payload?.aiEnabled !== "boolean") {
    return errorResponse("AI 이미지 생성 설정이 올바르지 않습니다.", 400);
  }

  const aiEnabled = payload.aiEnabled;
  const firebaseClassUrl = new URL(
    `${GALLERY_CLASSES_PATH}/${id}.json`,
    FIREBASE_DATABASE_ORIGIN,
  );
  let existingResponse: Response;
  try {
    existingResponse = await fetch(firebaseClassUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        Accept: "application/json",
        "X-Firebase-ETag": "true",
      },
    });
  } catch {
    return errorResponse(
      "Firebase 학급 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      502,
      { code: "firebase_network_error", retryable: true },
    );
  }
  if (!existingResponse.ok) {
    return firebaseFailureResponse(existingResponse, "update");
  }
  let existingClass: unknown;
  try {
    existingClass = await existingResponse.json();
  } catch {
    return errorResponse("Firebase 학급 정보를 읽지 못했습니다.", 502, {
      code: "firebase_invalid_response",
      retryable: true,
      upstreamStatus: existingResponse.status,
    });
  }
  const validExistingClass =
    existingClass &&
    typeof existingClass === "object" &&
    !Array.isArray(existingClass) &&
    validatedClassName((existingClass as Record<string, unknown>).name) &&
    typeof (existingClass as Record<string, unknown>).createdAt === "number" &&
    Number.isFinite((existingClass as Record<string, unknown>).createdAt);
  if (!validExistingClass) {
    return errorResponse("변경할 학급을 찾지 못했습니다.", 404, {
      code: "firebase_not_found",
      retryable: false,
    });
  }
  const existingEtag = existingResponse.headers.get("ETag");
  if (!existingEtag) {
    return errorResponse("Firebase 학급 버전 정보를 읽지 못했습니다.", 502, {
      code: "firebase_invalid_response",
      retryable: true,
      upstreamStatus: existingResponse.status,
    });
  }
  let firebaseResponse: Response;
  try {
    firebaseResponse = await fetch(firebaseClassUrl, {
      method: "PATCH",
      redirect: "follow",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        "If-Match": existingEtag,
      },
      body: JSON.stringify({ aiEnabled }),
    });
  } catch {
    return errorResponse(
      "Firebase 학급 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      502,
      { code: "firebase_network_error", retryable: true },
    );
  }
  if (firebaseResponse.status === 412) {
    return errorResponse(
      "학급 정보가 동시에 변경되었습니다. 목록을 확인한 뒤 다시 시도해 주세요.",
      409,
      {
        code: "firebase_conflict",
        retryable: true,
        upstreamStatus: firebaseResponse.status,
      },
    );
  }
  if (!firebaseResponse.ok) {
    return firebaseFailureResponse(firebaseResponse, "update");
  }
  return Response.json(
    { updated: true, id, aiEnabled },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE(request: Request) {
  if (!(await isAdminRequest(request))) {
    return errorResponse("학급 관리 권한이 없습니다.", 403);
  }
  const payload = await requestPayload(request);
  const id = validatedClassId(payload?.id);
  if (!id) return errorResponse("삭제할 학급 ID가 올바르지 않습니다.", 400);

  const firebaseClassUrl = new URL(
    `${GALLERY_CLASSES_PATH}/${id}.json`,
    FIREBASE_DATABASE_ORIGIN,
  );
  let firebaseResponse: Response;
  try {
    firebaseResponse = await fetch(firebaseClassUrl, {
      method: "DELETE",
      redirect: "follow",
      headers: { Accept: "application/json" },
    });
  } catch {
    return errorResponse(
      "Firebase 학급 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      502,
      { code: "firebase_network_error", retryable: true },
    );
  }
  if (!firebaseResponse.ok) return firebaseFailureResponse(firebaseResponse, "delete");
  return Response.json(
    { deleted: true, id },
    { headers: { "Cache-Control": "no-store" } },
  );
}
