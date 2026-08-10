"use client";

import { useState } from "react";
import { Camera, Code2, Paintbrush, ShieldCheck } from "lucide-react";
import { CharacterCreator } from "./components/CharacterCreator";
import { VrmStudio } from "./components/VrmStudio";

type WorkspaceMode = "studio" | "creator";

export default function Home() {
  const [mode, setMode] = useState<WorkspaceMode>("studio");
  const [characterArtwork, setCharacterArtwork] = useState<string | null>(null);

  const handleSendToStudio = (dataUrl: string) => {
    setCharacterArtwork(dataUrl);
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
          <VrmStudio artwork={characterArtwork} />
        ) : (
          <CharacterCreator onSendToStudio={handleSendToStudio} />
        )}
      </section>

      <section className="trust-strip" aria-label="서비스 특징">
        <div>
          <span className="trust-icon">
            <ShieldCheck size={20} aria-hidden="true" />
          </span>
          <p>
            <strong>영상은 기기 안에서만</strong>
            카메라 프레임은 서버에 업로드하지 않습니다.
          </p>
        </div>
        <div>
          <span className="trust-number">01</span>
          <p>
            <strong>캐릭터 준비</strong>
            VRM 또는 직접 그린 도안
          </p>
        </div>
        <div>
          <span className="trust-number">02</span>
          <p>
            <strong>카메라 트래킹</strong>
            얼굴·상체·손·다리 인식
          </p>
        </div>
        <div>
          <span className="trust-number">03</span>
          <p>
            <strong>전신 PNG 저장</strong>
            포즈에 맞춰 자동 프레이밍
          </p>
        </div>
      </section>

      <footer>
        <p>
          Kalidoface 3D의 아이디어를 바탕으로 최신 MediaPipe Tasks와
          three-vrm으로 새롭게 구성했습니다.
        </p>
        <p>카메라 사용에는 HTTPS 또는 localhost 환경이 필요합니다.</p>
      </footer>
    </main>
  );
}
