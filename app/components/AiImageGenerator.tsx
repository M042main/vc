"use client";

import {
  Download,
  ImagePlus,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from "react";
import styles from "./AiImageGenerator.module.css";

const MAX_SOURCE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 25_000_000;
const MIN_SOURCE_EDGE = 64;
const MAX_REQUEST_EDGE = 2_048;
const MAX_REQUEST_DATA_URL_CHARACTERS = 9 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 600;
const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const PROMPT_PRESETS = [
  {
    id: "animation",
    label: "애니메이션",
    prompt:
      "사진 속 인물의 특징과 표정을 살린 세련된 애니메이션 캐릭터로 만들어 주세요. 전신이 화면 안에 보이게 하고 깔끔한 단색 배경을 사용해 주세요.",
  },
  {
    id: "three-dimensional",
    label: "3D 캐릭터",
    prompt:
      "사진 속 인물의 얼굴과 헤어스타일, 옷의 특징을 유지한 친근한 3D 캐릭터로 만들어 주세요. 자연스러운 전신 포즈와 스튜디오 조명을 사용해 주세요.",
  },
  {
    id: "storybook",
    label: "그림책",
    prompt:
      "사진 속 인물을 따뜻한 색감의 손그림 그림책 캐릭터로 바꿔 주세요. 인물의 표정과 개성을 유지하고 전신을 보여 주세요.",
  },
] as const;

interface AiGenerateResponse {
  imageDataUrl: string;
  mimeType: string;
}

interface SourceImage {
  dataUrl: string;
  requestDataUrl: string;
  fileName: string;
  width: number;
  height: number;
}

export interface AiImageGeneratorProps {
  className?: string;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatFileLimit() {
  return `${MAX_SOURCE_FILE_BYTES / 1024 / 1024}MB`;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("사진 파일을 읽지 못했습니다."));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("사진 파일을 읽지 못했습니다."));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function inspectImage(dataUrl: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error("손상되었거나 지원하지 않는 사진입니다."));
    image.onload = () =>
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.src = dataUrl;
  });
}

function isGeneratedImageResponse(value: unknown): value is AiGenerateResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.imageDataUrl === "string" &&
    /^data:image\/(?:png|jpeg|webp);base64,/u.test(candidate.imageDataUrl) &&
    typeof candidate.mimeType === "string" &&
    ACCEPTED_IMAGE_TYPES.has(candidate.mimeType)
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
    // The fallback below also covers non-JSON gateway errors.
  }
  return response.status === 429
    ? "요청이 많습니다. 잠시 후 다시 시도해 주세요."
    : "AI 이미지를 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

function imageElement(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("생성된 이미지를 다운로드하지 못했습니다."));
    image.src = dataUrl;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: "image/jpeg" | "image/png",
  quality?: number,
) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PNG 파일을 만들지 못했습니다."));
    }, mimeType, quality);
  });
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("전송용 사진을 준비하지 못했습니다."));
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("전송용 사진을 준비하지 못했습니다."));
    };
    reader.readAsDataURL(blob);
  });
}

async function prepareRequestImage(
  dataUrl: string,
  sourceMimeType: string,
  sourceWidth: number,
  sourceHeight: number,
) {
  const image = await imageElement(dataUrl);
  const outputMimeType = sourceMimeType === "image/jpeg" ? "image/jpeg" : "image/png";
  let scale = Math.min(1, MAX_REQUEST_EDGE / Math.max(sourceWidth, sourceHeight));

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(MIN_SOURCE_EDGE, Math.round(sourceWidth * scale));
    canvas.height = Math.max(MIN_SOURCE_EDGE, Math.round(sourceHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("사진 크기 조절 기능을 사용할 수 없습니다.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await canvasToBlob(
      canvas,
      outputMimeType,
      outputMimeType === "image/jpeg" ? 0.88 : undefined,
    );
    const requestDataUrl = await blobToDataUrl(blob);
    if (requestDataUrl.length <= MAX_REQUEST_DATA_URL_CHARACTERS) {
      return requestDataUrl;
    }
    scale *= 0.75;
  }

  throw new Error("전송용 사진을 준비하지 못했습니다. 더 작은 사진을 선택해 주세요.");
}

async function pngBlobFromDataUrl(dataUrl: string) {
  const image = await imageElement(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("PNG 변환 기능을 사용할 수 없습니다.");
  context.drawImage(image, 0, 0);
  return canvasToBlob(canvas, "image/png");
}

function safeDownloadName(fileName: string) {
  const base = fileName.replace(/\.[^.]+$/u, "").normalize("NFKC");
  const withoutControlCharacters = Array.from(base, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? "-" : character;
  }).join("");
  const safe = withoutControlCharacters
    .replace(/[\\/:*?"<>|]/gu, "-")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 48);
  return `${safe || "my-character"}-ai.png`;
}

export function AiImageGenerator({ className }: AiImageGeneratorProps) {
  const headingId = useId();
  const fileHelpId = useId();
  const promptHelpId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectFileButtonRef = useRef<HTMLButtonElement>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const downloadUrlRef = useRef<string | null>(null);
  const [source, setSource] = useState<SourceImage | null>(null);
  const [prompt, setPrompt] = useState<string>(PROMPT_PRESETS[0].prompt);
  const [activePreset, setActivePreset] = useState<string>(PROMPT_PRESETS[0].id);
  const [result, setResult] = useState<AiGenerateResponse | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);

  useEffect(
    () => () => {
      requestRef.current?.abort();
      if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
    },
    [],
  );

  const acceptFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setFileError(null);
    setRequestError(null);
    setResult(null);
    if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
      setFileError("JPG, PNG 또는 WebP 사진만 사용할 수 있습니다.");
      return;
    }
    if (file.size <= 0 || file.size > MAX_SOURCE_FILE_BYTES) {
      setFileError(`사진은 ${formatFileLimit()} 이하로 선택해 주세요.`);
      return;
    }

    setIsReading(true);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const dimensions = await inspectImage(dataUrl);
      if (
        dimensions.width < MIN_SOURCE_EDGE ||
        dimensions.height < MIN_SOURCE_EDGE
      ) {
        throw new Error("사진의 가로와 세로는 각각 64px 이상이어야 합니다.");
      }
      if (dimensions.width * dimensions.height > MAX_SOURCE_PIXELS) {
        throw new Error("사진 해상도는 2,500만 픽셀 이하로 선택해 주세요.");
      }
      const requestDataUrl = await prepareRequestImage(
        dataUrl,
        file.type,
        dimensions.width,
        dimensions.height,
      );
      setSource({
        dataUrl,
        requestDataUrl,
        fileName: file.name,
        width: dimensions.width,
        height: dimensions.height,
      });
    } catch (error) {
      setSource(null);
      setFileError(errorMessage(error, "사진을 불러오지 못했습니다."));
    } finally {
      setIsReading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, []);

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      void acceptFile(event.target.files?.[0]);
    },
    [acceptFile],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);
      if (isGenerating || isReading) return;
      void acceptFile(event.dataTransfer.files?.[0]);
    },
    [acceptFile, isGenerating, isReading],
  );

  const generate = useCallback(async () => {
    const normalizedPrompt = prompt.trim();
    if (!source) {
      setFileError("먼저 캐릭터로 만들 사진을 선택해 주세요.");
      selectFileButtonRef.current?.focus();
      return;
    }
    if (!normalizedPrompt) {
      setRequestError("만들고 싶은 캐릭터를 설명해 주세요.");
      return;
    }
    if (normalizedPrompt.length > MAX_PROMPT_LENGTH) {
      setRequestError(`설명은 ${MAX_PROMPT_LENGTH}자 이하로 입력해 주세요.`);
      return;
    }

    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setIsGenerating(true);
    setRequestError(null);
    try {
      const response = await fetch("/api/ai/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: normalizedPrompt,
          imageDataUrl: source.requestDataUrl,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await responseError(response));
      const value: unknown = await response.json();
      const generatedImage = generatedImageFromPayload(value);
      if (!generatedImage) {
        throw new Error("AI가 올바른 이미지 결과를 보내지 않았습니다.");
      }
      setResult(generatedImage);
      window.setTimeout(() => resultHeadingRef.current?.focus(), 0);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setRequestError(
        errorMessage(error, "AI 이미지를 생성하지 못했습니다. 다시 시도해 주세요."),
      );
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setIsGenerating(false);
      }
    }
  }, [prompt, source]);

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void generate();
    },
    [generate],
  );

  const removeSource = useCallback(() => {
    if (isGenerating) requestRef.current?.abort();
    setSource(null);
    setResult(null);
    setFileError(null);
    setRequestError(null);
  }, [isGenerating]);

  const reset = useCallback(() => {
    requestRef.current?.abort();
    setSource(null);
    setResult(null);
    setFileError(null);
    setRequestError(null);
    setPrompt(PROMPT_PRESETS[0].prompt);
    setActivePreset(PROMPT_PRESETS[0].id);
    setIsGenerating(false);
    setIsDragging(false);
    window.setTimeout(() => selectFileButtonRef.current?.focus(), 0);
  }, []);

  const downloadResult = useCallback(async () => {
    if (!result || !source || isDownloading) return;
    setIsDownloading(true);
    setRequestError(null);
    try {
      const blob = await pngBlobFromDataUrl(result.imageDataUrl);
      if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
      const objectUrl = URL.createObjectURL(blob);
      downloadUrlRef.current = objectUrl;
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = safeDownloadName(source.fileName);
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => {
        if (downloadUrlRef.current === objectUrl) {
          URL.revokeObjectURL(objectUrl);
          downloadUrlRef.current = null;
        }
      }, 1_000);
    } catch (error) {
      setRequestError(errorMessage(error, "PNG 파일을 다운로드하지 못했습니다."));
    } finally {
      setIsDownloading(false);
    }
  }, [isDownloading, result, source]);

  return (
    <section
      className={[styles.generator, className].filter(Boolean).join(" ")}
      aria-labelledby={headingId}
    >
      <header className={styles.header}>
        <div className={styles.titleGroup}>
          <span className={styles.iconBadge} aria-hidden="true">
            <Sparkles size={21} />
          </span>
          <div>
            <span className={styles.eyebrow}>AI CHARACTER IMAGE</span>
            <h2 id={headingId}>내 사진으로 새로운 캐릭터 만들기</h2>
          </div>
        </div>
        <span className={styles.modelBadge}>Gemini 2.5 Flash Image</span>
      </header>

      <div className={styles.layout}>
        <form className={styles.controls} onSubmit={submit}>
          <fieldset disabled={isGenerating || isReading}>
            <legend>참고 사진</legend>
            <input
              ref={fileInputRef}
              className={styles.fileInput}
              id={`${headingId}-photo`}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleFileChange}
              aria-invalid={Boolean(fileError)}
              aria-describedby={
                fileError
                  ? `${source ? "" : `${fileHelpId} `}${fileHelpId}-error`
                  : source
                    ? undefined
                    : fileHelpId
              }
            />
            {source ? (
              <div className={styles.sourcePreview}>
                {/* Browser-selected data URLs cannot use an image optimization loader. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={source.dataUrl} alt="선택한 참고 사진 미리보기" />
                <div className={styles.sourceMeta}>
                  <strong title={source.fileName}>{source.fileName}</strong>
                  <span>
                    {source.width.toLocaleString("ko-KR")} × {source.height.toLocaleString("ko-KR")}px
                  </span>
                </div>
                <button
                  type="button"
                  className={styles.removeButton}
                  onClick={removeSource}
                  aria-label="선택한 사진 지우기"
                  title="선택한 사진 지우기"
                >
                  <X size={18} aria-hidden="true" />
                </button>
              </div>
            ) : (
              <div
                className={styles.dropZone}
                data-dragging={isDragging}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setIsDragging(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setIsDragging(false);
                  }
                }}
                onDrop={handleDrop}
              >
                {isReading ? (
                  <LoaderCircle className={styles.spinner} size={26} aria-hidden="true" />
                ) : (
                  <ImagePlus size={27} aria-hidden="true" />
                )}
                <strong>{isReading ? "사진 확인 중" : "사진을 끌어놓거나 선택하세요"}</strong>
                <span id={fileHelpId}>JPG · PNG · WebP, 최대 {formatFileLimit()}</span>
                <button
                  ref={selectFileButtonRef}
                  type="button"
                  className={styles.selectFileButton}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload size={16} aria-hidden="true" />
                  사진 선택
                </button>
              </div>
            )}
            {fileError ? (
              <p id={`${fileHelpId}-error`} className={styles.errorText} role="alert">
                {fileError}
              </p>
            ) : null}
          </fieldset>

          <fieldset disabled={isGenerating}>
            <legend>캐릭터 스타일</legend>
            <div className={styles.presets} aria-label="캐릭터 스타일 빠른 선택">
              {PROMPT_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={styles.presetButton}
                  data-active={activePreset === preset.id}
                  aria-pressed={activePreset === preset.id}
                  onClick={() => {
                    setPrompt(preset.prompt);
                    setActivePreset(preset.id);
                    setRequestError(null);
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <label className={styles.promptLabel} htmlFor={`${headingId}-prompt`}>
              원하는 모습을 설명하세요
            </label>
            <textarea
              id={`${headingId}-prompt`}
              value={prompt}
              onChange={(event) => {
                setPrompt(event.target.value);
                setActivePreset("");
                if (requestError) setRequestError(null);
              }}
              maxLength={MAX_PROMPT_LENGTH}
              rows={5}
              aria-describedby={promptHelpId}
              aria-invalid={Boolean(requestError && !prompt.trim())}
            />
            <div id={promptHelpId} className={styles.promptHelp}>
              <span>표정, 그림체, 옷, 배경을 자유롭게 적어 보세요.</span>
              <span aria-label={`${prompt.length}자 입력, 최대 ${MAX_PROMPT_LENGTH}자`}>
                {prompt.length}/{MAX_PROMPT_LENGTH}
              </span>
            </div>
          </fieldset>

          <button
            type="submit"
            className={styles.generateButton}
            disabled={!source || !prompt.trim() || isReading || isGenerating}
          >
            {isGenerating ? (
              <LoaderCircle className={styles.spinner} size={19} aria-hidden="true" />
            ) : (
              <Sparkles size={19} aria-hidden="true" />
            )}
            {isGenerating ? "캐릭터 만드는 중" : "AI 캐릭터 만들기"}
          </button>
          <p className={styles.privacyNote}>
            생성 버튼을 누르면 선택한 사진이 Google Gemini API로 전송됩니다.
          </p>
        </form>

        <div className={styles.resultPanel} aria-busy={isGenerating}>
          {isGenerating ? (
            <div className={styles.resultStatus} role="status" aria-live="polite">
              <span className={styles.generatingOrb} aria-hidden="true">
                <Sparkles size={29} />
              </span>
              <strong>AI가 캐릭터를 그리고 있어요</strong>
              <span>완성될 때까지 이 화면을 닫지 마세요.</span>
            </div>
          ) : result ? (
            <div className={styles.resultContent}>
              <h3 ref={resultHeadingRef} tabIndex={-1}>
                캐릭터가 완성됐어요
              </h3>
              <div className={styles.resultImage}>
                {/* Generated data URLs cannot use an image optimization loader. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={result.imageDataUrl} alt="AI로 생성한 캐릭터 결과" />
              </div>
              <div className={styles.resultActions}>
                <button
                  type="button"
                  className={styles.downloadButton}
                  onClick={() => void downloadResult()}
                  disabled={isDownloading}
                >
                  {isDownloading ? (
                    <LoaderCircle className={styles.spinner} size={17} aria-hidden="true" />
                  ) : (
                    <Download size={17} aria-hidden="true" />
                  )}
                  {isDownloading ? "PNG 준비 중" : "PNG 다운로드"}
                </button>
                <button type="button" className={styles.secondaryButton} onClick={() => void generate()}>
                  <RefreshCw size={17} aria-hidden="true" />
                  다시 생성
                </button>
                <button type="button" className={styles.resetButton} onClick={reset}>
                  <RotateCcw size={17} aria-hidden="true" />
                  처음부터
                </button>
              </div>
            </div>
          ) : (
            <div className={styles.resultStatus}>
              <span className={styles.emptyIcon} aria-hidden="true">
                <ImagePlus size={31} />
              </span>
              <strong>생성된 이미지가 여기에 표시됩니다</strong>
              <span>사진과 스타일을 선택한 다음 AI 캐릭터 만들기를 눌러 주세요.</span>
            </div>
          )}
          {requestError ? (
            <div className={styles.requestError} role="alert">
              <strong>생성하지 못했습니다</strong>
              <span>{requestError}</span>
              {source ? (
                <button type="button" onClick={() => void generate()} disabled={isGenerating}>
                  다시 시도
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export default AiImageGenerator;
