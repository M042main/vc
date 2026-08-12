import { isAdminMutationRequest } from "../../../lib/adminSession";

const FIREBASE_DATABASE_ORIGIN =
  "https://project-001-e7851-default-rtdb.asia-southeast1.firebasedatabase.app";
// 이 부분은 우리 반 공용 데이터베이스에서 내 방을 만드는 주소입니다
const GALLERY_ENTRIES_PATH =
  "/000000/박근석_t7/motion_ink_gallery_a7f3c9/entries";
const FIREBASE_PUSH_KEY_PATTERN = /^[-_A-Za-z0-9]{20}$/u;
const DELETE_ALL_CONFIRMATION = "DELETE_ALL_GALLERY";

type ApiErrorCode =
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

function firebaseFailureResponse(response: Response) {
  const upstreamStatus = response.status;
  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return errorResponse(
      "Firebase Realtime Database 삭제 권한이 거부되었습니다. 데이터베이스 규칙을 확인해 주세요.",
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
      "Firebase 데이터베이스 주소 또는 전용 갤러리 경로를 찾지 못했습니다.",
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
      "Firebase 삭제 서비스가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해 주세요.",
      502,
      {
        code: "firebase_unavailable",
        retryable: true,
        upstreamStatus,
      },
    );
  }
  return errorResponse("Firebase에서 캐릭터를 삭제하지 못했습니다.", 502, {
    code: "firebase_request_failed",
    retryable: false,
    upstreamStatus,
  });
}

function validatedEntryId(value: unknown): string | null {
  return typeof value === "string" && FIREBASE_PUSH_KEY_PATTERN.test(value)
    ? value
    : null;
}

export async function POST(request: Request) {
  if (!(await isAdminMutationRequest(request))) {
    return errorResponse("이 계정에는 갤러리 삭제 권한이 없습니다.", 403);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse("삭제 요청 형식이 올바르지 않습니다.", 400);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return errorResponse("삭제 요청 형식이 올바르지 않습니다.", 400);
  }

  const deleteRequest = payload as Record<string, unknown>;
  if (deleteRequest.all === true) {
    if (deleteRequest.confirmation !== DELETE_ALL_CONFIRMATION) {
      return errorResponse(
        "전체 사진 삭제 확인 문구가 올바르지 않습니다.",
        400,
      );
    }

    const firebaseEntriesUrl = new URL(
      `${GALLERY_ENTRIES_PATH}.json`,
      FIREBASE_DATABASE_ORIGIN,
    );
    let firebaseResponse: Response;
    try {
      firebaseResponse = await fetch(firebaseEntriesUrl, {
        method: "DELETE",
        redirect: "follow",
        headers: { Accept: "application/json" },
      });
    } catch {
      return errorResponse(
        "Firebase 전체 삭제 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.",
        502,
        { code: "firebase_network_error", retryable: true },
      );
    }
    if (!firebaseResponse.ok) return firebaseFailureResponse(firebaseResponse);
    return Response.json(
      { deleted: true, all: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const id = validatedEntryId(deleteRequest.id);
  if (!id) {
    return errorResponse("삭제할 갤러리 항목 ID가 올바르지 않습니다.", 400);
  }

  const firebaseEntryUrl = new URL(
    `${GALLERY_ENTRIES_PATH}/${id}.json`,
    FIREBASE_DATABASE_ORIGIN,
  );

  let firebaseResponse: Response;
  try {
    firebaseResponse = await fetch(firebaseEntryUrl, {
      method: "DELETE",
      // Firebase can redirect REST traffic to its database region.
      // No credential is sent with this request, so following is safe.
      redirect: "follow",
      headers: { Accept: "application/json" },
    });
  } catch {
    return errorResponse(
      "Firebase 삭제 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      502,
      { code: "firebase_network_error", retryable: true },
    );
  }
  if (!firebaseResponse.ok) return firebaseFailureResponse(firebaseResponse);

  return Response.json(
    { deleted: true, id },
    { headers: { "Cache-Control": "no-store" } },
  );
}
