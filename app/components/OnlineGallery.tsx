"use client";

import {
  CircleAlert,
  Download,
  Heart,
  Images,
  LoaderCircle,
  Maximize2,
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
  getGalleryLikeActorKey,
  subscribeClassRecords,
  subscribeGalleryEntries,
  toggleGalleryEntryLike,
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
  className?: string;
  isAdmin?: boolean;
  profile?: VisitorProfile | null;
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

export function OnlineGallery({
  className,
  isAdmin = false,
  profile = null,
}: OnlineGalleryProps) {
  const headingId = useId();
  const nameHeadingId = useId();
  const nameDescriptionId = useId();
  const previewHeadingId = useId();
  const [entries, setEntries] = useState<GalleryEntry[]>([]);
  const [classes, setClasses] = useState<ClassRecord[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(true);
  const [galleryError, setGalleryError] = useState<string | null>(null);
  const [subscriptionVersion, setSubscriptionVersion] = useState(0);
  const [viewerName, setViewerName] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameAction, setNameAction] = useState<NameAction | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [likeActor, setLikeActor] = useState<{
    owner: string;
    key: string;
  } | null>(null);
  const [likingIds, setLikingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [optimisticLikes, setOptimisticLikes] = useState<
    Record<string, boolean>
  >({});
  const [likeErrors, setLikeErrors] = useState<Record<string, string>>({});
  const [deleteCandidateId, setDeleteCandidateId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState("");
  const [classFilter, setClassFilter] = useState("all");
  const [previewEntry, setPreviewEntry] = useState<GalleryEntry | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const previewDialogRef = useRef<HTMLElement>(null);
  const previewCloseRef = useRef<HTMLButtonElement>(null);
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const objectUrlsRef = useRef(new Set<string>());
  const revokeTimersRef = useRef(new Set<number>());
  const likeInFlightRef = useRef(new Set<string>());
  const likeOwner =
    profile && !profile.guest
      ? `${profile.classId ?? ""}:${profile.name}`
      : null;
  const likeActorKey =
    likeActor && likeActor.owner === likeOwner ? likeActor.key : null;

  useEffect(() => {
    const timer = window.setTimeout(() => setViewerName(readNameCookie()), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    let active = true;
    const owner = likeOwner;
    const timer = window.setTimeout(() => {
      if (!active || !owner || !profile || profile.guest) return;
      try {
        const key = getGalleryLikeActorKey(profile);
        if (active) setLikeActor({ owner, key });
      } catch (error) {
        if (active) {
          setActionMessage(
            errorMessage(error, "좋아요 기능을 준비하지 못했습니다."),
          );
        }
      }
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [likeOwner, profile]);

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
            if (error instanceof AggregateError) {
              setActionMessage(error.message);
              return;
            }
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

  const closePreview = useCallback(() => {
    const trigger = previewTriggerRef.current;
    previewTriggerRef.current = null;
    setPreviewEntry(null);
    window.setTimeout(() => trigger?.focus(), 0);
  }, []);

  const openPreview = useCallback(
    (entry: GalleryEntry, trigger: HTMLButtonElement) => {
      returnFocusRef.current = null;
      setNameAction(null);
      setNameError(null);
      previewTriggerRef.current = trigger;
      setPreviewEntry(entry);
    },
    [],
  );

  const openNameDialog = useCallback(
    (action: NameAction, trigger?: HTMLElement | null) => {
      previewTriggerRef.current = null;
      setPreviewEntry(null);
      returnFocusRef.current = trigger ?? null;
      setNameDraft(viewerName);
      setNameError(null);
      setNameAction(action);
    },
    [viewerName],
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

  const requestLike = useCallback(
    async (entry: GalleryEntry) => {
      if (!profile) {
        setActionMessage("좋아요를 누르려면 먼저 학급 프로필을 설정해 주세요.");
        return;
      }
      if (profile.guest) {
        setActionMessage(
          "게스트는 로컬 체험만 가능해요. 학급 프로필로 참여하면 좋아요를 남길 수 있습니다.",
        );
        return;
      }
      if (!likeActorKey) {
        setActionMessage("좋아요 기능을 준비하고 있습니다. 잠시 후 다시 눌러 주세요.");
        return;
      }
      if (likeInFlightRef.current.has(entry.id)) return;

      const wasLiked = entry.likeActorKeys.includes(likeActorKey);
      const nextLiked = !wasLiked;
      likeInFlightRef.current.add(entry.id);
      setLikingIds((current) => new Set(current).add(entry.id));
      setOptimisticLikes((current) => ({
        ...current,
        [entry.id]: nextLiked,
      }));
      setLikeErrors((current) => {
        const next = { ...current };
        delete next[entry.id];
        return next;
      });

      try {
        const savedLiked = await toggleGalleryEntryLike({
          entryId: entry.id,
          actorKey: likeActorKey,
          liked: nextLiked,
        });
        setEntries((currentEntries) =>
          currentEntries.map((currentEntry) => {
            if (currentEntry.id !== entry.id) return currentEntry;
            const alreadyIncluded =
              currentEntry.likeActorKeys.includes(likeActorKey);
            const likeActorKeys = savedLiked
              ? alreadyIncluded
                ? currentEntry.likeActorKeys
                : [...currentEntry.likeActorKeys, likeActorKey].sort()
              : currentEntry.likeActorKeys.filter(
                  (actorKey) => actorKey !== likeActorKey,
                );
            return {
              ...currentEntry,
              likeActorKeys,
              likeCount: likeActorKeys.length,
            };
          }),
        );
        setActionMessage(
          savedLiked ? `${entry.name}님의 캐릭터를 좋아합니다.` : "좋아요를 취소했습니다.",
        );
      } catch (error) {
        const message = errorMessage(error, "좋아요를 저장하지 못했습니다.");
        setLikeErrors((current) => ({ ...current, [entry.id]: message }));
        setActionMessage(message);
      } finally {
        likeInFlightRef.current.delete(entry.id);
        setOptimisticLikes((current) => {
          const next = { ...current };
          delete next[entry.id];
          return next;
        });
        setLikingIds((current) => {
          const next = new Set(current);
          next.delete(entry.id);
          return next;
        });
      }
    },
    [likeActorKey, profile],
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

  useEffect(() => {
    if (!previewEntry) return;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => {
      previewCloseRef.current?.focus();
    }, 0);
    const handlePreviewKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePreview();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = previewDialogRef.current;
      const focusable = dialog?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
      if (!dialog || !focusable?.length) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const focusIsOutside = !dialog.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || focusIsOutside)) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || focusIsOutside)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handlePreviewKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handlePreviewKeyDown);
      document.body.style.overflow = previousBodyOverflow;
    };
  }, [closePreview, previewEntry]);

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
        </div>
        <select
          id={`${headingId}-class-filter`}
          className={styles.galleryFilter}
          value={effectiveClassFilter}
          onChange={(event) => setClassFilter(event.target.value)}
          aria-label="학급별 갤러리 필터"
        >
          <option value="all">전체 학급</option>
          {classOptions.map((item) => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
          <option value="unclassified">미분류 · 이전 갤러리</option>
        </select>
      </header>

      {profile?.guest ? (
        <p className={styles.guestNotice} role="note">
          게스트 체험에서는 캐릭터와 캡처가 이 기기에만 남습니다. 온라인
          갤러리 업로드와 좋아요는 학급 프로필로 참여할 때 사용할 수 있어요.
        </p>
      ) : null}

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
            {visibleEntries.map((entry) => {
              const serverLiked = Boolean(
                likeActorKey && entry.likeActorKeys.includes(likeActorKey),
              );
              const optimisticLiked = optimisticLikes[entry.id];
              const displayedLiked = optimisticLiked ?? serverLiked;
              const displayedLikeCount = Math.max(
                0,
                entry.likeCount +
                  (optimisticLiked === undefined || optimisticLiked === serverLiked
                    ? 0
                    : optimisticLiked
                      ? 1
                      : -1),
              );
              const likeBusy = likingIds.has(entry.id);
              const likeLabel = `${entry.name}님의 캐릭터 좋아요${
                displayedLiked ? " 취소" : ""
              }, 현재 ${displayedLikeCount}개`;

              return (
              <article className={styles.card} role="listitem" key={entry.id}>
                <button
                  type="button"
                  className={styles.cardImage}
                  onClick={(event) => openPreview(entry, event.currentTarget)}
                  aria-haspopup="dialog"
                  aria-label={`${entry.name}님의 캐릭터 전체보기`}
                  title={`${entry.name}님의 캐릭터 전체보기`}
                >
                  {/* Firebase entries contain PNG Data URLs created by this app. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={entry.imageDataUrl}
                    alt={`${entry.name}님이 올린 캐릭터`}
                    loading="lazy"
                    decoding="async"
                  />
                  <span className={styles.cardImageHint} aria-hidden="true">
                    <Maximize2 size={14} /> 전체보기
                  </span>
                </button>
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
                      aria-label={
                        downloadingId === entry.id
                          ? `${entry.name}님의 캐릭터 PNG 준비 중`
                          : `${entry.name}님의 캐릭터 PNG 다운로드`
                      }
                      title={`${entry.name}님의 캐릭터 PNG 다운로드`}
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
                    </button>
                    <button
                      type="button"
                      className={styles.likeButton}
                      data-liked={displayedLiked}
                      onClick={() => void requestLike(entry)}
                      disabled={likeBusy || deletingId !== null}
                      aria-label={likeLabel}
                      aria-pressed={displayedLiked}
                      title={likeLabel}
                    >
                      {likeBusy ? (
                        <LoaderCircle
                          className={styles.spinner}
                          size={17}
                          aria-hidden="true"
                        />
                      ) : (
                        <Heart
                          size={17}
                          fill={displayedLiked ? "currentColor" : "none"}
                          aria-hidden="true"
                        />
                      )}
                      <span aria-hidden="true">{displayedLikeCount}</span>
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
                {likeErrors[entry.id] ? (
                  <p className={styles.likeError} role="alert">
                    {likeErrors[entry.id]}
                  </p>
                ) : null}
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
              );
            })}
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

      {previewEntry ? (
        // Backdrop click is a pointer convenience; keyboard users have Escape
        // and the labelled close button inside the focus-trapped dialog.
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
        <div
          className={styles.previewBackdrop}
          onClick={(event) => {
            if (event.target === event.currentTarget) closePreview();
          }}
        >
          <section
            ref={previewDialogRef}
            className={styles.previewDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={previewHeadingId}
            tabIndex={-1}
          >
            <header className={styles.previewHeader}>
              <div>
                <span>전체보기</span>
                <h3 id={previewHeadingId}>{previewEntry.name}님의 캐릭터</h3>
              </div>
              <button
                ref={previewCloseRef}
                type="button"
                className={styles.previewClose}
                onClick={closePreview}
                aria-label="전체보기 닫기"
              >
                <X size={22} aria-hidden="true" />
              </button>
            </header>
            <figure className={styles.previewFigure}>
              <div className={styles.previewImage}>
                {/* Firebase entries contain PNG Data URLs created by this app. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={previewEntry.imageDataUrl}
                  alt={`${previewEntry.name}님이 올린 캐릭터 전체보기`}
                  decoding="async"
                />
              </div>
              <figcaption>
                <span>
                  {previewEntry.classId && activeClassIds.has(previewEntry.classId)
                    ? previewEntry.className
                    : "미분류 · 이전 기록"}
                </span>
                <time dateTime={dateTimeValue(previewEntry.createdAt)}>
                  {formatDate(previewEntry.createdAt)}
                </time>
              </figcaption>
            </figure>
          </section>
        </div>
      ) : null}
    </section>
  );
}

export default OnlineGallery;
