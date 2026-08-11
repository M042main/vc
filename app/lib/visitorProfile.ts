const PROFILE_COOKIE = "virtual_creator_profile";
const PROFILE_STORAGE_KEY = "virtual-creator.visitor-profile.v1";
const LEGACY_NAME_COOKIE = "motion_ink_gallery_name";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const MAX_PROFILE_NAME_LENGTH = 24;
const MAX_CLASS_NAME_LENGTH = 40;
const FIREBASE_PUSH_KEY_PATTERN = /^[-_A-Za-z0-9]{20}$/u;

export type VisitorProfile = {
  name: string;
  classId: string | null;
  className: string;
  guest: boolean;
};

export function normalizeVisitorName(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = Array.from(
    value.normalize("NFKC").trim().replace(/\s+/gu, " "),
  )
    .slice(0, MAX_PROFILE_NAME_LENGTH)
    .join("");
  if (
    Array.from(normalized).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    return "";
  }
  return normalized;
}

export function createVisitorProfile(input: {
  name: unknown;
  classId?: unknown;
  className?: unknown;
  guest?: boolean;
}): VisitorProfile {
  const name = normalizeVisitorName(input.name);
  if (!name) throw new Error("이름을 입력해 주세요.");

  if (input.guest) {
    return { name, classId: null, className: "게스트", guest: true };
  }

  const className =
    typeof input.className === "string"
      ? input.className.normalize("NFKC").trim().replace(/\s+/gu, " ")
      : "";
  if (
    typeof input.classId !== "string" ||
    !FIREBASE_PUSH_KEY_PATTERN.test(input.classId) ||
    !className ||
    Array.from(className).length > MAX_CLASS_NAME_LENGTH ||
    Array.from(className).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error("학급을 선택해 주세요.");
  }

  return {
    name,
    classId: input.classId,
    className,
    guest: false,
  };
}

function parseProfile(value: unknown): VisitorProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  try {
    return createVisitorProfile({
      name: candidate.name,
      classId: candidate.classId,
      className: candidate.className,
      guest: candidate.guest === true,
    });
  } catch {
    return null;
  }
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  for (const pair of document.cookie.split(";")) {
    const separator = pair.indexOf("=");
    const key = (separator >= 0 ? pair.slice(0, separator) : pair).trim();
    if (key !== name) continue;
    const rawValue = separator >= 0 ? pair.slice(separator + 1) : "";
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return null;
    }
  }
  return null;
}

export function loadVisitorProfile(): VisitorProfile | null {
  if (typeof window === "undefined") return null;

  try {
    const stored = window.localStorage.getItem(PROFILE_STORAGE_KEY);
    if (stored) {
      const profile = parseProfile(JSON.parse(stored));
      if (profile) return profile;
    }
  } catch {
    // Fall back to the cookie when local storage is unavailable or malformed.
  }

  const cookie = readCookie(PROFILE_COOKIE);
  if (cookie) {
    try {
      const profile = parseProfile(JSON.parse(cookie));
      if (profile) return profile;
    } catch {
      // Continue to the legacy name migration below.
    }
  }

  const legacyName = normalizeVisitorName(readCookie(LEGACY_NAME_COOKIE));
  return legacyName
    ? { name: legacyName, classId: null, className: "게스트", guest: true }
    : null;
}

export function storeVisitorProfile(profile: VisitorProfile): VisitorProfile {
  const validated = createVisitorProfile(profile);
  const serialized = JSON.stringify(validated);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(PROFILE_STORAGE_KEY, serialized);
    } catch {
      // The cookie still preserves the device profile when local storage fails.
    }
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${PROFILE_COOKIE}=${encodeURIComponent(serialized)}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`;
  }
  return validated;
}

export function clearVisitorProfile() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PROFILE_STORAGE_KEY);
  } catch {
    // The expiring cookie below is sufficient when local storage is unavailable.
  }
  document.cookie = `${PROFILE_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
}

export function visitorArtworkKey(profile: VisitorProfile): string {
  const validated = createVisitorProfile(profile);
  if (validated.guest || !validated.classId) {
    throw new Error("게스트는 클라우드 작품 저장을 사용할 수 없습니다.");
  }
  const encodedName = Array.from(new TextEncoder().encode(validated.name), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${validated.classId}_${encodedName}`;
}
