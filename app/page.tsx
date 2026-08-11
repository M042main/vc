"use client";

import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Camera,
  Images,
  LogOut,
  Paintbrush,
  Settings,
  ShieldCheck,
  X,
} from "lucide-react";
import { CharacterCreator } from "./components/CharacterCreator";
import {
  VrmStudio,
  type VrmStudioCapture,
} from "./components/VrmStudio";
import { PaperDollCharacterStore } from "./lib/paperDollCharacterStore";

const OnlineGallery = lazy(() =>
  import("./components/OnlineGallery").then((module) => ({
    default: module.OnlineGallery,
  })),
);

type WorkspaceMode = "studio" | "creator" | "gallery";
// T-pose artwork uses a separate room from the legacy downward-arm rig. The
// old v1 key and record remain untouched so existing drawings are preserved,
// but they are never interpreted with incompatible T-pose joints.
const SAVED_CHARACTER_KEY = "motion-ink.saved-character.t-pose.v2";
const SAVED_CHARACTER_ID = "motion-ink-latest-character-t-pose-v2";
const ADMIN_ID = "m042";
const ADMIN_SESSION_KEY = "virtual-creator.admin.m042";

export default function Home() {
  const [mode, setMode] = useState<WorkspaceMode>("studio");
  const [characterArtwork, setCharacterArtwork] = useState<string | null>(null);
  const [latestCapture, setLatestCapture] = useState<VrmStudioCapture | null>(null);
  const [adminMode, setAdminMode] = useState(false);
  const [adminDialogOpen, setAdminDialogOpen] = useState(false);
  const [adminIdDraft, setAdminIdDraft] = useState("");
  const [adminError, setAdminError] = useState<string | null>(null);
  const characterStoreRef = useRef<PaperDollCharacterStore | null>(null);
  const artworkGenerationRef = useRef(0);
  const adminButtonRef = useRef<HTMLButtonElement>(null);
  const adminDialogRef = useRef<HTMLElement>(null);
  const adminInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const store = new PaperDollCharacterStore();
    characterStoreRef.current = store;
    let active = true;
    const restoreGeneration = artworkGenerationRef.current;
    let fallbackArtwork: string | null = null;
    try {
      fallbackArtwork = window.localStorage.getItem(SAVED_CHARACTER_KEY);
    } catch {
      // Private browsing modes may disable local storage. The studio still works
      // for the current tab, so no user-facing failure is necessary here.
    }

    void store
      .get(SAVED_CHARACTER_ID)
      .then((character) => {
        if (!active || artworkGenerationRef.current !== restoreGeneration) return;
        const savedArtwork =
          typeof character?.artwork === "string"
            ? character.artwork
            : fallbackArtwork;
        if (savedArtwork) setCharacterArtwork(savedArtwork);
      })
      .catch(() => {
        if (
          active &&
          artworkGenerationRef.current === restoreGeneration &&
          fallbackArtwork
        ) {
          setCharacterArtwork(fallbackArtwork);
        }
      });

    return () => {
      active = false;
      if (characterStoreRef.current === store) characterStoreRef.current = null;
      void store.close();
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        setAdminMode(
          window.sessionStorage.getItem(ADMIN_SESSION_KEY) === "active",
        );
      } catch {
        // Session storage can be unavailable in strict privacy modes.
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!adminDialogOpen) return;
    const focusTimer = window.setTimeout(() => {
      if (adminMode) adminDialogRef.current?.focus();
      else adminInputRef.current?.focus();
    }, 0);
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAdminDialogOpen(false);
        setAdminIdDraft("");
        setAdminError(null);
        window.setTimeout(() => adminButtonRef.current?.focus(), 0);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = adminDialogRef.current?.querySelectorAll<HTMLElement>(
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
    };
    document.addEventListener("keydown", handleEscape);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [adminDialogOpen, adminMode]);

  const openAdminDialog = () => {
    setAdminIdDraft("");
    setAdminError(null);
    setAdminDialogOpen(true);
  };

  const closeAdminDialog = () => {
    setAdminDialogOpen(false);
    setAdminIdDraft("");
    setAdminError(null);
    window.setTimeout(() => adminButtonRef.current?.focus(), 0);
  };

  const enterAdminMode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (adminIdDraft.normalize("NFKC").trim().toLowerCase() !== ADMIN_ID) {
      setAdminError("관리자 이름이 일치하지 않습니다.");
      adminInputRef.current?.focus();
      return;
    }
    setAdminMode(true);
    setMode("gallery");
    try {
      window.sessionStorage.setItem(ADMIN_SESSION_KEY, "active");
    } catch {
      // The current tab still keeps admin mode even without session storage.
    }
    closeAdminDialog();
  };

  const leaveAdminMode = () => {
    setAdminMode(false);
    try {
      window.sessionStorage.removeItem(ADMIN_SESSION_KEY);
    } catch {
      // Nothing else is required when session storage is unavailable.
    }
    closeAdminDialog();
  };

  const handleSendToStudio = (dataUrl: string) => {
    artworkGenerationRef.current += 1;
    setCharacterArtwork(dataUrl);
    try {
      window.localStorage.setItem(SAVED_CHARACTER_KEY, dataUrl);
    } catch {
      // Keep the in-memory character even when the browser storage quota is full.
    }
    void characterStoreRef.current
      ?.save({
        id: SAVED_CHARACTER_ID,
        name: "내가 그린 캐릭터",
        artwork: dataUrl,
        playback: { presetId: "idle", playbackRate: 1, loop: true },
      })
      .catch(() => undefined);
    setMode("studio");
  };

  return (
    <main className="site-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Virtual Creator 홈">
          <span className="brand-mark" aria-hidden="true">
            VC
          </span>
          <span>
            <strong>VIRTUAL CREATOR</strong>
            <small>나만의 움직임, 한 장의 캐릭터</small>
          </span>
        </a>

        <nav className="mode-switch" aria-label="작업 공간 선택">
          <button
            className={mode === "studio" ? "is-active" : ""}
            onClick={() => setMode("studio")}
            type="button"
          >
            <Camera size={17} aria-hidden="true" />
            트래킹 스튜디오
          </button>
          <button
            className={mode === "creator" ? "is-active" : ""}
            onClick={() => setMode("creator")}
            type="button"
          >
            <Paintbrush size={17} aria-hidden="true" />
            캐릭터 만들기
          </button>
          <button
            className={mode === "gallery" ? "is-active" : ""}
            onClick={() => setMode("gallery")}
            type="button"
            aria-label={
              latestCapture
                ? "온라인 갤러리, 업로드할 새 캡처 있음"
                : "온라인 갤러리"
            }
          >
            <Images size={17} aria-hidden="true" />
            온라인 갤러리
            {latestCapture ? (
              <span className="gallery-ready-dot" aria-hidden="true" />
            ) : null}
          </button>
        </nav>

        <button
          ref={adminButtonRef}
          className="admin-access-button"
          type="button"
          data-active={adminMode}
          onClick={openAdminDialog}
          aria-label={adminMode ? "m042 관리자 설정 열기" : "관리자 m042 접근"}
        >
          <Settings size={18} aria-hidden="true" />
          <span>{adminMode ? "m042 관리자" : "관리자"}</span>
        </button>
      </header>

      <section className="workspace" id="top">
        {mode === "studio" ? (
          <VrmStudio
            artwork={characterArtwork}
            onCaptureReady={setLatestCapture}
          />
        ) : mode === "creator" ? (
          <CharacterCreator onSendToStudio={handleSendToStudio} />
        ) : (
          <Suspense
            fallback={
              <div className="gallery-loading-shell" role="status">
                온라인 갤러리를 여는 중입니다.
              </div>
            }
          >
            <OnlineGallery
              pendingCapture={latestCapture}
              onUploadComplete={() => setLatestCapture(null)}
              isAdmin={adminMode}
            />
          </Suspense>
        )}
      </section>

      {adminDialogOpen ? (
        <div className="admin-dialog-backdrop">
          <section
            ref={adminDialogRef}
            className="admin-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="admin-dialog-title"
            tabIndex={-1}
          >
            <button
              className="admin-dialog-close"
              type="button"
              onClick={closeAdminDialog}
              aria-label="관리자 창 닫기"
            >
              <X size={18} aria-hidden="true" />
            </button>
            <span className="admin-dialog-icon" aria-hidden="true">
              <ShieldCheck size={24} />
            </span>
            <h2 id="admin-dialog-title">m042 관리자</h2>
            {adminMode ? (
              <>
                <p>관리자 모드가 켜져 있습니다. 갤러리에서 사진을 선택해 삭제할 수 있습니다.</p>
                <button
                  className="admin-logout-button"
                  type="button"
                  onClick={leaveAdminMode}
                >
                  <LogOut size={17} aria-hidden="true" /> 관리자 모드 종료
                </button>
              </>
            ) : (
              <form onSubmit={enterAdminMode}>
                <p>갤러리 관리 기능을 열려면 관리자 이름을 입력하세요.</p>
                <label htmlFor="admin-id">관리자 이름</label>
                <input
                  ref={adminInputRef}
                  id="admin-id"
                  value={adminIdDraft}
                  onChange={(event) => {
                    setAdminIdDraft(event.target.value);
                    if (adminError) setAdminError(null);
                  }}
                  autoComplete="username"
                  maxLength={24}
                  aria-invalid={Boolean(adminError)}
                  aria-describedby={adminError ? "admin-id-error" : undefined}
                />
                {adminError ? (
                  <span id="admin-id-error" className="admin-error" role="alert">
                    {adminError}
                  </span>
                ) : null}
                <button className="admin-submit-button" type="submit">
                  관리자 모드 열기
                </button>
              </form>
            )}
          </section>
        </div>
      ) : null}
    </main>
  );
}
