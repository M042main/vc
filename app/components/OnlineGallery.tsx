"use client";

import {
  CircleAlert,
  CloudUpload,
  Download,
  Images,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Trash2,
  UserRound,
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
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  deleteGalleryEntry,
  publishGalleryEntry,
  subscribeClassRecords,
  subscribeGalleryEntries,
  type ClassRecord,
  type GalleryEntry,
} from "../lib/firebaseGallery";
import type { VisitorProfile } from "../lib/visitorProfile";
import styles from "./OnlineGallery.module.css";

const GALLERY_NAME_COOKIE = "motion_ink_gallery_name";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const NAME_MAX_LENGTH = 24;

type NameAction =
  | { kind: "download"; entry: GalleryEntry }
  | { kind: "edit" };

export interface OnlineGalleryProps {
  /** The latest transparent PNG capture produced by the studio. */
  pendingCapture?: {
    imageDataUrl: string;
    fileName: string;
  } | null;
  /** @deprecated Prefer pendingCapture when the studio can provide a filename. */
  captureDataUrl?: string | null;
  className?: string;
  isAdmin?: boolean;
  profile?: VisitorProfile | null;
  onUploadComplete?: (entry: GalleryEntry | void) => void;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function normalizeName(value: string) {
  return Array.from(value.trim().replace(/\s+/g, " "))
    .slice(0, NAME_MAX_LENGTH)
    .join("");
}

function readNameCookie() {
  if (typeof document === "undefined") return "";
  for (const pair of document.cookie.split(";")) {
    const separator = pair.indexOf("=");
    const rawKey = (separator >= 0 ? pair.slice(0, separator) : pair).trim();
    if (rawKey !== GALLERY_NAME_COOKIE) continue;
    const rawValue = separator >= 0 ? pair.slice(separator + 1) : "";
    try {
      return normalizeName(decodeURIComponent(rawValue));
    } catch {
      return "";
    }
  }
  return "";
}

function writeNameCookie(name: string) {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${GALLERY_NAME_COOKIE}=${encodeURIComponent(name)}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`;
}

function safeFilename(value: string) {
  const withoutControlCharacters = Array.from(value.normalize("NFKC"), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? "-" : character;
  }).join("");
  const normalized = withoutControlCharacters
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return Array.from(normalized).slice(0, 48).join("") || "character";
}

function formatDate(timestamp: number) {
  if (!Number.isFinite(timestamp)) return "업로드 시간 없음";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "업로드 시간 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function dateTimeValue(timestamp: number) {
  if (!Number.isFinite(timestamp)) return undefined;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function isPngDataUrl(value: string | null | undefined): value is string {
  return Boolean(value && /^data:image\/png(?:;[^,]*)?,/i.test(value));
}

export function OnlineGallery({
  pendingCapture,
  captureDataUrl: legacyCaptureDataUrl,
  className,
  isAdmin = false,
  profile = null,
  onUploadComplete,
}: OnlineGalleryProps) {
  const headingId = useId();
  const nameHeadingId = useId();
  const nameDescriptionId = useId();
  const [entries, setEntries] = useState<GalleryEntry[]>([]);
  const [classes, setClasses] = useState<ClassRecord[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(true);
  const [galleryError, setGalleryError] = useState<string | null>(null);
  const [subscriptionVersion, setSubscriptionVersion] = useState(0);
  const [viewerName, setViewerName] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameAction, setNameAction] = useState<NameAction | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deleteCandidateId, setDeleteCandidateId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState("");
  const [classFilter, setClassFilter] = useState("all");
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const objectUrlsRef = useRef(new Set<string>());
  const revokeTimersRef = useRef(new Set<number>());
  const captureDataUrl = pendingCapture?.imageDataUrl ?? legacyCaptureDataUrl;
  const captureReady = isPngDataUrl(captureDataUrl);

  useEffect(() => {
    const timer = window.setTimeout(() => setViewerName(readNameCookie()), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    let active = true;
    let unsubscribe: () => void = () => undefined;
    const connectTimer = window.setTimeout(() => {
      if (!active) return;
      try {
        unsubscribe = subscribeGalleryEntries({
          onData: (nextEntries) => {
            if (!active) return;
            setEntries(
              [...nextEntries].sort(
                (left, right) => right.createdAt - left.createdAt,
              ),
            );
            setGalleryLoading(false);
            setGalleryError(null);
          },
          onError: (error) => {
            if (!active) return;
            setGalleryLoading(false);
            setGalleryError(
              errorMessage(error, "온라인 갤러리를 불러오지 못했습니다."),
            );
          },
        });
      } catch (error) {
        if (active) {
          setGalleryLoading(false);
          setGalleryError(
            errorMessage(error, "온라인 갤러리를 연결하지 못했습니다."),
          );
        }
      }
    }, 0);

    return () => {
      active = false;
      window.clearTimeout(connectTimer);
      unsubscribe();
    };
  }, [subscriptionVersion]);

  useEffect(() => {
    let active = true;
    let unsubscribe: () => void = () => undefined;
    const timer = window.setTimeout(() => {
      if (!active) return;
      unsubscribe = subscribeClassRecords({
        onData: (nextClasses) => {
          if (active) setClasses(nextClasses);
        },
        onError: () => {
          // Gallery entries remain available under "all" when class metadata fails.
        },
      });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const urls = objectUrlsRef.current;
    const timers = revokeTimersRef.current;
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
    };
  }, []);

  useEffect(() => {
    if (isAdmin) return;
    const timer = window.setTimeout(() => {
      setDeleteCandidateId(null);
      setDeleteError(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isAdmin]);

  useEffect(() => {
    if (!nameAction) return;
    const timer = window.setTimeout(() => {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [nameAction]);

  const formattedCount = useMemo(
    () => new Intl.NumberFormat("ko-KR").format(entries.length),
    [entries.length],
  );
  const classOptions = classes;
  const activeClassIds = useMemo(
    () => new Set(classes.map((classRecord) => classRecord.id)),
    [classes],
  );
  const effectiveClassFilter =
    classFilter === "all" ||
    classFilter === "unclassified" ||
    activeClassIds.has(classFilter)
      ? classFilter
      : "unclassified";
  const visibleEntries = useMemo(
    () =>
      entries.filter((entry) => {
        if (effectiveClassFilter === "all") return true;
        if (effectiveClassFilter === "unclassified") {
          return !entry.classId || !activeClassIds.has(entry.classId);
        }
        return entry.classId === effectiveClassFilter;
      }),
    [activeClassIds, effectiveClassFilter, entries],
  );

  const closeNameDialog = useCallback(() => {
    setNameAction(null);
    setNameError(null);
    window.setTimeout(() => returnFocusRef.current?.focus(), 0);
  }, []);

  const openNameDialog = useCallback(
    (action: NameAction, trigger?: HTMLElement | null) => {
      returnFocusRef.current = trigger ?? null;
      setNameDraft(viewerName);
      setNameError(null);
      setNameAction(action);
    },
    [viewerName],
  );

  const uploadCapture = useCallback(
    async (activeProfile: VisitorProfile) => {
      if (!isPngDataUrl(captureDataUrl)) {
        setActionMessage("먼저 현재 캐릭터를 PNG로 캡처해 주세요.");
        return;
      }
      if (isUploading) return;
      setIsUploading(true);
      setActionMessage("현재 캡처를 온라인 갤러리에 올리는 중입니다.");
      try {
        const entry = await publishGalleryEntry({
          profile: activeProfile,
          imageDataUrl: captureDataUrl,
        });
        setEntries((currentEntries) => [
          entry,
          ...currentEntries.filter((currentEntry) => currentEntry.id !== entry.id),
        ]);
        setActionMessage(
          `${entry.name} 이름으로 저장했습니다. 온라인 갤러리에 바로 표시됩니다.`,
        );
        onUploadComplete?.(entry);
      } catch (error) {
        setActionMessage(
          errorMessage(error, "캐릭터를 온라인 갤러리에 올리지 못했습니다."),
        );
      } finally {
        setIsUploading(false);
      }
    },
    [captureDataUrl, isUploading, onUploadComplete],
  );

  const downloadEntry = useCallback(
    async (entry: GalleryEntry, downloaderName: string) => {
      if (downloadingId) return;
      setDownloadingId(entry.id);
      setActionMessage(`${entry.name}님의 캐릭터를 준비하고 있습니다.`);
      try {
        const response = await fetch(entry.imageDataUrl);
        if (!response.ok) throw new Error("이미지 파일을 읽지 못했습니다.");
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        objectUrlsRef.current.add(objectUrl);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = `${safeFilename(downloaderName)}-${safeFilename(entry.name)}.png`;
        anchor.style.display = "none";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        const timer = window.setTimeout(() => {
          URL.revokeObjectURL(objectUrl);
          objectUrlsRef.current.delete(objectUrl);
          revokeTimersRef.current.delete(timer);
        }, 1_000);
        revokeTimersRef.current.add(timer);
        setActionMessage("캐릭터 PNG 다운로드를 시작했습니다.");
      } catch (error) {
        setActionMessage(errorMessage(error, "캐릭터를 다운로드하지 못했습니다."));
      } finally {
        setDownloadingId(null);
      }
    },
    [downloadingId],
  );

  const requestUpload = useCallback(
    () => {
      if (!captureReady || isUploading) return;
      if (!profile) {
        setActionMessage("먼저 이름과 학급 프로필을 설정해 주세요.");
        return;
      }
      if (profile.guest) {
        setActionMessage("게스트는 온라인 갤러리에 저장할 수 없습니다.");
        return;
      }
      void uploadCapture(profile);
    },
    [captureReady, isUploading, profile, uploadCapture],
  );

  const requestDownload = useCallback(
    (entry: GalleryEntry, event: ReactMouseEvent<HTMLButtonElement>) => {
      const downloaderName = profile?.name || viewerName;
      if (!downloaderName) {
        openNameDialog({ kind: "download", entry }, event.currentTarget);
        return;
      }
      void downloadEntry(entry, downloaderName);
    },
    [downloadEntry, openNameDialog, profile?.name, viewerName],
  );

  const requestDelete = useCallback(
    (entry: GalleryEntry) => {
      if (!isAdmin || deletingId) return;
      setDeleteCandidateId(entry.id);
      setDeleteError(null);
    },
    [deletingId, isAdmin],
  );

  const cancelDelete = useCallback(() => {
    if (deletingId) return;
    setDeleteCandidateId(null);
    setDeleteError(null);
  }, [deletingId]);

  const confirmDelete = useCallback(
    async (entry: GalleryEntry) => {
      if (!isAdmin || deletingId || deleteCandidateId !== entry.id) return;
      setDeletingId(entry.id);
      setDeleteError(null);
      setActionMessage(`${entry.name}님의 캐릭터를 갤러리에서 삭제하는 중입니다.`);
      try {
        await deleteGalleryEntry(entry.id);
        setEntries((currentEntries) =>
          currentEntries.filter((currentEntry) => currentEntry.id !== entry.id),
        );
        setDeleteCandidateId(null);
        setActionMessage(`${entry.name}님의 캐릭터를 갤러리에서 삭제했습니다.`);
      } catch (error) {
        const message = errorMessage(
          error,
          "캐릭터를 갤러리에서 삭제하지 못했습니다.",
        );
        setDeleteError(message);
        setActionMessage(message);
      } finally {
        setDeletingId(null);
      }
    },
    [deleteCandidateId, deletingId, isAdmin],
  );

  const submitName = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const nextName = normalizeName(nameDraft);
      if (!nextName) {
        setNameError("사용할 이름을 입력해 주세요.");
        nameInputRef.current?.focus();
        return;
      }
      writeNameCookie(nextName);
      setViewerName(nextName);
      const action = nameAction;
      setNameAction(null);
      setNameError(null);
      if (action?.kind === "download") void downloadEntry(action.entry, nextName);
      if (action?.kind === "edit") setActionMessage("사용할 이름을 수정했습니다.");
      window.setTimeout(() => returnFocusRef.current?.focus(), 0);
    },
    [downloadEntry, nameAction, nameDraft],
  );

  const handleDialogKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeNameDialog();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [closeNameDialog],
  );

  useEffect(() => {
    if (!nameAction) return;
    document.addEventListener("keydown", handleDialogKeyDown);
    return () => document.removeEventListener("keydown", handleDialogKeyDown);
  }, [handleDialogKeyDown, nameAction]);

  return (
    <section
      className={[styles.gallery, className].filter(Boolean).join(" ")}
      aria-labelledby={headingId}
    >
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>
            <span aria-hidden="true" /> ONLINE GALLERY · LIVE
          </span>
          <h2 id={headingId}>함께 만든 캐릭터를 둘러보세요</h2>
          <p>
            현재 캡처를 올리고, 마음에 드는 캐릭터는 PNG로 내려받을 수
            있습니다. 목록은 Firebase에서 실시간으로 업데이트됩니다.
          </p>
        </div>
        <div className={styles.liveCount} aria-label={`갤러리 캐릭터 ${formattedCount}개`}>
          <strong>{formattedCount}</strong>
          <span>CHARACTERS</span>
        </div>
      </header>

      <div className={styles.toolbar}>
        <div className={styles.capturePanel} data-ready={captureReady}>
          <div className={styles.capturePreview}>
            {captureReady ? (
              // The image is a browser-local PNG Data URL supplied by the studio.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={captureDataUrl} alt="현재 캡처 PNG 미리보기" />
            ) : (
              <Images size={24} aria-hidden="true" />
            )}
          </div>
          <div className={styles.captureCopy}>
            <span>현재 캡처</span>
            <strong>
              {captureReady
                ? pendingCapture?.fileName || "업로드 준비 완료"
                : "PNG 캡처를 준비해 주세요"}
            </strong>
          </div>
          <button
            type="button"
            className={styles.uploadButton}
            onClick={requestUpload}
            disabled={!captureReady || isUploading || !profile || profile.guest}
            aria-label="현재 캡처 PNG를 온라인 갤러리에 업로드"
          >
            {isUploading ? (
              <LoaderCircle className={styles.spinner} size={17} aria-hidden="true" />
            ) : (
              <CloudUpload size={17} aria-hidden="true" />
            )}
            {isUploading ? "올리는 중" : "갤러리에 올리기"}
          </button>
        </div>

        <div className={styles.namePanel}>
          <span className={styles.userIcon} aria-hidden="true">
            <UserRound size={18} />
          </span>
          <div>
            <span>활성 프로필</span>
            <strong>
              {profile
                ? `${profile.className} · ${profile.name}`
                : viewerName || "프로필을 먼저 설정해 주세요"}
            </strong>
          </div>
          {profile ? (
            <span className={styles.profileState}>
              {profile.guest ? "클라우드 저장 꺼짐" : "자동 이름 저장"}
            </span>
          ) : (
            <button
              type="button"
              className={styles.editNameButton}
              onClick={(event) =>
                openNameDialog({ kind: "edit" }, event.currentTarget)
              }
              aria-label={viewerName ? "저장된 이름 수정" : "다운로드에 사용할 이름 설정"}
            >
              <Pencil size={15} aria-hidden="true" />
              {viewerName ? "수정" : "설정"}
            </button>
          )}
        </div>
      </div>

      <div className={styles.galleryFilter}>
        <label htmlFor={`${headingId}-class-filter`}>학급별 보기</label>
        <select
          id={`${headingId}-class-filter`}
          value={effectiveClassFilter}
          onChange={(event) => setClassFilter(event.target.value)}
        >
          <option value="all">전체 학급</option>
          {classOptions.map((item) => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
          <option value="unclassified">미분류 · 이전 갤러리</option>
        </select>
        <span>{visibleEntries.length}개 표시</span>
      </div>

      <p className={styles.actionStatus} role="status" aria-live="polite">
        {actionMessage}
      </p>

      <div className={styles.content} aria-busy={galleryLoading}>
        {galleryLoading ? (
          <div className={styles.loadingState} role="status" aria-live="polite">
            <LoaderCircle className={styles.spinner} size={24} aria-hidden="true" />
            <strong>온라인 갤러리를 불러오는 중입니다.</strong>
            <span>잠시만 기다려 주세요.</span>
          </div>
        ) : galleryError ? (
          <div className={styles.errorState} role="alert">
            <CircleAlert size={28} aria-hidden="true" />
            <strong>갤러리를 불러오지 못했습니다.</strong>
            <span>{galleryError}</span>
            <button
              type="button"
              onClick={() => {
                setGalleryLoading(true);
                setGalleryError(null);
                setSubscriptionVersion((version) => version + 1);
              }}
            >
              <RefreshCw size={16} aria-hidden="true" /> 다시 시도
            </button>
          </div>
        ) : visibleEntries.length === 0 ? (
          <div className={styles.emptyState} role="status">
            <Images size={34} aria-hidden="true" />
            <strong>아직 올라온 캐릭터가 없습니다.</strong>
            <span>첫 번째 캐릭터를 갤러리에 남겨보세요.</span>
          </div>
        ) : (
          <div className={styles.grid} role="list" aria-label="온라인 캐릭터 목록">
            {visibleEntries.map((entry) => (
              <article className={styles.card} role="listitem" key={entry.id}>
                <div className={styles.cardImage}>
                  {/* Firebase entries contain PNG Data URLs created by this app. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={entry.imageDataUrl}
                    alt={`${entry.name}님이 올린 캐릭터`}
                    loading="lazy"
                    decoding="async"
                  />
                </div>
                <div className={styles.cardBody}>
                  <div>
                    <h3>{entry.name}</h3>
                    <span className={styles.cardClass}>
                      {entry.classId && activeClassIds.has(entry.classId)
                        ? entry.className
                        : "미분류 · 이전 기록"}
                    </span>
                    <time dateTime={dateTimeValue(entry.createdAt)}>
                      {formatDate(entry.createdAt)}
                    </time>
                  </div>
                  <div className={styles.cardActions}>
                    <button
                      type="button"
                      className={styles.downloadButton}
                      onClick={(event) => requestDownload(entry, event)}
                      disabled={downloadingId !== null || deletingId !== null}
                      aria-label={`${entry.name}님의 캐릭터 PNG 다운로드`}
                    >
                      {downloadingId === entry.id ? (
                        <LoaderCircle
                          className={styles.spinner}
                          size={17}
                          aria-hidden="true"
                        />
                      ) : (
                        <Download size={17} aria-hidden="true" />
                      )}
                      <span>{downloadingId === entry.id ? "준비 중" : "PNG 받기"}</span>
                    </button>
                    {/* 관리자 UI는 실수 방지용이며, 실제 삭제 권한은 동일 출처 서버 경로에서 인증 이메일로 확인합니다. */}
                    {isAdmin ? (
                      <button
                        type="button"
                        className={styles.deleteButton}
                        onClick={() => requestDelete(entry)}
                        disabled={deletingId !== null}
                        aria-label={`${entry.name}님의 캐릭터 삭제 선택`}
                        aria-expanded={deleteCandidateId === entry.id}
                        aria-controls={
                          deleteCandidateId === entry.id
                            ? `delete-confirm-${entry.id}`
                            : undefined
                        }
                      >
                        <Trash2 size={16} aria-hidden="true" />
                        <span>삭제</span>
                      </button>
                    ) : null}
                  </div>
                </div>
                {isAdmin && deleteCandidateId === entry.id ? (
                  <div
                    id={`delete-confirm-${entry.id}`}
                    className={styles.deleteConfirm}
                    role="group"
                    aria-label={`${entry.name}님의 캐릭터 삭제 확인`}
                  >
                    <p>
                      <strong>{entry.name}</strong>님의 캐릭터를 정말 삭제할까요?
                    </p>
                    <div>
                      <button
                        type="button"
                        className={styles.confirmDeleteButton}
                        onClick={() => void confirmDelete(entry)}
                        disabled={deletingId !== null}
                      >
                        {deletingId === entry.id ? (
                          <LoaderCircle
                            className={styles.spinner}
                            size={16}
                            aria-hidden="true"
                          />
                        ) : (
                          <Trash2 size={16} aria-hidden="true" />
                        )}
                        {deletingId === entry.id ? "삭제 중" : "삭제 확인"}
                      </button>
                      <button
                        type="button"
                        className={styles.cancelDeleteButton}
                        onClick={cancelDelete}
                        disabled={deletingId !== null}
                      >
                        취소
                      </button>
                    </div>
                    {deleteError ? (
                      <span className={styles.deleteError} role="alert">
                        {deleteError}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </div>

      {nameAction ? (
        <div className={styles.dialogBackdrop}>
          <div
            ref={dialogRef}
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={nameHeadingId}
            aria-describedby={nameDescriptionId}
          >
            <button
              type="button"
              className={styles.dialogClose}
              onClick={closeNameDialog}
              aria-label="이름 입력 창 닫기"
            >
              <X size={18} aria-hidden="true" />
            </button>
            <span className={styles.dialogIcon} aria-hidden="true">
              <UserRound size={23} />
            </span>
            <h3 id={nameHeadingId}>
              {nameAction.kind === "edit" ? "사용할 이름 수정" : "이름을 알려주세요"}
            </h3>
            <p id={nameDescriptionId}>
              처음 입력한 이름은 이 브라우저에 1년간 저장되며 언제든 수정할 수
              있습니다.
            </p>
            <form onSubmit={submitName}>
              <label htmlFor={`${nameHeadingId}-input`}>이름</label>
              <input
                ref={nameInputRef}
                id={`${nameHeadingId}-input`}
                value={nameDraft}
                onChange={(event) => {
                  setNameDraft(event.target.value);
                  if (nameError) setNameError(null);
                }}
                maxLength={NAME_MAX_LENGTH}
                autoComplete="nickname"
                aria-invalid={Boolean(nameError)}
                aria-describedby={nameError ? `${nameHeadingId}-error` : undefined}
                placeholder="예: 박근석"
              />
              {nameError ? (
                <span id={`${nameHeadingId}-error`} className={styles.nameError} role="alert">
                  {nameError}
                </span>
              ) : null}
              <button type="submit" className={styles.confirmNameButton}>
                {nameAction.kind === "download"
                  ? "이름 저장하고 다운로드"
                  : "이름 저장"}
              </button>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default OnlineGallery;
