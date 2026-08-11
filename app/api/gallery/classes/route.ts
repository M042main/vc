const AUTHENTICATED_USER_EMAIL_HEADER = "oai-authenticated-user-email";
const ADMIN_EMAIL = "m042@m042.kr";
const FIREBASE_DATABASE_ORIGIN =
  "https://project-001-e7851-default-rtdb.asia-southeast1.firebasedatabase.app";
// 이 부분은 우리 반 공용 데이터베이스에서 내 방을 만드는 주소입니다
const GALLERY_CLASSES_PATH =
  "/000000/박근석_t7/motion_ink_gallery_a7f3c9/classes";
const FIREBASE_PUSH_KEY_PATTERN = /^[-_A-Za-z0-9]{20}$/u;
const MAX_CLASS_NAME_LENGTH = 40;

export const dynamic = "force-dynamic";

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status });
}
function isAdmin(request: Request) {
  return request.headers.get(AUTHENTICATED_USER_EMAIL_HEADER) === ADMIN_EMAIL;
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

export async function POST(request: Request) {
  if (!isAdmin(request)) return errorResponse("학급 관리 권한이 없습니다.", 403);
  const payload = await requestPayload(request);
  const name = validatedClassName(payload?.name);
  if (!name) return errorResponse("학급 이름이 올바르지 않습니다.", 400);

  const createdAt = Date.now();
  try {
    const firebaseResponse = await fetch(
      new URL(`${GALLERY_CLASSES_PATH}.json`, FIREBASE_DATABASE_ORIGIN),
      {
        method: "POST",
        cache: "no-store",
        redirect: "error",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ name, createdAt }),
      },
    );
    if (!firebaseResponse.ok) {
      return errorResponse("Firebase에 학급을 만들지 못했습니다.", 502);
    }
    const result = (await firebaseResponse.json()) as unknown;
    const id =
      result && typeof result === "object" && !Array.isArray(result)
        ? validatedClassId((result as Record<string, unknown>).name)
        : null;
    if (!id) return errorResponse("Firebase 학급 생성 응답이 올바르지 않습니다.", 502);
    return Response.json({ classRecord: { id, name, createdAt } }, { status: 201 });
  } catch {
    return errorResponse("Firebase 학급 서비스에 연결하지 못했습니다.", 502);
  }
}

export async function DELETE(request: Request) {
  if (!isAdmin(request)) return errorResponse("학급 관리 권한이 없습니다.", 403);
  const payload = await requestPayload(request);
  const id = validatedClassId(payload?.id);
  if (!id) return errorResponse("삭제할 학급 ID가 올바르지 않습니다.", 400);

  const firebaseClassUrl = new URL(
    `${GALLERY_CLASSES_PATH}/${id}.json`,
    FIREBASE_DATABASE_ORIGIN,
  );
  try {
    const firebaseResponse = await fetch(firebaseClassUrl, {
      method: "DELETE",
      cache: "no-store",
      redirect: "error",
      headers: { Accept: "application/json" },
    });
    if (!firebaseResponse.ok) {
      return errorResponse("Firebase에서 학급을 삭제하지 못했습니다.", 502);
    }
    return Response.json({ deleted: true, id });
  } catch {
    return errorResponse("Firebase 학급 서비스에 연결하지 못했습니다.", 502);
  }
}
