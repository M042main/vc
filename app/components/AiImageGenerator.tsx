"use client";

import {
  Download,
  History,
  Images,
  LoaderCircle,
  Maximize2,
  RefreshCw,
  Save,
  Sparkles,
  X,
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
import {
  listAiGenerationHistory,
  removeAiGenerationHistory,
  saveAiGenerationHistory,
  type AiGenerationHistoryItem,
} from "../lib/aiGenerationHistory";
import type { VisitorProfile } from "../lib/visitorProfile";
import styles from "./AiImageGenerator.module.css";

const MAX_PROMPT_LENGTH = 600;
const MAX_GALLERY_IMAGE_DATA_URL_LENGTH = Math.floor(5.5 * 1024 * 1024);
const MAX_GALLERY_IMAGE_EDGE = 2_048;
const ACCEPTED_GENERATED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

interface AiGenerateResponse {
  imageDataUrl: string;
  mimeType: string;
}

interface GeneratedResult extends AiGenerateResponse {
  id: string;
  createdAt: number;
  prompt: string;
  sourceEntryId: string;
  sourceName: string;
}

export interface AiImageGeneratorProps {
  profile: VisitorProfile | null;
  className?: string;
  onBusyChange?: (busy: boolean) => void;
  aiEnabled?: boolean;
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

async function generateImage({
  imageDataUrl,
  prompt,
  classId,
  signal,
}: {
  imageDataUrl: string;
  prompt: string;
  classId: string;
  signal: AbortSignal;
}) {
  const response = await fetch("/api/ai/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      imageDataUrl,
      classId,
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

function safeDownloadName(prompt: string) {
  const safe = prompt
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
  aiEnabled = true,
}: AiImageGeneratorProps) {
  const headingId = useId();
  const promptHelpId = useId();
  const apiNoticeId = useId();
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const historyDialogRef = useRef<HTMLElement>(null);
  const historyCloseRef = useRef<HTMLButtonElement>(null);
  const previewDialogRef = useRef<HTMLElement>(null);
  const previewCloseRef = useRef<HTMLButtonElement>(null);
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const subscriptionRef = useRef(0);
  const historyLoadRef = useRef(0);
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
  const [previewResult, setPreviewResult] = useState<GeneratedResult | null>(
    null,
  );
  const [historyItems, setHistoryItems] = useState<AiGenerationHistoryItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
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
        historyLoadRef.current += 1;
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
    setHistoryOpen(false);
    setPreviewResult(null);
    previewTriggerRef.current = null;
  }, [profileKey]);

  useEffect(() => {
    if (aiEnabled) return;
    requestRef.current?.abort();
    requestRef.current = null;
    generationRef.current += 1;
    setIsGenerating(false);
    setGenerationMessage("");
  }, [aiEnabled]);

  useEffect(() => {
    const loadToken = historyLoadRef.current + 1;
    historyLoadRef.current = loadToken;
    setHistoryItems([]);
    setHistoryError(null);

    if (!profileKey) {
      setHistoryLoading(false);
      return;
    }

    setHistoryLoading(true);
    void listAiGenerationHistory(profileKey)
      .then((items) => {
        if (historyLoadRef.current !== loadToken) return;
        setHistoryItems(items);
        setHistoryLoading(false);
      })
      .catch((error) => {
        if (historyLoadRef.current !== loadToken) return;
        setHistoryLoading(false);
        setHistoryError(errorMessage(error, "이 기기의 생성 기록을 불러오지 못했습니다."));
      });

    return () => {
      if (historyLoadRef.current === loadToken) historyLoadRef.current += 1;
    };
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
    if (!aiEnabled) {
      setGenerationError("관리자가 이 학급의 AI 이미지 생성을 비활성화했습니다.");
      return;
    }
    if (!profileKey || !eligibleProfile || !profile?.classId || !selectedEntry) {
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
    setGenerationMessage("입력한 상황과 자세로 이미지를 생성하고 있습니다.");

    try {
      const sourceImageDataUrl = await prepareGalleryPngDataUrl(
        selectedEntry.imageDataUrl,
      );
      const generatedImage = await generateImage({
        imageDataUrl: sourceImageDataUrl,
        prompt: normalizedPrompt,
        classId: profile.classId,
        signal: controller.signal,
      });
      if (
        generationRef.current !== generationToken ||
        profileKeyRef.current !== profileKey ||
        controller.signal.aborted
      ) {
        return;
      }

      const createdAt = Date.now();
      const result = {
        ...generatedImage,
        id:
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `ai-${createdAt}-${generationToken}`,
        createdAt,
        prompt: normalizedPrompt,
        sourceEntryId: selectedEntry.id,
        sourceName: selectedEntry.name,
      } satisfies GeneratedResult;

      setResults([result]);
      setSavedIds(new Set());
      setSaveErrors({});
      setGenerationMessage("이미지가 완성됐습니다.");

      const historyItem: AiGenerationHistoryItem = {
        ...result,
        profileKey,
      };
      try {
        await saveAiGenerationHistory(historyItem);
        if (
          generationRef.current === generationToken &&
          profileKeyRef.current === profileKey &&
          !controller.signal.aborted
        ) {
          setHistoryItems((current) => [
            historyItem,
            ...current.filter((item) => item.id !== historyItem.id),
          ].slice(0, 8));
          setHistoryError(null);
        }
      } catch (historySaveError) {
        if (
          generationRef.current === generationToken &&
          profileKeyRef.current === profileKey &&
          !controller.signal.aborted
        ) {
          setHistoryError(
            errorMessage(
              historySaveError,
              "이미지는 완성됐지만 이 기기의 기록에 보관하지 못했습니다.",
            ),
          );
        }
      }
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
  }, [aiEnabled, eligibleProfile, onBusyChange, profile, profileKey, prompt, selectedEntry]);

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
        setHistoryItems((current) => current.filter((item) => item.id !== result.id));
        try {
          await removeAiGenerationHistory(result.id, saveProfileKey);
          if (mountedRef.current && profileKeyRef.current === saveProfileKey) {
            setHistoryError(null);
          }
        } catch (historyRemoveError) {
          if (mountedRef.current && profileKeyRef.current === saveProfileKey) {
            setHistoryError(
              errorMessage(
                historyRemoveError,
                "갤러리에는 저장됐지만 이 기기의 기록을 정리하지 못했습니다.",
              ),
            );
          }
        }
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
      anchor.download = safeDownloadName(result.prompt);
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

  const openPreview = useCallback(
    (result: GeneratedResult, trigger: HTMLButtonElement) => {
      setHistoryOpen(false);
      previewTriggerRef.current = trigger;
      setPreviewResult(result);
    },
    [],
  );

  const closePreview = useCallback(() => {
    const trigger = previewTriggerRef.current;
    previewTriggerRef.current = null;
    setPreviewResult(null);
    window.setTimeout(() => trigger?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!previewResult) return;

    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    previewCloseRef.current?.focus();

    const handlePreviewKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePreview();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = previewDialogRef.current;
      const focusable = dialog
        ? Array.from(
            dialog.querySelectorAll<HTMLElement>(
              'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          ).filter(
            (element) =>
              element.tabIndex >= 0 && element.getClientRects().length > 0,
          )
        : [];

      if (focusable.length === 0) {
        event.preventDefault();
        dialog?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;
      if (
        event.shiftKey &&
        (activeElement === first || !dialog?.contains(activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (activeElement === last || !dialog?.contains(activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handlePreviewKeyDown);
    return () => {
      window.removeEventListener("keydown", handlePreviewKeyDown);
      document.body.style.overflow = previousBodyOverflow;
    };
  }, [closePreview, previewResult]);

  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
    window.setTimeout(() => historyButtonRef.current?.focus(), 0);
  }, []);

  const openHistory = useCallback(() => {
    previewTriggerRef.current = null;
    setPreviewResult(null);
    setHistoryOpen(true);
  }, []);

  useEffect(() => {
    if (!historyOpen) return;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    historyCloseRef.current?.focus();
    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeHistory();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = historyDialogRef.current;
      const focusable = dialog
        ? Array.from(
            dialog.querySelectorAll<HTMLElement>(
              'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((element) => element.getClientRects().length > 0)
        : [];
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;
      if (event.shiftKey && (activeElement === first || !dialog?.contains(activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleDialogKeyDown);
    return () => {
      window.removeEventListener("keydown", handleDialogKeyDown);
      document.body.style.overflow = previousBodyOverflow;
    };
  }, [closeHistory, historyOpen]);

  const showHistoryItem = useCallback((item: AiGenerationHistoryItem) => {
    setResults([
      {
        id: item.id,
        createdAt: item.createdAt,
        imageDataUrl: item.imageDataUrl,
        mimeType: item.mimeType,
        prompt: item.prompt,
        sourceEntryId: item.sourceEntryId,
        sourceName: item.sourceName,
      },
    ]);
    setPrompt(item.prompt);
    setSelectedEntryId(item.sourceEntryId);
    setSavedIds(new Set());
    setSaveErrors({});
    setGenerationError(null);
    setGenerationMessage("이 기기에 보관한 이전 생성 결과입니다.");
    setHistoryOpen(false);
    window.setTimeout(() => resultHeadingRef.current?.focus(), 0);
  }, []);

  return (
    <section
      className={[styles.generator, className].filter(Boolean).join(" ")}
      aria-labelledby={headingId}
    >
      <header className={styles.header}>
        <h2 id={headingId}>AI로 내 캐릭터 꾸미기</h2>
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
            {!aiEnabled ? (
              <div className={styles.disabledNotice} role="status">
                이 학급은 관리자가 AI 이미지 생성을 꺼 두었습니다.
              </div>
            ) : null}
            <fieldset disabled={!aiEnabled || isGenerating || savingIds.size > 0}>
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
                <div
                  className={styles.sourceGrid}
                  aria-label="내 갤러리 사진 가로 목록"
                >
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

            <fieldset disabled={!aiEnabled || isGenerating || savingIds.size > 0}>
              <label className={styles.promptLabel} htmlFor={`${headingId}-prompt`}>
                캐릭터의 상황과 자세를 입력하세요
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
                placeholder="예: 우주선 안에서 오른손을 흔들며 자신 있게 웃는 전신 캐릭터"
                aria-describedby={promptHelpId}
                aria-invalid={Boolean(generationError && !prompt.trim())}
              />
              <div id={promptHelpId} className={styles.promptHelp}>
                <span>상황, 자세, 표정, 옷과 배경을 구체적으로 적어 보세요.</span>
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
              disabled={!aiEnabled || !selectedEntry || !prompt.trim() || isGenerating || savingIds.size > 0}
              aria-describedby={apiNoticeId}
            >
              {isGenerating ? (
                <LoaderCircle className={styles.spinner} size={19} aria-hidden="true" />
              ) : (
                <Sparkles size={19} aria-hidden="true" />
              )}
              {isGenerating ? "AI 이미지 만드는 중" : "AI 이미지 만들기"}
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
              <button
                ref={historyButtonRef}
                type="button"
                className={styles.historyButton}
                onClick={openHistory}
                aria-haspopup="dialog"
                aria-label={`이 기기의 미저장 생성 기록 ${historyItems.length}개 보기`}
              >
                <History size={16} aria-hidden="true" />
                기록
              </button>
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
                    ? "완성되면 이곳에 표시됩니다."
                    : "사진을 선택하고 원하는 상황이나 자세를 설명해 이미지를 만들어 보세요."}
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
                        <button
                          type="button"
                          className={styles.resultImageButton}
                          onClick={(event) =>
                            openPreview(result, event.currentTarget)
                          }
                          aria-haspopup="dialog"
                          aria-label={`AI 생성 결과 전체보기: ${result.prompt}`}
                        >
                          {/* Generated Data URLs cannot use an image optimization loader. */}
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={result.imageDataUrl}
                            alt={`AI로 생성한 캐릭터: ${result.prompt}`}
                          />
                          <span className={styles.fullViewHint} aria-hidden="true">
                            <Maximize2 size={15} />
                            전체보기
                          </span>
                        </button>
                        <h4 id={resultTitleId}>AI 생성</h4>
                      </div>
                      <div className={styles.resultActions}>
                        <button
                          type="button"
                          className={styles.saveButton}
                          onClick={() => void saveResult(result)}
                          disabled={saving || saved || busy}
                          aria-label={`AI 생성 결과 ${saving ? "갤러리에 저장 중" : saved ? "갤러리에 저장됨" : "갤러리에 저장"}`}
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
                          aria-label="AI 생성 결과 PNG 다운로드"
                          title="AI 생성 결과 PNG 다운로드"
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

      {previewResult ? (
        <div className={styles.previewBackdrop}>
          <button
            type="button"
            className={styles.previewBackdropClose}
            onClick={closePreview}
            tabIndex={-1}
            aria-label="배경을 눌러 전체보기 닫기"
          />
          <section
            ref={previewDialogRef}
            className={styles.previewDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${headingId}-preview-title`}
            aria-describedby={`${headingId}-preview-description`}
            tabIndex={-1}
          >
            <header className={styles.previewHeader}>
              <div>
                <span>FULL VIEW</span>
                <h3 id={`${headingId}-preview-title`}>AI 생성 이미지 전체보기</h3>
              </div>
              <button
                ref={previewCloseRef}
                type="button"
                className={styles.previewClose}
                onClick={closePreview}
                aria-label="전체보기 닫기"
              >
                <X size={21} aria-hidden="true" />
              </button>
            </header>
            <div className={styles.previewImageFrame}>
              {/* Generated Data URLs cannot use an image optimization loader. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={previewResult.imageDataUrl}
                alt={`AI로 생성한 캐릭터 전체보기: ${previewResult.prompt}`}
              />
            </div>
            <p
              id={`${headingId}-preview-description`}
              className={styles.previewDescription}
            >
              {previewResult.prompt}
            </p>
          </section>
        </div>
      ) : null}

      {historyOpen ? (
        <div className={styles.historyBackdrop}>
          <section
            ref={historyDialogRef}
            className={styles.historyDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${headingId}-history-title`}
          >
            <header className={styles.historyHeader}>
              <div>
                <span>DEVICE ONLY</span>
                <h3 id={`${headingId}-history-title`}>생성 기록</h3>
              </div>
              <button
                ref={historyCloseRef}
                type="button"
                className={styles.historyClose}
                onClick={closeHistory}
                aria-label="생성 기록 닫기"
              >
                <X size={19} aria-hidden="true" />
              </button>
            </header>
            <p className={styles.historyDescription}>
              아직 갤러리에 저장하지 않은 결과만 이 기기에 보관됩니다.
            </p>
            {historyError ? (
              <p className={styles.historyError} role="alert">
                {historyError}
              </p>
            ) : null}
            {historyLoading ? (
              <div className={styles.historyEmpty} role="status">
                <LoaderCircle className={styles.spinner} size={24} aria-hidden="true" />
                기록을 불러오는 중입니다.
              </div>
            ) : historyItems.length === 0 ? (
              <div className={styles.historyEmpty}>
                <History size={25} aria-hidden="true" />
                <strong>아직 미저장 기록이 없습니다</strong>
              </div>
            ) : (
              <div className={styles.historyGrid}>
                {historyItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={styles.historyCard}
                    onClick={() => showHistoryItem(item)}
                    aria-label={`${formatSavedAt(item.createdAt)} 생성 결과 보기. 프롬프트: ${item.prompt}`}
                  >
                    {/* Device-local Data URLs cannot use an image optimization loader. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={item.imageDataUrl} alt="" />
                    <span>{formatSavedAt(item.createdAt)}</span>
                    <strong>{item.prompt}</strong>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      ) : null}
    </section>
  );
}

export default AiImageGenerator;
