"use client";

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Camera, Code2, Images, Paintbrush } from "lucide-react";
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
const SAVED_CHARACTER_KEY = "motion-ink.saved-character.v1";
const SAVED_CHARACTER_ID = "motion-ink-latest-character";

export default function Home() {
  const [mode, setMode] = useState<WorkspaceMode>("studio");
  const [characterArtwork, setCharacterArtwork] = useState<string | null>(null);
  const [latestCapture, setLatestCapture] = useState<VrmStudioCapture | null>(null);
  const characterStoreRef = useRef<PaperDollCharacterStore | null>(null);
  const artworkGenerationRef = useRef(0);

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
        <a className="brand" href="#top" aria-label="모션잉크 홈">
          <span className="brand-mark" aria-hidden="true">
            MI
          </span>
          <span>
            <strong>MOTION INK</strong>
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

        <a
          className="source-link"
          href="https://github.com/yeemachine/kalidoface-3d"
          target="_blank"
          rel="noreferrer"
        >
          <Code2 size={18} aria-hidden="true" />
          오픈소스 기반
        </a>
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
            />
          </Suspense>
        )}
      </section>

      <footer>
        <p>
          Kalidoface 3D와 <a href="https://github.com/yemount/pose-animator" target="_blank" rel="noreferrer">Pose Animator</a>, <a href="https://github.com/facebookresearch/AnimatedDrawings" target="_blank" rel="noreferrer">Animated Drawings</a>의 리깅 아이디어를 브라우저용으로 재구성했습니다.
        </p>
        <p>카메라 사용에는 HTTPS 또는 localhost 환경이 필요합니다.</p>
      </footer>
    </main>
  );
}
