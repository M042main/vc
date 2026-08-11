const GEMINI_MODEL = "gemini-2.5-flash-image";
const GEMINI_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent`;

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const MAX_INPUT_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_UPSTREAM_RESPONSE_BYTES = 14 * 1024 * 1024;
const MAX_PROMPT_CODE_POINTS = 1_200;
const MIN_IMAGE_SIDE = 64;
const MAX_IMAGE_SIDE = 8_192;
const MAX_IMAGE_PIXELS = 25_000_000;
const RATE_LIMIT_WINDOW_MS = 10 * 60_000;
const AUTHENTICATED_RATE_LIMIT = 12;
const IP_RATE_LIMIT = 60;
const MAX_RATE_LIMIT_BUCKETS = 2_000;
const MAX_CONCURRENT_UPSTREAM_REQUESTS = 3;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

type ApiErrorCode =
  | "ai_content_blocked"
  | "ai_invalid_response"
  | "ai_network_error"
  | "ai_not_configured"
  | "ai_rate_limited"
  | "ai_request_failed"
  | "ai_request_cancelled"
  | "ai_timeout"
  | "ai_unavailable"
  | "invalid_image"
  | "invalid_json"
  | "invalid_prompt"
  | "request_too_large"
  | "request_origin_denied"
  | "unsupported_media_type";

type ImageDimensions = { width: number; height: number };
type ValidatedImage = {
  data: string;
  mimeType: string;
  dimensions: ImageDimensions;
};
type RateLimitBucket = { count: number; resetAt: number };

const rateLimitBuckets = new Map<string, RateLimitBucket>();
const concurrentUpstreamRequests = new Map<string, number>();

export const dynamic = "force-dynamic";
export const runtime = "edge";

function errorResponse(
  error: string,
  status: number,
  options: {
    code: ApiErrorCode;
    headers?: Record<string, string>;
    retryable?: boolean;
    upstreamStatus?: number;
  },
) {
  return Response.json(
    {
      error,
      code: options.code,
      ...(options.retryable !== undefined
        ? { retryable: options.retryable }
        : {}),
      ...(options.upstreamStatus !== undefined
        ? { upstreamStatus: options.upstreamStatus }
        : {}),
    },
    {
      status,
      headers: { "Cache-Control": "no-store", ...options.headers },
    },
  );
}

function isSameOriginBrowserRequest(request: Request) {
  const site = request.headers.get("sec-fetch-site")?.toLowerCase();
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  if (!site && !origin && !referer) return false;
  if (site && site !== "same-origin" && site !== "none") return false;

  const requestOrigin = new URL(request.url).origin;
  if (origin) {
    try {
      return new URL(origin).origin === requestOrigin;
    } catch {
      return false;
    }
  }
  if (referer) {
    try {
      return new URL(referer).origin === requestOrigin;
    } catch {
      return false;
    }
  }
  // Sec-Fetch-Site is a forbidden browser header, so a real same-origin fetch
  // can still be recognized when Origin and Referer are unavailable.
  return true;
}

function rateLimitIdentity(request: Request) {
  const authenticatedUserId = request.headers
    .get("oai-authenticated-user-id")
    ?.trim();
  if (authenticatedUserId && authenticatedUserId.length <= 200) {
    return {
      key: `user:${authenticatedUserId}`,
      limit: AUTHENTICATED_RATE_LIMIT,
    };
  }

  const connectingIp =
    request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  if (connectingIp && connectingIp.length <= 64) {
    return { key: `ip:${connectingIp}`, limit: IP_RATE_LIMIT };
  }
  return {
    key: `origin:${new URL(request.url).origin}`,
    limit: IP_RATE_LIMIT,
  };
}

function reserveRateLimit(request: Request) {
  const identity = rateLimitIdentity(request);
  const now = Date.now();
  const current = rateLimitBuckets.get(identity.key);

  if (current && current.resetAt > now) {
    if (current.count >= identity.limit) {
      return Math.max(1, Math.ceil((current.resetAt - now) / 1_000));
    }
    current.count += 1;
    return null;
  }
  if (current) rateLimitBuckets.delete(identity.key);

  if (rateLimitBuckets.size >= MAX_RATE_LIMIT_BUCKETS) {
    for (const [key, bucket] of rateLimitBuckets) {
      if (bucket.resetAt <= now) rateLimitBuckets.delete(key);
    }
    while (rateLimitBuckets.size >= MAX_RATE_LIMIT_BUCKETS) {
      const oldestKey = rateLimitBuckets.keys().next().value;
      if (typeof oldestKey !== "string") break;
      rateLimitBuckets.delete(oldestKey);
    }
  }
  rateLimitBuckets.set(identity.key, {
    count: 1,
    resetAt: now + RATE_LIMIT_WINDOW_MS,
  });
  return null;
}

function reserveUpstreamSlot(request: Request): string | null {
  const key = rateLimitIdentity(request).key;
  const current = concurrentUpstreamRequests.get(key) ?? 0;
  if (current >= MAX_CONCURRENT_UPSTREAM_REQUESTS) return null;
  concurrentUpstreamRequests.set(key, current + 1);
  return key;
}

function releaseUpstreamSlot(key: string) {
  const current = concurrentUpstreamRequests.get(key) ?? 0;
  if (current <= 1) concurrentUpstreamRequests.delete(key);
  else concurrentUpstreamRequests.set(key, current - 1);
}

function encodedByteLength(value: string) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function decodeBase64(value: string): Uint8Array | null {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    return null;
  }

  try {
    const decoded = atob(value);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function readUint16BigEndian(bytes: Uint8Array, offset: number) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readUint32BigEndian(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset] * 0x1000000 +
    ((bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3])
  );
}

function isPng(bytes: Uint8Array) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  return (
    bytes.length >= 24 &&
    signature.every((value, index) => bytes[index] === value) &&
    bytes[12] === 73 &&
    bytes[13] === 72 &&
    bytes[14] === 68 &&
    bytes[15] === 82
  );
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (!isPng(bytes)) return null;
  return {
    width: readUint32BigEndian(bytes, 16),
    height: readUint32BigEndian(bytes, 20),
  };
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (
    bytes.length < 11 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[2] !== 0xff
  ) {
    return null;
  }

  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset];
    offset += 1;

    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;

    const segmentLength = readUint16BigEndian(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame) {
      if (segmentLength < 7) return null;
      return {
        width: readUint16BigEndian(bytes, offset + 5),
        height: readUint16BigEndian(bytes, offset + 3),
      };
    }
    offset += segmentLength;
  }
  return null;
}

function matchesAscii(bytes: Uint8Array, offset: number, value: string) {
  if (offset + value.length > bytes.length) return false;
  return Array.from(value).every(
    (character, index) => bytes[offset + index] === character.charCodeAt(0),
  );
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (
    bytes.length < 30 ||
    !matchesAscii(bytes, 0, "RIFF") ||
    !matchesAscii(bytes, 8, "WEBP")
  ) {
    return null;
  }

  if (matchesAscii(bytes, 12, "VP8X")) {
    return {
      width: readUint24LittleEndian(bytes, 24) + 1,
      height: readUint24LittleEndian(bytes, 27) + 1,
    };
  }
  if (
    matchesAscii(bytes, 12, "VP8 ") &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    return {
      width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
    };
  }
  if (matchesAscii(bytes, 12, "VP8L") && bytes[20] === 0x2f) {
    return {
      width: 1 + (bytes[21] | ((bytes[22] & 0x3f) << 8)),
      height:
        1 +
        ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 0x0f) << 10)),
    };
  }
  return null;
}

function imageDimensions(bytes: Uint8Array, mimeType: string) {
  if (mimeType === "image/png") return pngDimensions(bytes);
  if (mimeType === "image/jpeg") return jpegDimensions(bytes);
  if (mimeType === "image/webp") return webpDimensions(bytes);
  return null;
}

function hasSafeImageDimensions(dimensions: ImageDimensions) {
  const { width, height } = dimensions;
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= MIN_IMAGE_SIDE &&
    height >= MIN_IMAGE_SIDE &&
    width <= MAX_IMAGE_SIDE &&
    height <= MAX_IMAGE_SIDE &&
    width * height <= MAX_IMAGE_PIXELS
  );
}

function validateImageDataUrl(value: unknown): ValidatedImage | null {
  if (typeof value !== "string") return null;
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(
    value,
  );
  if (!match) return null;

  const [, mimeType, data] = match;
  if (
    !SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) ||
    data.length % 4 !== 0 ||
    encodedByteLength(data) > MAX_INPUT_IMAGE_BYTES
  ) {
    return null;
  }

  const bytes = decodeBase64(data);
  if (!bytes || bytes.length > MAX_INPUT_IMAGE_BYTES) return null;
  const dimensions = imageDimensions(bytes, mimeType);
  if (!dimensions || !hasSafeImageDimensions(dimensions)) return null;
  return { data, mimeType, dimensions };
}

function validatedPrompt(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const prompt = value.normalize("NFKC").trim();
  if (!prompt || Array.from(prompt).length > MAX_PROMPT_CODE_POINTS) return null;
  return prompt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readRequestPayload(
  request: Request,
): Promise<Record<string, unknown> | "invalid" | "too_large"> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return "too_large";
  }

  let body: string;
  try {
    body = await request.text();
  } catch {
    return "invalid";
  }
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
    return "too_large";
  }
  try {
    const payload = JSON.parse(body) as unknown;
    return isRecord(payload) ? payload : "invalid";
  } catch {
    return "invalid";
  }
}

async function readResponseTextWithLimit(
  response: Response,
  byteLimit: number,
): Promise<string | null> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > byteLimit) return null;
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let result = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > byteLimit) {
        await reader.cancel();
        return null;
      }
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function upstreamFailureResponse(status: number) {
  if (status === 429) {
    return errorResponse(
      "AI 이미지 생성 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
      429,
      { code: "ai_rate_limited", retryable: true, upstreamStatus: status },
    );
  }
  if (status === 408 || status >= 500) {
    return errorResponse(
      "AI 이미지 생성 서비스가 일시적으로 응답하지 않습니다.",
      502,
      { code: "ai_unavailable", retryable: true, upstreamStatus: status },
    );
  }
  return errorResponse(
    "AI 이미지 생성 요청을 처리하지 못했습니다.",
    502,
    { code: "ai_request_failed", retryable: false, upstreamStatus: status },
  );
}

function extractGeneratedImage(payload: unknown) {
  if (!isRecord(payload) || !Array.isArray(payload.candidates)) return null;
  let responseText = "";
  for (const candidate of payload.candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.content)) continue;
    const parts = candidate.content.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!isRecord(part)) continue;
      if (typeof part.text === "string" && responseText.length < 2_000) {
        responseText += `${responseText ? "\n" : ""}${part.text}`;
      }
      if (!isRecord(part.inlineData)) continue;
      const mimeType = part.inlineData.mimeType;
      const data = part.inlineData.data;
      if (
        typeof mimeType !== "string" ||
        !SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) ||
        typeof data !== "string" ||
        data.length % 4 !== 0 ||
        encodedByteLength(data) > MAX_OUTPUT_IMAGE_BYTES
      ) {
        continue;
      }
      const bytes = decodeBase64(data);
      if (!bytes || bytes.length > MAX_OUTPUT_IMAGE_BYTES) continue;
      const dimensions = imageDimensions(bytes, mimeType);
      if (!dimensions || !hasSafeImageDimensions(dimensions)) continue;
      return {
        imageDataUrl: `data:${mimeType};base64,${data}`,
        mimeType,
        width: dimensions.width,
        height: dimensions.height,
        ...(responseText ? { text: responseText.slice(0, 2_000) } : {}),
      };
    }
  }
  return null;
}

function wasContentBlocked(payload: unknown) {
  if (!isRecord(payload)) return false;
  if (
    isRecord(payload.promptFeedback) &&
    typeof payload.promptFeedback.blockReason === "string"
  ) {
    return true;
  }
  if (!Array.isArray(payload.candidates)) return false;
  return payload.candidates.some(
    (candidate) =>
      isRecord(candidate) &&
      typeof candidate.finishReason === "string" &&
      ["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "IMAGE_SAFETY"].includes(
        candidate.finishReason,
      ),
  );
}

export async function POST(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return errorResponse("JSON 형식으로 요청해 주세요.", 415, {
      code: "unsupported_media_type",
      retryable: false,
    });
  }
  if (!isSameOriginBrowserRequest(request)) {
    return errorResponse("이 사이트에서 보낸 요청만 처리할 수 있습니다.", 403, {
      code: "request_origin_denied",
      retryable: false,
    });
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return errorResponse("AI 이미지 생성 기능이 아직 설정되지 않았습니다.", 503, {
      code: "ai_not_configured",
      retryable: false,
    });
  }

  const retryAfter = reserveRateLimit(request);
  if (retryAfter !== null) {
    return errorResponse(
      "AI 이미지 생성 횟수가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      429,
      {
        code: "ai_rate_limited",
        retryable: true,
        headers: { "Retry-After": String(retryAfter) },
      },
    );
  }

  const payload = await readRequestPayload(request);
  if (payload === "too_large") {
    return errorResponse("요청 이미지가 너무 큽니다.", 413, {
      code: "request_too_large",
      retryable: false,
    });
  }
  if (payload === "invalid") {
    return errorResponse("요청 JSON 형식이 올바르지 않습니다.", 400, {
      code: "invalid_json",
      retryable: false,
    });
  }

  const prompt = validatedPrompt(payload.prompt);
  if (!prompt) {
    return errorResponse(
      `프롬프트를 1자 이상 ${MAX_PROMPT_CODE_POINTS.toLocaleString("en-US")}자 이하로 입력해 주세요.`,
      400,
      { code: "invalid_prompt", retryable: false },
    );
  }
  const image = validateImageDataUrl(payload.imageDataUrl);
  if (!image) {
    return errorResponse(
      "64px 이상, 25MP 이하의 PNG·JPEG·WebP 사진(최대 8MB)을 사용해 주세요.",
      400,
      { code: "invalid_image", retryable: false },
    );
  }

  const upstreamSlotKey = reserveUpstreamSlot(request);
  if (!upstreamSlotKey) {
    return errorResponse(
      "이미 세 개의 AI 이미지를 생성하고 있습니다. 완료된 뒤 다시 시도해 주세요.",
      429,
      {
        code: "ai_rate_limited",
        retryable: true,
        headers: { "Retry-After": "1" },
      },
    );
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromRequest = () => controller.abort(request.signal.reason);
  if (request.signal.aborted) abortFromRequest();
  else request.signal.addEventListener("abort", abortFromRequest, { once: true });
  const timeout = setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const abortedResponse = () =>
    timedOut
      ? errorResponse("AI 이미지 생성 시간이 초과되었습니다.", 504, {
          code: "ai_timeout",
          retryable: true,
        })
      : errorResponse("AI 이미지 생성 요청이 취소되었습니다.", 499, {
          code: "ai_request_cancelled",
          retryable: true,
        });

  try {
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(GEMINI_ENDPOINT, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json; charset=utf-8",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: prompt },
                {
                  inlineData: {
                    mimeType: image.mimeType,
                    data: image.data,
                  },
                },
              ],
            },
          ],
          generationConfig: { responseModalities: ["IMAGE"] },
        }),
      });
    } catch (error) {
      if (controller.signal.aborted) return abortedResponse();
      void error;
      return errorResponse("AI 이미지 생성 서비스에 연결하지 못했습니다.", 502, {
        code: "ai_network_error",
        retryable: true,
      });
    }

    if (!upstreamResponse.ok) {
      await readResponseTextWithLimit(upstreamResponse, 64 * 1024);
      if (controller.signal.aborted) return abortedResponse();
      return upstreamFailureResponse(upstreamResponse.status);
    }

    const upstreamText = await readResponseTextWithLimit(
      upstreamResponse,
      MAX_UPSTREAM_RESPONSE_BYTES,
    );
    if (upstreamText === null) {
      if (controller.signal.aborted) return abortedResponse();
      return errorResponse("AI 이미지 응답이 너무 크거나 손상되었습니다.", 502, {
        code: "ai_invalid_response",
        retryable: true,
      });
    }
    let upstreamPayload: unknown;
    try {
      upstreamPayload = JSON.parse(upstreamText);
    } catch {
      return errorResponse("AI 이미지 응답을 읽지 못했습니다.", 502, {
        code: "ai_invalid_response",
        retryable: true,
      });
    }

    const result = extractGeneratedImage(upstreamPayload);
    if (!result) {
      if (wasContentBlocked(upstreamPayload)) {
        return errorResponse(
          "안전 정책으로 이 이미지를 생성할 수 없습니다. 다른 사진이나 설명을 사용해 주세요.",
          422,
          { code: "ai_content_blocked", retryable: false },
        );
      }
      return errorResponse("AI가 사용할 수 있는 이미지를 반환하지 않았습니다.", 502, {
        code: "ai_invalid_response",
        retryable: true,
      });
    }

    return Response.json(
      { result: { ...result, model: GEMINI_MODEL } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abortFromRequest);
    releaseUpstreamSlot(upstreamSlotKey);
  }
}
