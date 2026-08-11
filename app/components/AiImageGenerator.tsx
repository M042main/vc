"use client";

import {
  Download,
  Images,
  LoaderCircle,
  RefreshCw,
  Save,
  Sparkles,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  publishGalleryEntry,
  subscribeGalleryEntriesForProfile,
  type GalleryEntry,
} from "../lib/firebaseGallery";
import type { VisitorProfile } from "../lib/visitorProfile";
import styles from "./AiImageGenerator.module.css";

const MAX_PROMPT_LENGTH = 600;
const MAX_RESULTS = 3;
const MAX_GALLERY_IMAGE_DATA_URL_LENGTH = Math.floor(5.5 * 1024 * 1024);
const MAX_GALLERY_IMAGE_EDGE = 2_048;
const ACCEPTED_GENERATED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

// Variations are intentionally internal: one user request produces a useful
// comparison without adding a style-selection surface to the interface.
const GENERATION_VARIANTS = [
  {
    id: "illustration",
    label: "일러스트",
    instruction:
      "섬세한 디지털 일러스트 캐릭터로 표현하고, 인물의 얼굴 특징과 개성을 분명하게 유지하세요.",
  },
  {
    id: "three-dimensional",
    label: "3D",
    instruction:
      "완성도 높은 친근한 3D 캐릭터로 표현하고, 자연스러운 조명과 입체감을 더하세요.",
  },
  {
    id: "sticker",
    label: "스티커",
    instruction:
      "표정이 잘 보이는 선명한 캐릭터 스티커 스타일로 표현하고, 깔끔한 실루엣을 만드세요.",
  },
] as const;

interface AiGenerateResponse {
  imageDataUrl: string;
  mimeType: string;
}

interface GeneratedResult extends AiGenerateResponse {
  id: string;
  label: string;
  prompt: string;
  sourceEntryId: string;
  sourceName: string;
}

export interface AiImageGeneratorProps {
  profile: VisitorProfile | null;
  className?: string;
  onBusyChange?: (busy: boolean) => void;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function activeProfileKey(profile: VisitorProfile | null) {
  return profile && !profile.guest && profile.classId
    ? JSON.stringify([profile.classId, profile.name])
    : null;
}

function isGeneratedImageResponse(value: unknown): value is AiGenerateResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.imageDataUrl === "string" &&
    /^data:image\/(?:png|jpeg|webp);base64,/u.test(candidate.imageDataUrl) &&
    typeof candidate.mimeType === "string" &&
    ACCEPTED_GENERATED_IMAGE_TYPES.has(candidate.mimeType)
  );
}

function generatedImageFromPayload(value: unknown) {
  if (isGeneratedImageResponse(value)) return value;
  if (!value || typeof value !== "object") return null;
  const nestedResult = (value as Record<string, unknown>).result;
  return isGeneratedImageResponse(nestedResult) ? nestedResult : null;
}

async function responseError(response: Response) {
  try {
    const value = (await response.json()) as { error?: unknown; message?: unknown };
    const message =
      typeof value.error === "string"
        ? value.error
        : typeof value.message === "string"
          ? value.message
          : "";
    if (message) return message;
  } catch {
    // Non-JSON gateway responses use the safe message below.
  }
  return response.status === 429
    ? "요청이 많습니다. 잠시 후 다시 시도해 주세요."
    : "AI 이미지를 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

async function generateVariant({
  imageDataUrl,
  prompt,
  variantInstruction,
  signal,
}: {
  imageDataUrl: string;
  prompt: string;
  variantInstruction: string;
  signal: AbortSignal;
}) {
  const response = await fetch("/api/ai/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: `${prompt}\n\n표현 방식: ${variantInstruction}`,
      imageDataUrl,
    }),
    signal,
  });
  if (!response.ok) throw new Error(await responseError(response));
  const value: unknown = await response.json();
  const generatedImage = generatedImageFromPayload(value);
  if (!generatedImage) {
    throw new Error("AI가 올바른 이미지 결과를 보내지 않았습니다.");
  }
  return generatedImage;
}

function imageElement(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("이미지를 처리하지 못했습니다."));
    image.src = dataUrl;
  });
}

function canvasToPngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PNG 파일을 만들지 못했습니다."));
    }, "image/png");
  });
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("PNG 파일을 읽지 못했습니다."));
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("PNG 파일을 읽지 못했습니다."));
    };
    reader.readAsDataURL(blob);
  });
}

function pngDataUrlToBlob(dataUrl: string) {
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) {
    throw new Error("PNG 다운로드 데이터가 올바르지 않습니다.");
  }
  const binary = window.atob(dataUrl.slice(prefix.length));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: "image/png" });
}

function formatSavedAt(timestamp: number) {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

async function prepareGalleryPngDataUrl(imageDataUrl: string) {
  const image = await imageElement(imageDataUrl);
  let scale = Math.min(
    1,
    MAX_GALLERY_IMAGE_EDGE / Math.max(image.naturalWidth, image.naturalHeight),
  );

  for (let attempt = 0; attempt < 7; attempt += 1) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(160, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(160, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("PNG 변환 기능을 사용할 수 없습니다.");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const dataUrl = await blobToDataUrl(await canvasToPngBlob(canvas));
    if (dataUrl.length <= MAX_GALLERY_IMAGE_DATA_URL_LENGTH) return dataUrl;
    scale *= 0.76;
  }

  throw new Error("이미지 용량을 갤러리 저장 크기로 줄이지 못했습니다.");
}

function safeDownloadName(label: string) {
  const safe = label
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|]/gu, "-")
    .replace(/\s+/gu, "-")
    .slice(0, 40);
  return `ai-character-${safe || "result"}.png`;
}

export function AiImageGenerator({
  profile,
  className,
  onBusyChange,
}: AiImageGeneratorProps) {
  const headingId = useId();
  const promptHelpId = useId();
  const apiNoticeId = useId();
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const subscriptionRef = useRef(0);
  const profileKeyRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const savingRef = useRef(new Set<string>());
  const downloadingRef = useRef(new Set<string>());
  const downloadUrlsRef = useRef(new Set<string>());
  const onBusyChangeRef = useRef(onBusyChange);
  const [galleryEntries, setGalleryEntries] = useState<GalleryEntry[]>([]);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [galleryError, setGalleryError] = useState<string | null>(null);
  const [subscriptionVersion, setSubscriptionVersion] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [results, setResults] = useState<GeneratedResult[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [generationMessage, setGenerationMessage] = useState("");
  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [savedIds, setSavedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  const [downloadingIds, setDownloadingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const profileKey = activeProfileKey(profile);
  const eligibleProfile = Boolean(profileKey && profile && !profile.guest);
  const busy = isGenerating || savingIds.size > 0;
  const selectedEntry = useMemo(
    () => galleryEntries.find((entry) => entry.id === selectedEntryId) ?? null,
    [galleryEntries, selectedEntryId],
  );

  useEffect(() => {
    onBusyChangeRef.current = onBusyChange;
  }, [onBusyChange]);

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  useEffect(
    () => {
      mountedRef.current = true;
      const downloadUrls = downloadUrlsRef.current;
      const downloadingInFlight = downloadingRef.current;
      return () => {
        mountedRef.current = false;
        requestRef.current?.abort();
        subscriptionRef.current += 1;
        downloadingInFlight.clear();
        downloadUrls.forEach((url) => URL.revokeObjectURL(url));
        downloadUrls.clear();
        onBusyChangeRef.current?.(false);
      };
    },
    [],
  );

  useEffect(() => {
    profileKeyRef.current = profileKey;
    requestRef.current?.abort();
    generationRef.current += 1;
    savingRef.current.clear();
    setResults([]);
    setSavedIds(new Set());
    setSavingIds(new Set());
    setSaveErrors({});
    setGenerationError(null);
    setGenerationMessage("");
  }, [profileKey]);

  useEffect(() => {
    const subscriptionToken = subscriptionRef.current + 1;
    subscriptionRef.current = subscriptionToken;
    setGalleryEntries([]);
    setSelectedEntryId(null);
    setGalleryError(null);

    if (!eligibleProfile || !profile?.classId) {
      setGalleryLoading(false);
      return;
    }

    setGalleryLoading(true);
    let unsubscribe: () => void;
    try {
      unsubscribe = subscribeGalleryEntriesForProfile(profile, {
        onData: (entries) => {
          if (subscriptionRef.current !== subscriptionToken) return;
          const ownEntries = [...entries].sort(
            (left, right) => right.createdAt - left.createdAt,
          );
          setGalleryEntries(ownEntries);
          setSelectedEntryId((current) =>
            current && ownEntries.some((entry) => entry.id === current)
              ? current
              : (ownEntries[0]?.id ?? null),
          );
          setGalleryLoading(false);
          setGalleryError(null);
        },
        onError: (error) => {
          if (subscriptionRef.current !== subscriptionToken) return;
          if (error instanceof AggregateError) {
            setGenerationMessage(error.message);
            setGalleryLoading(false);
            return;
          }
          setGalleryLoading(false);
          setGalleryError(
            errorMessage(error, "내 갤러리 사진을 불러오지 못했습니다."),
          );
        },
      });
    } catch (error) {
      if (subscriptionRef.current === subscriptionToken) {
        setGalleryLoading(false);
        setGalleryError(
          errorMessage(error, "내 갤러리 사진을 불러오지 못했습니다."),
        );
      }
      return;
    }

    return () => {
      if (subscriptionRef.current === subscriptionToken) {
        subscriptionRef.current += 1;
      }
      unsubscribe();
    };
  }, [eligibleProfile, profile, subscriptionVersion]);

  const generate = useCallback(async () => {
    const normalizedPrompt = prompt.trim();
    if (!profileKey || !eligibleProfile || !selectedEntry) {
      setGenerationError("로그인한 프로필의 갤러리 사진을 먼저 선택해 주세요.");
      return;
    }
    if (!normalizedPrompt) {
      setGenerationError("만들고 싶은 캐릭터의 모습을 설명해 주세요.");
      return;
    }

    requestRef.current?.abort();
    const controller = new AbortController();
    const generationToken = generationRef.current + 1;
    generationRef.current = generationToken;
    requestRef.current = controller;
    onBusyChange?.(true);
    setIsGenerating(true);
    setGenerationError(null);
    setGenerationMessage("세 가지 표현을 생성하고 있습니다.");

    try {
      const settled = await Promise.allSettled(
        GENERATION_VARIANTS.map((variant) =>
          generateVariant({
            imageDataUrl: selectedEntry.imageDataUrl,
            prompt: normalizedPrompt,
            variantInstruction: variant.instruction,
            signal: controller.signal,
          }),
        ),
      );
      if (
        generationRef.current !== generationToken ||
        profileKeyRef.current !== profileKey ||
        controller.signal.aborted
      ) {
        return;
      }

      const successfulResults = settled.flatMap((outcome, index) => {
        if (outcome.status !== "fulfilled") return [];
        const variant = GENERATION_VARIANTS[index];
        return [
          {
            ...outcome.value,
            id: `${generationToken}-${variant.id}`,
            label: variant.label,
            prompt: normalizedPrompt,
            sourceEntryId: selectedEntry.id,
            sourceName: selectedEntry.name,
          } satisfies GeneratedResult,
        ];
      });

      if (successfulResults.length === 0) {
        const firstFailure = settled.find(
          (outcome): outcome is PromiseRejectedResult =>
            outcome.status === "rejected",
        );
        throw new Error(
          errorMessage(
            firstFailure?.reason,
            "세 가지 AI 이미지를 모두 생성하지 못했습니다.",
          ),
        );
      }

      setResults(successfulResults.slice(0, MAX_RESULTS));
      setGenerationMessage(
        successfulResults.length === GENERATION_VARIANTS.length
          ? "서로 다른 세 가지 캐릭터가 완성됐습니다."
          : `${GENERATION_VARIANTS.length}개 중 ${successfulResults.length}개 결과가 완성됐습니다.`,
      );
      window.setTimeout(() => resultHeadingRef.current?.focus(), 0);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (
        generationRef.current === generationToken &&
        profileKeyRef.current === profileKey
      ) {
        setGenerationError(
          errorMessage(error, "AI 이미지를 생성하지 못했습니다."),
        );
        setGenerationMessage("");
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        if (mountedRef.current) setIsGenerating(false);
      }
    }
  }, [eligibleProfile, onBusyChange, profileKey, prompt, selectedEntry]);

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void generate();
    },
    [generate],
  );

  const saveResult = useCallback(
    async (result: GeneratedResult) => {
      if (
        !profile ||
        profile.guest ||
        !profileKey ||
        savingRef.current.size > 0 ||
        savingRef.current.has(result.id) ||
        savedIds.has(result.id)
      ) {
        return;
      }

      const saveProfileKey = profileKey;
      savingRef.current.add(result.id);
      onBusyChange?.(true);
      setSavingIds((current) => new Set(current).add(result.id));
      setSaveErrors((current) => {
        const next = { ...current };
        delete next[result.id];
        return next;
      });

      try {
        const pngDataUrl = await prepareGalleryPngDataUrl(result.imageDataUrl);
        if (
          !mountedRef.current ||
          profileKeyRef.current !== saveProfileKey ||
          !savingRef.current.has(result.id)
        ) {
          return;
        }
        await publishGalleryEntry({ profile, imageDataUrl: pngDataUrl });
        if (!mountedRef.current || profileKeyRef.current !== saveProfileKey) return;
        setSavedIds((current) => new Set(current).add(result.id));
      } catch (error) {
        if (mountedRef.current && profileKeyRef.current === saveProfileKey) {
          setSaveErrors((current) => ({
            ...current,
            [result.id]: errorMessage(
              error,
              "생성 결과를 갤러리에 저장하지 못했습니다.",
            ),
          }));
        }
      } finally {
        savingRef.current.delete(result.id);
        if (mountedRef.current && profileKeyRef.current === saveProfileKey) {
          setSavingIds((current) => {
            const next = new Set(current);
            next.delete(result.id);
            return next;
          });
        }
      }
    },
    [onBusyChange, profile, profileKey, savedIds],
  );

  const downloadResult = useCallback(async (result: GeneratedResult) => {
    if (downloadingRef.current.has(result.id)) return;
    downloadingRef.current.add(result.id);
    setDownloadingIds((current) => new Set(current).add(result.id));
    setSaveErrors((current) => {
      const next = { ...current };
      delete next[result.id];
      return next;
    });
    try {
      const objectUrl = URL.createObjectURL(
        pngDataUrlToBlob(
          await prepareGalleryPngDataUrl(result.imageDataUrl),
        ),
      );
      downloadUrlsRef.current.add(objectUrl);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = safeDownloadName(result.label);
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
        downloadUrlsRef.current.delete(objectUrl);
      }, 1_000);
    } catch (error) {
      setSaveErrors((current) => ({
        ...current,
        [result.id]: errorMessage(error, "PNG 파일을 다운로드하지 못했습니다."),
      }));
    } finally {
      downloadingRef.current.delete(result.id);
      if (mountedRef.current) {
        setDownloadingIds((current) => {
          const next = new Set(current);
          next.delete(result.id);
          return next;
        });
      }
    }
  }, []);

  return (
    <section
      className={[styles.generator, className].filter(Boolean).join(" ")}
      aria-labelledby={headingId}
    >
      <header className={styles.header}>
        <span className={styles.eyebrow}>GEMINI 2.5 FLASH IMAGE</span>
        <h2 id={headingId}>내 갤러리 사진으로 AI 캐릭터 만들기</h2>
        <p>한 번 생성하면 서로 다른 세 가지 표현을 함께 비교할 수 있습니다.</p>
      </header>

      {!eligibleProfile ? (
        <div className={styles.guestState} role="status">
          <Sparkles size={28} aria-hidden="true" />
          <strong>학급 프로필로 시작해 주세요</strong>
          <span>
            게스트는 AI 생성과 온라인 저장을 사용할 수 없습니다. 이름과 학급으로
            로그인하면 내 갤러리 사진을 선택할 수 있습니다.
          </span>
        </div>
      ) : (
        <div className={styles.layout}>
          <form className={styles.controls} onSubmit={submit}>
            <fieldset disabled={isGenerating || savingIds.size > 0}>
              <legend>내 갤러리 사진</legend>
              {galleryLoading ? (
                <div className={styles.sourceState} role="status">
                  <LoaderCircle className={styles.spinner} size={20} aria-hidden="true" />
                  사진을 불러오는 중입니다.
                </div>
              ) : galleryError ? (
                <div className={styles.sourceError} role="alert">
                  <span>{galleryError}</span>
                  <button
                    type="button"
                    onClick={() => setSubscriptionVersion((version) => version + 1)}
                  >
                    <RefreshCw size={15} aria-hidden="true" />
                    다시 연결
                  </button>
                </div>
              ) : galleryEntries.length === 0 ? (
                <div className={styles.sourceState}>
                  <Images size={22} aria-hidden="true" />
                  <strong>저장된 사진이 없습니다</strong>
                  <span>트래킹 스튜디오에서 전신 PNG를 저장해 주세요.</span>
                </div>
              ) : (
                <div className={styles.sourceGrid}>
                  {galleryEntries.map((entry, index) => (
                    <button
                      key={entry.id}
                      type="button"
                      className={styles.sourceButton}
                      data-selected={entry.id === selectedEntryId}
                      aria-pressed={entry.id === selectedEntryId}
                      aria-label={`${index + 1}번째 사진, ${entry.name}님, ${formatSavedAt(entry.createdAt)} 저장, 갤러리 사진 선택`}
                      onClick={() => {
                        setSelectedEntryId(entry.id);
                        setResults([]);
                        setSavedIds(new Set());
                        setSaveErrors({});
                        setGenerationMessage("");
                        setGenerationError(null);
                      }}
                    >
                      {/* Firebase Data URLs cannot use an image optimization loader. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={entry.imageDataUrl} alt="" />
                      <span>{new Date(entry.createdAt).toLocaleDateString("ko-KR")}</span>
                    </button>
                  ))}
                </div>
              )}
            </fieldset>

            <fieldset disabled={isGenerating || savingIds.size > 0}>
              <label className={styles.promptLabel} htmlFor={`${headingId}-prompt`}>
                만들고 싶은 캐릭터를 설명하세요
              </label>
              <textarea
                id={`${headingId}-prompt`}
                value={prompt}
                onChange={(event) => {
                  setPrompt(event.target.value);
                  if (generationError) setGenerationError(null);
                }}
                maxLength={MAX_PROMPT_LENGTH}
                rows={6}
                placeholder="예: 우주 탐험가 옷을 입고 자신 있게 웃는 전신 캐릭터"
                aria-describedby={promptHelpId}
                aria-invalid={Boolean(generationError && !prompt.trim())}
              />
              <div id={promptHelpId} className={styles.promptHelp}>
                <span>얼굴 특징, 옷, 포즈, 분위기를 구체적으로 적어 보세요.</span>
                <span aria-label={`${prompt.length}자 입력, 최대 ${MAX_PROMPT_LENGTH}자`}>
                  {prompt.length}/{MAX_PROMPT_LENGTH}
                </span>
              </div>
            </fieldset>

            <span id={apiNoticeId} className={styles.srOnly}>
              생성하면 선택한 갤러리 사진이 Google Gemini API로 전송됩니다.
            </span>
            <button
              type="submit"
              className={styles.generateButton}
              disabled={!selectedEntry || !prompt.trim() || isGenerating || savingIds.size > 0}
              aria-describedby={apiNoticeId}
            >
              {isGenerating ? (
                <LoaderCircle className={styles.spinner} size={19} aria-hidden="true" />
              ) : (
                <Sparkles size={19} aria-hidden="true" />
              )}
              {isGenerating ? "세 가지 캐릭터 만드는 중" : "AI 캐릭터 3개 만들기"}
            </button>
            {generationError ? (
              <div className={styles.generationError} role="alert">
                <strong>생성하지 못했습니다</strong>
                <span>{generationError}</span>
              </div>
            ) : null}
          </form>

          <section className={styles.resultsPanel} aria-busy={isGenerating}>
            <div className={styles.resultsHeader}>
              <div>
                <span>RESULTS</span>
                <h3 ref={resultHeadingRef} tabIndex={-1}>
                  생성 결과
                </h3>
              </div>
              <strong>{results.length}</strong>
            </div>
            <p className={styles.liveMessage} role="status" aria-live="polite">
              {generationMessage}
            </p>

            {results.length === 0 ? (
              <div className={styles.emptyResults}>
                {isGenerating ? (
                  <LoaderCircle className={styles.spinner} size={30} aria-hidden="true" />
                ) : (
                  <Sparkles size={30} aria-hidden="true" />
                )}
                <strong>{isGenerating ? "캐릭터를 만들고 있어요" : "아직 생성 결과가 없습니다"}</strong>
                <span>
                  {isGenerating
                    ? "완성된 결과부터 이곳에 표시됩니다."
                    : "사진과 설명을 선택해 서로 다른 세 가지 결과를 만들어 보세요."}
                </span>
              </div>
            ) : (
              <div className={styles.resultsGrid}>
                {results.map((result) => {
                  const saving = savingIds.has(result.id);
                  const saved = savedIds.has(result.id);
                  const downloading = downloadingIds.has(result.id);
                  const resultTitleId = `${headingId}-result-${result.id}`;
                  return (
                    <article
                      key={result.id}
                      className={styles.resultCard}
                      aria-labelledby={resultTitleId}
                    >
                      <div className={styles.resultImage}>
                        {/* Generated Data URLs cannot use an image optimization loader. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={result.imageDataUrl}
                          alt={`${result.label} 방식으로 생성한 AI 캐릭터`}
                        />
                        <h4 id={resultTitleId}>{result.label}</h4>
                      </div>
                      <div className={styles.resultActions}>
                        <button
                          type="button"
                          className={styles.saveButton}
                          onClick={() => void saveResult(result)}
                          disabled={saving || saved || busy}
                          aria-label={`${result.label} 결과 ${saving ? "갤러리에 저장 중" : saved ? "갤러리에 저장됨" : "갤러리에 저장"}`}
                        >
                          {saving ? (
                            <LoaderCircle className={styles.spinner} size={16} aria-hidden="true" />
                          ) : (
                            <Save size={16} aria-hidden="true" />
                          )}
                          {saving ? "저장 중" : saved ? "갤러리에 저장됨" : "갤러리에 저장"}
                        </button>
                        <button
                          type="button"
                          className={styles.downloadButton}
                          onClick={() => void downloadResult(result)}
                          disabled={downloading}
                          aria-label={`${result.label} 결과 PNG 다운로드`}
                          title={`${result.label} 결과 PNG 다운로드`}
                        >
                          {downloading ? (
                            <LoaderCircle className={styles.spinner} size={16} aria-hidden="true" />
                          ) : (
                            <Download size={16} aria-hidden="true" />
                          )}
                        </button>
                      </div>
                      {saveErrors[result.id] ? (
                        <p className={styles.cardError} role="alert">
                          {saveErrors[result.id]}
                        </p>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}
    </section>
  );
}

export default AiImageGenerator;
