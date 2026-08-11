const AUTHENTICATED_USER_EMAIL_HEADER = "oai-authenticated-user-email";
const ADMIN_EMAIL = "m042@m042.kr";
const FIREBASE_DATABASE_ORIGIN =
  "https://project-001-e7851-default-rtdb.asia-southeast1.firebasedatabase.app";
// 이 부분은 우리 반 공용 데이터베이스에서 내 방을 만드는 주소입니다
const GALLERY_ENTRIES_PATH =
  "/000000/박근석_t7/motion_ink_gallery_a7f3c9/entries";
const FIREBASE_PUSH_KEY_PATTERN = /^[-_A-Za-z0-9]{20}$/u;

export const dynamic = "force-dynamic";

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status });
}

function validatedEntryId(value: unknown): string | null {
  return typeof value === "string" && FIREBASE_PUSH_KEY_PATTERN.test(value)
    ? value
    : null;
}

export async function POST(request: Request) {
  if (request.headers.get(AUTHENTICATED_USER_EMAIL_HEADER) !== ADMIN_EMAIL) {
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

  const id = validatedEntryId((payload as Record<string, unknown>).id);
  if (!id) {
    return errorResponse("삭제할 갤러리 항목 ID가 올바르지 않습니다.", 400);
  }

  const firebaseEntryUrl = new URL(
    `${GALLERY_ENTRIES_PATH}/${id}.json`,
    FIREBASE_DATABASE_ORIGIN,
  );

  try {
    const firebaseResponse = await fetch(firebaseEntryUrl, {
      method: "DELETE",
      cache: "no-store",
      redirect: "error",
      headers: { Accept: "application/json" },
    });

    if (!firebaseResponse.ok) {
      return errorResponse("Firebase에서 캐릭터를 삭제하지 못했습니다.", 502);
    }
  } catch {
    return errorResponse("Firebase 삭제 서비스에 연결하지 못했습니다.", 502);
  }

  return Response.json({ deleted: true, id });
}
