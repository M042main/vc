"use client";

import {
  lazy,
  Suspense,
  useCallback,
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
  ClassOnboarding,
  useVisitorProfile,
} from "./components/ClassOnboarding";
import {
  VrmStudio,
  type VrmStudioCapture,
} from "./components/VrmStudio";
import {
  loadLatestCharacterArtwork,
  saveLatestCharacterArtwork,
} from "./lib/firebaseGallery";
import { PaperDollCharacterStore } from "./lib/paperDollCharacterStore";
import {
  visitorArtworkKey,
  type VisitorProfile,
} from "./lib/visitorProfile";

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

function characterStorageId(profile: VisitorProfile) {
  return profile.guest
    ? `${SAVED_CHARACTER_ID}:guest`
    : `${SAVED_CHARACTER_ID}:${visitorArtworkKey(profile)}`;
}

export default function Home() {
  const { profile, profileReady, setProfile } = useVisitorProfile();
  const [mode, setMode] = useState<WorkspaceMode>("studio");
  const [characterArtwork, setCharacterArtwork] = useState<string | null>(null);
  const [characterArtworkOwnerKey, setCharacterArtworkOwnerKey] =
    useState("profile-loading");
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
  const characterArtworkKey = !profileReady
    ? "profile-loading"
    : profile
      ? characterStorageId(profile)
      : "profile-unset";
  const activeCharacterArtwork =
    characterArtworkOwnerKey === characterArtworkKey ? characterArtwork : null;

  const restoreAdminTriggerFocus = useCallback(() => {
    window.setTimeout(() => {
      adminButtonRef.current?.focus();
    }, 0);
  }, []);

  useEffect(() => {
    const store = new PaperDollCharacterStore();
    characterStoreRef.current = store;

    return () => {
      if (characterStoreRef.current === store) characterStoreRef.current = null;
      void store.close();
    };
  }, []);

  useEffect(() => {
    if (!profileReady) return;
    const restoreGeneration = artworkGenerationRef.current + 1;
    artworkGenerationRef.current = restoreGeneration;

    if (!profile) {
      const resetTimer = window.setTimeout(() => {
        if (artworkGenerationRef.current === restoreGeneration) {
          setCharacterArtworkOwnerKey("profile-unset");
          setCharacterArtwork(null);
        }
      }, 0);
      return () => window.clearTimeout(resetTimer);
    }

    const storageId = characterStorageId(profile);
    const resetTimer = window.setTimeout(() => {
      if (artworkGenerationRef.current === restoreGeneration) {
        setCharacterArtworkOwnerKey(storageId);
        setCharacterArtwork(null);
      }
    }, 0);
    let legacyGuestArtwork: string | null = null;
    if (profile.guest) {
      try {
        legacyGuestArtwork = window.localStorage.getItem(SAVED_CHARACTER_KEY);
      } catch {
        // IndexedDB and the current in-memory session remain available.
      }
    }

    const localCharacter = characterStoreRef.current
      ?.get(storageId)
      .catch(() => null) ?? Promise.resolve(null);
    const cloudCharacter = profile.guest
      ? Promise.resolve(null)
      : loadLatestCharacterArtwork(profile).catch(() => null);

    void Promise.all([localCharacter, cloudCharacter]).then(
      ([localSaved, cloudSaved]) => {
        if (artworkGenerationRef.current !== restoreGeneration) return;
        const restoredArtwork =
          cloudSaved?.imageDataUrl ??
          (typeof localSaved?.artwork === "string" ? localSaved.artwork : null) ??
          legacyGuestArtwork;
        setCharacterArtworkOwnerKey(storageId);
        setCharacterArtwork(restoredArtwork);
      },
    );
    return () => window.clearTimeout(resetTimer);
  }, [profile, profileReady]);

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
        restoreAdminTriggerFocus();
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
  }, [adminDialogOpen, adminMode, restoreAdminTriggerFocus]);

  const openAdminDialog = () => {
    setAdminIdDraft("");
    setAdminError(null);
    setAdminDialogOpen(true);
  };

  const closeAdminDialog = () => {
    setAdminDialogOpen(false);
    setAdminIdDraft("");
    setAdminError(null);
    restoreAdminTriggerFocus();
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

  const handleSendToStudio = async (dataUrl: string) => {
    if (!profile) throw new Error("먼저 이름과 학급 프로필을 설정해 주세요.");
    const saveGeneration = artworkGenerationRef.current + 1;
    artworkGenerationRef.current = saveGeneration;
    const storageId = characterStorageId(profile);
    setCharacterArtworkOwnerKey(storageId);
    setCharacterArtwork(dataUrl);
    const localSave = characterStoreRef.current
      ?.save({
        id: storageId,
        name: `${profile.className} · ${profile.name}`,
        artwork: dataUrl,
        playback: { presetId: "idle", playbackRate: 1, loop: true },
      })
      .catch(() => undefined);

    if (profile.guest) {
      try {
        window.localStorage.setItem(SAVED_CHARACTER_KEY, dataUrl);
      } catch {
        // The current session still keeps the artwork when storage is unavailable.
      }
      await localSave;
    } else {
      await Promise.all([localSave, saveLatestCharacterArtwork(profile, dataUrl)]);
    }
    if (artworkGenerationRef.current !== saveGeneration) return;
    setMode("studio");
  };

  const profileGateBlocking = !profile && profileReady;
  const adminAccessButton = (
    <button
      ref={adminButtonRef}
      className="admin-access-button"
      type="button"
      data-active={adminMode}
      onClick={openAdminDialog}
      aria-haspopup="dialog"
      aria-label={adminMode ? "m042 관리자 설정 열기" : "관리자 m042 접근"}
    >
      <Settings size={18} aria-hidden="true" />
      <span>{adminMode ? "m042 관리자" : "관리자"}</span>
    </button>
  );

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

      </header>

      {profileGateBlocking ? null : adminAccessButton}

      <section className="workspace" id="top">
        <ClassOnboarding
          className="profile-shell"
          profile={profile}
          profileReady={profileReady}
          blocking={profileGateBlocking}
          isAdmin={adminMode}
          blockingModalControl={adminAccessButton}
          onProfileChange={setProfile}
        />
        {mode === "studio" ? (
          <VrmStudio
            artwork={activeCharacterArtwork}
            onCaptureReady={setLatestCapture}
          />
        ) : mode === "creator" ? (
          <CharacterCreator
            initialArtwork={activeCharacterArtwork}
            initialArtworkKey={characterArtworkKey}
            onSendToStudio={handleSendToStudio}
          />
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
              profile={profile}
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
                <p>관리자 모드가 켜져 있습니다. 학급을 만들거나 삭제하고 갤러리 사진을 관리할 수 있습니다.</p>
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
