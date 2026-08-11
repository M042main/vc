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
  Sparkles,
  X,
} from "lucide-react";
import { CharacterCreator } from "./components/CharacterCreator";
import { SavedCharacterLibrary } from "./components/SavedCharacterLibrary";
import {
  ClassOnboarding,
  useVisitorProfile,
  VisitorProfileActions,
} from "./components/ClassOnboarding";
import {
  VrmStudio,
  type VrmStudioCapture,
} from "./components/VrmStudio";
import {
  deleteCharacterSlot,
  loadSavedCharacterSlots,
  publishGalleryEntry,
  saveCharacterSlot,
} from "./lib/firebaseGallery";
import { PaperDollCharacterStore } from "./lib/paperDollCharacterStore";
import {
  cacheProfileCharacters,
  guestCharacterOwnerKey,
  loadLocalProfileCharacters,
  mergeProfileCharacters,
  nextAvailableCharacterSlot,
  profileCharacterLibraryPrefix,
  profileCharacterName,
  profileCharacterStorageId,
  type ProfileSavedCharacter,
} from "./lib/profileCharacterLibrary";
import {
  loadVisitorProfile,
  visitorArtworkKey,
  type VisitorProfile,
} from "./lib/visitorProfile";

const OnlineGallery = lazy(() =>
  import("./components/OnlineGallery").then((module) => ({
    default: module.OnlineGallery,
  })),
);
const AiImageGenerator = lazy(() =>
  import("./components/AiImageGenerator").then((module) => ({
    default: module.AiImageGenerator,
  })),
);

type WorkspaceMode = "studio" | "creator" | "gallery" | "ai";
// T-pose artwork uses a separate room from the legacy downward-arm rig. The
// old v1 key and record remain untouched so existing drawings are preserved,
// but they are never interpreted with incompatible T-pose joints.
const SAVED_CHARACTER_KEY = "motion-ink.saved-character.t-pose.v2";
const SAVED_CHARACTER_ID = "motion-ink-latest-character-t-pose-v2";
const LEGACY_GUEST_CHARACTER_OWNER_KEY = `${SAVED_CHARACTER_KEY}:migration-owner`;
const ADMIN_ID = "m042";
const ADMIN_SESSION_KEY = "virtual-creator.admin.m042";
const GALLERY_IMAGE_TARGET_BYTES = Math.floor(5.5 * 1024 * 1024);

type LibraryMutationToken = {
  epoch: number;
  profileKey: string;
};

type LibraryMutationState = LibraryMutationToken & {
  busy: boolean;
};

type LibraryMutationRef = {
  current: LibraryMutationState;
};

function libraryProfileKey(profile: VisitorProfile | null) {
  return profile
    ? JSON.stringify([
        profile.guest,
        profile.classId,
        profile.className,
        profile.name,
      ])
    : "profile:none";
}

function beginLibraryMutation(
  mutationRef: LibraryMutationRef,
  profile: VisitorProfile | null,
  supersede = false,
): LibraryMutationToken | null {
  if (mutationRef.current.busy && !supersede) return null;
  const token = {
    epoch: mutationRef.current.epoch + 1,
    profileKey: libraryProfileKey(profile),
  };
  mutationRef.current = { ...token, busy: true };
  return token;
}

function isLibraryMutationCurrent(
  mutationRef: LibraryMutationRef,
  token: LibraryMutationToken,
) {
  const current = mutationRef.current;
  return (
    current.busy &&
    current.epoch === token.epoch &&
    current.profileKey === token.profileKey &&
    libraryProfileKey(loadVisitorProfile()) === token.profileKey
  );
}

function finishLibraryMutation(
  mutationRef: LibraryMutationRef,
  token: LibraryMutationToken,
) {
  const current = mutationRef.current;
  if (
    !current.busy ||
    current.epoch !== token.epoch ||
    current.profileKey !== token.profileKey
  ) {
    return false;
  }
  mutationRef.current = { ...current, busy: false };
  return true;
}

function guestCharacterArtworkKey(profile: VisitorProfile) {
  return `${SAVED_CHARACTER_KEY}:${guestCharacterOwnerKey(profile)}`;
}

function loadGuestCharacterArtwork(profile: VisitorProfile) {
  const storage = window.localStorage;
  const guestOwnerKey = guestCharacterOwnerKey(profile);
  const guestArtworkKey = guestCharacterArtworkKey(profile);
  const guestArtwork = storage.getItem(guestArtworkKey);
  if (guestArtwork) return guestArtwork;

  // The old v2 key is intentionally kept. Only the first named guest on this
  // device may claim and copy it, so a later guest cannot see shared artwork.
  const legacyArtwork = storage.getItem(SAVED_CHARACTER_KEY);
  if (!legacyArtwork) return null;
  const migrationOwner = storage.getItem(LEGACY_GUEST_CHARACTER_OWNER_KEY);
  if (migrationOwner && migrationOwner !== guestOwnerKey) return null;
  if (!migrationOwner) {
    storage.setItem(LEGACY_GUEST_CHARACTER_OWNER_KEY, guestOwnerKey);
    if (storage.getItem(LEGACY_GUEST_CHARACTER_OWNER_KEY) !== guestOwnerKey) {
      return null;
    }
  }
  storage.setItem(guestArtworkKey, legacyArtwork);
  return legacyArtwork;
}

function characterStorageId(profile: VisitorProfile) {
  return profile.guest
    ? `${SAVED_CHARACTER_ID}:${guestCharacterOwnerKey(profile)}`
    : `${SAVED_CHARACTER_ID}:${visitorArtworkKey(profile)}`;
}

function loadDataUrlImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("갤러리용 PNG를 읽지 못했습니다."));
    image.src = dataUrl;
  });
}

function canvasToPngDataUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("갤러리용 PNG를 만들지 못했습니다."));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== "string") {
          reject(new Error("갤러리용 PNG를 변환하지 못했습니다."));
          return;
        }
        resolve(reader.result);
      };
      reader.onerror = () =>
        reject(new Error("갤러리용 PNG를 변환하지 못했습니다."));
      reader.readAsDataURL(blob);
    }, "image/png");
  });
}

async function prepareGalleryImageDataUrl(dataUrl: string): Promise<string> {
  if (dataUrl.length <= GALLERY_IMAGE_TARGET_BYTES) return dataUrl;

  const image = await loadDataUrlImage(dataUrl);
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error("갤러리용 PNG 크기를 확인하지 못했습니다.");
  }

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("갤러리용 PNG를 처리하지 못했습니다.");

  let scale = Math.min(
    0.92,
    Math.sqrt(GALLERY_IMAGE_TARGET_BYTES / dataUrl.length) * 0.92,
  );
  for (let attempt = 0; attempt < 7; attempt += 1) {
    canvas.width = Math.max(320, Math.round(sourceWidth * scale));
    canvas.height = Math.max(400, Math.round(sourceHeight * scale));
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const resized = await canvasToPngDataUrl(canvas);
    if (resized.length <= GALLERY_IMAGE_TARGET_BYTES) return resized;
    scale *= 0.76;
  }

  throw new Error(
    "사진 배경이 너무 복잡해 갤러리용 PNG를 줄이지 못했습니다. 배경 미포함으로 다시 저장해 주세요.",
  );
}

export default function Home() {
  const { profile, profileReady, setProfile } = useVisitorProfile();
  const [mode, setMode] = useState<WorkspaceMode>("studio");
  const [characterArtwork, setCharacterArtwork] = useState<string | null>(null);
  const [characterArtworkOwnerKey, setCharacterArtworkOwnerKey] =
    useState("profile-loading");
  const [savedCharacters, setSavedCharacters] = useState<ProfileSavedCharacter[]>([]);
  const [activeCharacterId, setActiveCharacterId] = useState<string | null>(null);
  const [stageCharacterId, setStageCharacterId] = useState<string | null>(null);
  const [characterLibraryBusy, setCharacterLibraryBusy] = useState(false);
  const [latestCapture, setLatestCapture] = useState<VrmStudioCapture | null>(null);
  const [adminMode, setAdminMode] = useState(false);
  const [adminDialogOpen, setAdminDialogOpen] = useState(false);
  const [adminIdDraft, setAdminIdDraft] = useState("");
  const [adminError, setAdminError] = useState<string | null>(null);
  const characterStoreRef = useRef<PaperDollCharacterStore | null>(null);
  const artworkGenerationRef = useRef(0);
  const libraryMutationRef = useRef<LibraryMutationState>({
    epoch: 0,
    profileKey: "profile-loading",
    busy: false,
  });
  const pendingProfileTransitionRef = useRef<LibraryMutationToken | null>(null);
  const profileMigrationRef = useRef<{
    targetKey: string;
    characters: ProfileSavedCharacter[];
    activeId: string | null;
  } | null>(null);
  const adminButtonRef = useRef<HTMLButtonElement>(null);
  const adminDialogRef = useRef<HTMLElement>(null);
  const adminInputRef = useRef<HTMLInputElement>(null);
  const characterArtworkKey = !profileReady
    ? "profile-loading"
    : profile
      ? characterStorageId(profile)
      : "profile-unset";
  const characterEditorKey = `${characterArtworkKey}:${activeCharacterId ?? "new"}`;
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
    const expectedProfileKey = libraryProfileKey(profile);
    const pendingTransition = pendingProfileTransitionRef.current;
    const canReuseTransition = Boolean(
      pendingTransition &&
        pendingTransition.profileKey === expectedProfileKey &&
        libraryMutationRef.current.busy &&
        libraryMutationRef.current.epoch === pendingTransition.epoch &&
        libraryMutationRef.current.profileKey === pendingTransition.profileKey,
    );
    const mutationToken = canReuseTransition
      ? pendingTransition
      : beginLibraryMutation(libraryMutationRef, profile, true);
    pendingProfileTransitionRef.current = null;
    if (!mutationToken) return;

    const restoreGeneration = artworkGenerationRef.current + 1;
    artworkGenerationRef.current = restoreGeneration;
    let effectActive = true;
    const restoreIsCurrent = () =>
      effectActive &&
      artworkGenerationRef.current === restoreGeneration &&
      isLibraryMutationCurrent(libraryMutationRef, mutationToken);
    const finishRestore = () => {
      if (finishLibraryMutation(libraryMutationRef, mutationToken) && effectActive) {
        setCharacterLibraryBusy(false);
      }
    };

    if (!profile) {
      const resetTimer = window.setTimeout(() => {
        if (!restoreIsCurrent()) return;
        setCharacterArtworkOwnerKey("profile-unset");
        setCharacterArtwork(null);
        setSavedCharacters([]);
        setActiveCharacterId(null);
        setStageCharacterId(null);
        finishRestore();
      }, 0);
      return () => {
        effectActive = false;
        window.clearTimeout(resetTimer);
      };
    }

    const profileLibraryKey = profileCharacterLibraryPrefix(profile);
    const legacyStorageId = characterStorageId(profile);
    const resetTimer = window.setTimeout(() => {
      if (!restoreIsCurrent()) return;
      setCharacterLibraryBusy(true);
      setCharacterArtworkOwnerKey(legacyStorageId);
      setCharacterArtwork(null);
      setSavedCharacters([]);
      setActiveCharacterId(null);
      setStageCharacterId(null);
    }, 0);
    let legacyGuestArtwork: string | null = null;
    if (profile.guest) {
      try {
        legacyGuestArtwork = loadGuestCharacterArtwork(profile);
      } catch {
        // IndexedDB and the current in-memory session remain available.
      }
    }

    const store = characterStoreRef.current;
    const localCharacters = store
      ? loadLocalProfileCharacters(profile, store).catch(() => [])
      : Promise.resolve([]);
    const legacyCharacter = store
      ? store.get(legacyStorageId).catch(() => null)
      : Promise.resolve(null);
    const cloudCharacters = profile.guest
      ? Promise.resolve([])
      : loadSavedCharacterSlots(profile).catch(() => []);
    const migration =
      profileMigrationRef.current?.targetKey === profileLibraryKey
        ? profileMigrationRef.current
        : null;

    void (async () => {
      const [localSaved, legacySaved, cloudSaved] = await Promise.all([
        localCharacters,
        legacyCharacter,
        cloudCharacters,
      ]);
      if (!restoreIsCurrent()) return;
      let restored = migration?.characters.length
        ? migration.characters.map((character) => ({
            ...character,
            storageId: profileCharacterStorageId(profile, character.id),
          }))
        : mergeProfileCharacters(profile, localSaved, cloudSaved);

      if (restored.length === 0) {
        const legacyArtwork =
          (typeof legacySaved?.artwork === "string" ? legacySaved.artwork : null) ??
          legacyGuestArtwork;
        if (legacyArtwork) {
          restored = [{
            id: "slot-1",
            storageId: profileCharacterStorageId(profile, "slot-1"),
            name: profileCharacterName("slot-1"),
            artwork: legacyArtwork,
            updatedAt: legacySaved?.updatedAt ?? Date.now(),
          }];
        }
      }

      if (store && restored.length > 0) {
        await cacheProfileCharacters(profile, restored, store).catch(() => undefined);
        if (!restoreIsCurrent()) return;
      }
      if (!profile.guest && migration && restored.length > 0) {
        await Promise.all(
          restored.map((character) =>
            saveCharacterSlot(profile, character.id, character.artwork),
          ),
        ).catch(() => undefined);
        if (!restoreIsCurrent()) return;
      }
      const requestedId = migration?.activeId;
      const active =
        restored.find((character) => character.id === requestedId) ??
        restored[0] ??
        null;
      setSavedCharacters(restored);
      setActiveCharacterId(active?.id ?? null);
      setStageCharacterId(active?.id ?? null);
      setCharacterArtworkOwnerKey(legacyStorageId);
      setCharacterArtwork(active?.artwork ?? null);
      if (migration && profileMigrationRef.current === migration) {
        profileMigrationRef.current = null;
      }
    })()
      .catch(() => undefined)
      .finally(finishRestore);
    return () => {
      effectActive = false;
      window.clearTimeout(resetTimer);
    };
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

  const handleProfileChange = (nextProfile: VisitorProfile | null) => {
    if (libraryMutationRef.current.busy) return;
    const mutationToken = beginLibraryMutation(
      libraryMutationRef,
      nextProfile,
    );
    if (!mutationToken) return;
    pendingProfileTransitionRef.current = mutationToken;
    setCharacterLibraryBusy(true);
    if (
      profile &&
      nextProfile &&
      ((profile.guest && nextProfile.guest) ||
        (!profile.guest &&
          !nextProfile.guest &&
          profile.classId === nextProfile.classId)) &&
      profile.name !== nextProfile.name &&
      savedCharacters.length > 0
    ) {
      profileMigrationRef.current = {
        targetKey: profileCharacterLibraryPrefix(nextProfile),
        characters: savedCharacters,
        activeId: activeCharacterId,
      };
    } else {
      profileMigrationRef.current = null;
    }
    artworkGenerationRef.current += 1;
    try {
      setProfile(nextProfile);
    } catch (error) {
      pendingProfileTransitionRef.current = null;
      profileMigrationRef.current = null;
      if (finishLibraryMutation(libraryMutationRef, mutationToken)) {
        setCharacterLibraryBusy(false);
      }
      throw error;
    }
  };

  const selectCreatedCharacter = (id: string) => {
    if (libraryMutationRef.current.busy) return;
    const character = savedCharacters.find((item) => item.id === id);
    if (!character) return;
    setActiveCharacterId(character.id);
    setStageCharacterId(character.id);
    setCharacterArtworkOwnerKey(characterArtworkKey);
    setCharacterArtwork(character.artwork);
  };

  const createNewCharacter = () => {
    if (libraryMutationRef.current.busy) return;
    if (!nextAvailableCharacterSlot(savedCharacters)) return;
    setActiveCharacterId(null);
    setCharacterArtworkOwnerKey(characterArtworkKey);
    setCharacterArtwork(null);
  };

  const deleteSavedCharacter = async (id: string) => {
    if (!profile) return;
    const character = savedCharacters.find((item) => item.id === id);
    if (!character) return;
    const mutationToken = beginLibraryMutation(libraryMutationRef, profile);
    if (!mutationToken) return;
    setCharacterLibraryBusy(true);
    try {
      const store = characterStoreRef.current;
      const localDelete = store
        ? store.remove(character.storageId)
        : Promise.resolve();
      const cloudDelete = profile.guest
        ? Promise.resolve()
        : deleteCharacterSlot(profile, character.id);
      await Promise.all([localDelete, cloudDelete]);
      if (!isLibraryMutationCurrent(libraryMutationRef, mutationToken)) return;

      const remaining = savedCharacters.filter((item) => item.id !== id);
      setSavedCharacters(remaining);
      if (activeCharacterId === id) {
        const next = remaining[0] ?? null;
        setActiveCharacterId(next?.id ?? null);
        setCharacterArtworkOwnerKey(characterArtworkKey);
        setCharacterArtwork(next?.artwork ?? null);
      }
      if (stageCharacterId === id) {
        setStageCharacterId(remaining[0]?.id ?? null);
      }
    } finally {
      if (finishLibraryMutation(libraryMutationRef, mutationToken)) {
        setCharacterLibraryBusy(false);
      }
    }
  };

  const handleSendToStudio = async (dataUrl: string) => {
    if (!profile) throw new Error("먼저 이름과 학급 프로필을 설정해 주세요.");
    const mutationToken = beginLibraryMutation(libraryMutationRef, profile);
    if (!mutationToken) {
      throw new Error("다른 캐릭터 보관함 작업이 끝난 뒤 다시 시도해 주세요.");
    }
    setCharacterLibraryBusy(true);
    try {
      const slotId =
        savedCharacters.find((character) => character.id === activeCharacterId)?.id ??
        nextAvailableCharacterSlot(savedCharacters);
      if (!slotId) {
        throw new Error("캐릭터는 3개까지 저장할 수 있어요. 기존 캐릭터를 삭제해 주세요.");
      }
      const saveGeneration = artworkGenerationRef.current + 1;
      artworkGenerationRef.current = saveGeneration;
      const storageId = profileCharacterStorageId(profile, slotId);
      setCharacterArtworkOwnerKey(characterArtworkKey);
      setCharacterArtwork(dataUrl);
      const localSavePromise = characterStoreRef.current
        ?.save({
          id: storageId,
          name: `${profile.className} · ${profile.name} · ${profileCharacterName(slotId)}`,
          artwork: dataUrl,
          playback: { presetId: "idle", playbackRate: 1, loop: true },
        })
        .catch(() => null) ?? Promise.resolve(null);

      let updatedAt = Date.now();
      if (profile.guest) {
        try {
          window.localStorage.setItem(guestCharacterArtworkKey(profile), dataUrl);
        } catch {
          // The current session still keeps the artwork when storage is unavailable.
        }
        const localSaved = await localSavePromise;
        updatedAt = localSaved?.updatedAt ?? updatedAt;
      } else {
        const [localSaved, cloudSaved] = await Promise.all([
          localSavePromise,
          saveCharacterSlot(profile, slotId, dataUrl),
        ]);
        updatedAt = cloudSaved.updatedAt ?? localSaved?.updatedAt ?? updatedAt;
      }
      if (
        artworkGenerationRef.current !== saveGeneration ||
        !isLibraryMutationCurrent(libraryMutationRef, mutationToken)
      ) {
        return;
      }
      const savedCharacter: ProfileSavedCharacter = {
        id: slotId,
        storageId,
        name: profileCharacterName(slotId),
        artwork: dataUrl,
        updatedAt,
      };
      setSavedCharacters((current) =>
        [...current.filter((character) => character.id !== slotId), savedCharacter]
          .sort((left, right) => left.id.localeCompare(right.id)),
      );
      setActiveCharacterId(slotId);
      setStageCharacterId(slotId);
      setMode("studio");
    } finally {
      if (finishLibraryMutation(libraryMutationRef, mutationToken)) {
        setCharacterLibraryBusy(false);
      }
    }
  };

  const profileGateBlocking = !profile && profileReady;
  const handleCaptureReady = useCallback(
    async (capture: VrmStudioCapture) => {
      if (!profile || profile.guest) {
        setLatestCapture(null);
        return;
      }

      const mutationToken = beginLibraryMutation(libraryMutationRef, profile);
      if (!mutationToken) {
        throw new Error("다른 저장 작업이 끝난 뒤 다시 시도해 주세요.");
      }
      if (!isLibraryMutationCurrent(libraryMutationRef, mutationToken)) {
        finishLibraryMutation(libraryMutationRef, mutationToken);
        throw new Error("프로필이 변경되어 갤러리 저장을 취소했습니다.");
      }

      setCharacterLibraryBusy(true);
      setLatestCapture(capture);
      try {
        const galleryImageDataUrl = await prepareGalleryImageDataUrl(
          capture.imageDataUrl,
        );
        if (!isLibraryMutationCurrent(libraryMutationRef, mutationToken)) {
          throw new Error("프로필이 변경되어 갤러리 저장을 취소했습니다.");
        }
        await publishGalleryEntry({
          profile,
          imageDataUrl: galleryImageDataUrl,
        });
      } finally {
        setLatestCapture((current) =>
          current?.imageDataUrl === capture.imageDataUrl ? null : current,
        );
        if (finishLibraryMutation(libraryMutationRef, mutationToken)) {
          setCharacterLibraryBusy(false);
        }
      }
    },
    [profile],
  );

  const renderAdminAccessButton = (gateControl = false) => (
    <button
      ref={adminButtonRef}
      className="admin-access-button"
      type="button"
      data-active={adminMode}
      data-gate-control={gateControl}
      onClick={openAdminDialog}
      aria-haspopup="dialog"
      aria-label={adminMode ? "m042 관리자 설정 열기" : "관리자 m042 접근"}
    >
      <Settings size={18} aria-hidden="true" />
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
          <button
            className={mode === "ai" ? "is-active" : ""}
            onClick={() => setMode("ai")}
            type="button"
          >
            <Sparkles size={17} aria-hidden="true" />
            AI 이미지 생성
          </button>
        </nav>

        <div className="header-actions">
          {profile ? (
            <VisitorProfileActions
              profile={profile}
              disabled={characterLibraryBusy}
              onProfileChange={handleProfileChange}
            />
          ) : null}
          {!profileGateBlocking ? renderAdminAccessButton() : null}
        </div>
      </header>

      <section className="workspace" id="top">
        {profileReady && !profile ? (
          <ClassOnboarding
            profile={profile}
            profileReady={profileReady}
            blocking={profileGateBlocking}
            isAdmin={adminMode}
            blockingModalControl={renderAdminAccessButton(true)}
            onProfileChange={handleProfileChange}
          />
        ) : null}
        {mode === "studio" ? (
          <VrmStudio
            artwork={activeCharacterArtwork}
            createdCharacters={savedCharacters}
            activeCreatedCharacterId={stageCharacterId}
            onSelectCreatedCharacter={selectCreatedCharacter}
            onSelectVrm={() => setStageCharacterId(null)}
            onCaptureReady={handleCaptureReady}
          />
        ) : mode === "creator" ? (
          <div className="creator-workspace">
            <CharacterCreator
              initialArtwork={activeCharacterArtwork}
              initialArtworkKey={characterEditorKey}
              disabled={characterLibraryBusy}
              onSendToStudio={handleSendToStudio}
            />
            <div className="creator-library-column">
              <SavedCharacterLibrary
                characters={savedCharacters}
                activeId={activeCharacterId}
                busy={characterLibraryBusy}
                onSelect={selectCreatedCharacter}
                onCreateNew={createNewCharacter}
                onDelete={deleteSavedCharacter}
              />
            </div>
          </div>
        ) : mode === "gallery" ? (
          <Suspense
            fallback={
              <div className="gallery-loading-shell" role="status">
                온라인 갤러리를 여는 중입니다.
              </div>
            }
          >
            <OnlineGallery
              isAdmin={adminMode}
              profile={profile}
            />
          </Suspense>
        ) : (
          <Suspense
            fallback={
              <div className="gallery-loading-shell" role="status">
                AI 이미지 도구를 여는 중입니다.
              </div>
            }
          >
            <AiImageGenerator />
          </Suspense>
        )}
      </section>

      {adminDialogOpen ? (
        <div className="admin-dialog-backdrop">
          <section
            ref={adminDialogRef}
            className="admin-dialog"
            data-admin-active={adminMode}
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
                <ClassOnboarding
                  profile={profile}
                  profileReady={profileReady}
                  isAdmin
                  adminOnly
                  onProfileChange={handleProfileChange}
                />
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
