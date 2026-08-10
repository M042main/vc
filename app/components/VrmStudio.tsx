"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
  Check,
  CircleUserRound,
  Download,
  FileUp,
  Focus,
  Image as ImageIcon,
  LoaderCircle,
  LockKeyhole,
  RotateCcw,
  RotateCw,
  Sparkles,
  Upload,
  Video,
  VideoOff,
} from "lucide-react";
import type { HolisticLandmarkerResult } from "@mediapipe/tasks-vision";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { VRM } from "@pixiv/three-vrm";
import { applyVrmTracking, disposeVrm, loadVrm } from "../lib/vrmRig";
import {
  captureVrmFullBodyPng,
  downloadBlob,
} from "../lib/vrmCapture";
import { createHolisticTrackingWorker } from "../lib/holisticWorker";
import {
  PaperDollStage,
  type PaperDollStageHandle,
} from "./PaperDollStage";
import styles from "./VrmStudio.module.css";

type TrackingState = "idle" | "loading" | "running" | "error";
type ModelState = "empty" | "loading" | "ready" | "error";

type TrackerMessage =
  | { type: "READY"; delegate: "GPU" | "CPU" }
  | { type: "DELEGATE"; delegate: "CPU"; message: string }
  | {
      type: "RESULT";
      result: HolisticLandmarkerResult;
      inferenceMs: number;
    }
  | { type: "ERROR"; message: string; fatal: boolean };

const STAGE_COLORS = ["#171719", "#332d58", "#254a48", "#eee8dc"];
const MAX_VRM_SIZE = 80 * 1024 * 1024;

function createMannequin() {
  const group = new THREE.Group();
  group.name = "motion-ink-placeholder";

  const acid = new THREE.MeshStandardMaterial({
    color: 0xdfff45,
    roughness: 0.62,
    metalness: 0.04,
  });
  const violet = new THREE.MeshStandardMaterial({
    color: 0x745cff,
    roughness: 0.58,
    metalness: 0.05,
  });
  const coral = new THREE.MeshStandardMaterial({
    color: 0xff7357,
    roughness: 0.7,
  });

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 28, 20),
    acid,
  );
  head.position.y = 1.72;
  head.scale.set(0.9, 1.08, 0.9);
  group.add(head);

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.27, 0.56, 8, 18),
    violet,
  );
  body.position.y = 1.12;
  group.add(body);

  const hips = new THREE.Mesh(
    new THREE.SphereGeometry(0.27, 22, 16),
    violet,
  );
  hips.position.y = 0.72;
  hips.scale.set(1, 0.65, 0.78);
  group.add(hips);

  const limbGeometry = new THREE.CapsuleGeometry(0.075, 0.5, 6, 12);
  const legGeometry = new THREE.CapsuleGeometry(0.1, 0.62, 6, 12);

  [-1, 1].forEach((side) => {
    const arm = new THREE.Mesh(limbGeometry, coral);
    arm.position.set(0.42 * side, 1.15, 0);
    arm.rotation.z = -side * 0.28;
    group.add(arm);

    const hand = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 18, 12),
      acid,
    );
    hand.position.set(0.56 * side, 0.85, 0);
    group.add(hand);

    const leg = new THREE.Mesh(legGeometry, violet);
    leg.position.set(0.15 * side, 0.23, 0);
    leg.rotation.z = -side * 0.03;
    group.add(leg);
  });

  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  return group;
}

function fitObject(
  object: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
) {
  object.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3().setFromObject(object, true);
  if (bounds.isEmpty()) return;

  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const verticalFov = THREE.MathUtils.degToRad(camera.fov);
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
  const distance =
    Math.max(
      size.y / (2 * Math.tan(verticalFov / 2)),
      size.x / (2 * Math.tan(horizontalFov / 2)),
    ) * 1.28;

  camera.position.set(center.x, center.y + size.y * 0.025, center.z + distance);
  camera.near = Math.max(0.01, distance / 100);
  camera.far = Math.max(100, distance * 20);
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

function cleanFilename(value: string) {
  return value
    .replace(/\.vrm$/i, "")
    .replace(/[^a-zA-Z0-9가-힣_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "motion-ink-character";
}

function formatCameraError(error: unknown) {
  if (!(error instanceof DOMException)) {
    return "카메라를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.";
  }

  if (error.name === "NotAllowedError") {
    return "카메라 권한이 꺼져 있습니다. 브라우저 주소창의 권한 설정을 확인해 주세요.";
  }
  if (error.name === "NotFoundError") {
    return "사용 가능한 카메라를 찾지 못했습니다.";
  }
  if (error.name === "NotReadableError") {
    return "다른 앱이 카메라를 사용 중입니다. 해당 앱을 닫고 다시 시도해 주세요.";
  }
  if (error.name === "OverconstrainedError") {
    return "현재 카메라가 요청한 해상도를 지원하지 않습니다.";
  }
  return "카메라 연결 중 문제가 생겼습니다. 다시 시도해 주세요.";
}

export function VrmStudio({ artwork }: { artwork?: string | null }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const vrmRef = useRef<VRM | null>(null);
  const mannequinRef = useRef<THREE.Group | null>(null);
  const gridRef = useRef<THREE.Object3D | null>(null);
  const floorRef = useRef<THREE.Object3D | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const paperDollRef = useRef<PaperDollStageHandle | null>(null);
  const trackingRafRef = useRef<number | null>(null);
  const trackingRunningRef = useRef(false);
  const frameInFlightRef = useRef(false);
  const lastFrameRef = useRef(0);
  const lastStatsRef = useRef(0);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [modelState, setModelState] = useState<ModelState>("empty");
  const [trackingState, setTrackingState] = useState<TrackingState>("idle");
  const [modelName, setModelName] = useState("아직 불러온 모델이 없어요");
  const [modelSize, setModelSize] = useState("");
  const [stageColor, setStageColor] = useState(STAGE_COLORS[0]);
  const [delegate, setDelegate] = useState<"GPU" | "CPU" | "—">("—");
  const [inferenceMs, setInferenceMs] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const modelReady = modelState === "ready";
  const artworkReady = Boolean(artwork);
  const paperDollActive = artworkReady && !modelReady;
  const characterReady = modelReady || artworkReady;
  const trackingRunning = trackingState === "running";
  const displayModelName = modelReady
    ? modelName
    : artworkReady
      ? "내가 그린 캐릭터"
      : modelName;

  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = setTimeout(() => setToast(null), 3200);
  }, []);

  useEffect(() => {
    const mount = viewportRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(stageColor);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
    camera.position.set(0, 1.05, 4.1);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearAlpha(1);
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minDistance = 1;
    controls.maxDistance = 8;
    controls.target.set(0, 0.9, 0);
    controlsRef.current = controls;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x4b3d74, 2.2));
    const keyLight = new THREE.DirectionalLight(0xfff6df, 3.2);
    keyLight.position.set(3.4, 5, 4.2);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0x9684ff, 2.6);
    rimLight.position.set(-4, 2.8, -3);
    scene.add(rimLight);

    const mannequin = createMannequin();
    mannequinRef.current = mannequin;
    scene.add(mannequin);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(1.35, 64),
      new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.25 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.11;
    floor.receiveShadow = true;
    floorRef.current = floor;
    scene.add(floor);

    const grid = new THREE.GridHelper(3.2, 12, 0xffffff, 0xffffff);
    const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
    gridMaterials.forEach((material) => {
      material.transparent = true;
      material.opacity = 0.065;
    });
    grid.position.y = -0.105;
    gridRef.current = grid;
    scene.add(grid);

    const resize = () => {
      const width = Math.max(1, mount.clientWidth);
      const height = Math.max(1, mount.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    const clock = new THREE.Clock();
    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      const delta = Math.min(clock.getDelta(), 0.05);
      const elapsed = clock.elapsedTime;

      if (vrmRef.current) {
        vrmRef.current.update(delta);
      } else {
        mannequin.rotation.y = Math.sin(elapsed * 0.45) * 0.18;
        mannequin.position.y = Math.sin(elapsed * 1.2) * 0.025;
        mannequin.children[0]?.rotation.set(
          Math.sin(elapsed * 0.8) * 0.03,
          Math.sin(elapsed * 0.55) * 0.1,
          0,
        );
      }

      controls.update();
      renderer.render(scene, camera);
    };
    render();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      if (vrmRef.current) disposeVrm(vrmRef.current);
      mannequin.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        child.geometry.dispose();
        const materials = Array.isArray(child.material)
          ? child.material
          : [child.material];
        materials.forEach((material) => material.dispose());
      });
      floor.geometry.dispose();
      (floor.material as THREE.Material).dispose();
      grid.geometry.dispose();
      gridMaterials.forEach((material) => material.dispose());
      renderer.dispose();
      renderer.domElement.remove();
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
    };
    // Three scene is intentionally initialized once; stage color is synced below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (sceneRef.current) sceneRef.current.background = new THREE.Color(stageColor);
  }, [stageColor]);

  useEffect(() => {
    if (mannequinRef.current) {
      mannequinRef.current.visible = !modelReady && !artworkReady;
    }
  }, [artworkReady, modelReady]);

  const stopTracking = useCallback(() => {
    trackingRunningRef.current = false;
    frameInFlightRef.current = false;
    if (trackingRafRef.current !== null) {
      cancelAnimationFrame(trackingRafRef.current);
      trackingRafRef.current = null;
    }
    if (workerRef.current) {
      workerRef.current.postMessage({ type: "STOP" });
      workerRef.current.terminate();
      workerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setTrackingState("idle");
    setDelegate("—");
    setInferenceMs(null);
  }, []);

  useEffect(() => {
    return () => {
      stopTracking();
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, [stopTracking]);

  const handleModelFile = useCallback(
    async (file?: File) => {
      if (!file) return;
      setError(null);

      if (!file.name.toLowerCase().endsWith(".vrm")) {
        setError(".vrm 형식의 파일만 불러올 수 있습니다.");
        setModelState("error");
        return;
      }
      if (file.size > MAX_VRM_SIZE) {
        setError("VRM 파일은 80MB 이하만 사용할 수 있습니다.");
        setModelState("error");
        return;
      }

      const scene = sceneRef.current;
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (!scene || !camera || !controls) return;

      setModelState("loading");
      try {
        const loaded = await loadVrm(file, { maxBytes: MAX_VRM_SIZE });
        const previous = vrmRef.current;

        loaded.vrm.scene.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });

        scene.add(loaded.vrm.scene);
        vrmRef.current = loaded.vrm;
        mannequinRef.current!.visible = false;

        if (previous) {
          scene.remove(previous.scene);
          disposeVrm(previous);
        }

        fitObject(loaded.vrm.scene, camera, controls);
        setModelName(file.name);
        setModelSize(`${(file.size / 1024 / 1024).toFixed(1)} MB · VRM 캐릭터`);
        setModelState("ready");
        showToast("VRM을 불러왔어요. 이제 카메라를 연결해 보세요.");
      } catch (loadError) {
        setModelState(vrmRef.current ? "ready" : "error");
        setError(
          loadError instanceof Error
            ? loadError.message
            : "VRM 파일을 읽지 못했습니다.",
        );
      }
    },
    [showToast],
  );

  const runTrackingFrames = useCallback(() => {
    const tick = async (timestamp: number) => {
      if (!trackingRunningRef.current) return;
      trackingRafRef.current = requestAnimationFrame(tick);

      const video = videoRef.current;
      const worker = workerRef.current;
      if (
        !video ||
        !worker ||
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        frameInFlightRef.current ||
        timestamp - lastFrameRef.current < 66
      ) {
        return;
      }

      frameInFlightRef.current = true;
      lastFrameRef.current = timestamp;
      try {
        const bitmap = await createImageBitmap(video, {
          resizeWidth: 640,
          resizeHeight: 360,
          resizeQuality: "low",
        });
        if (!trackingRunningRef.current || !workerRef.current) {
          bitmap.close();
          frameInFlightRef.current = false;
          return;
        }
        worker.postMessage(
          { type: "FRAME", bitmap, timestamp: performance.now() },
          [bitmap],
        );
      } catch {
        frameInFlightRef.current = false;
      }
    };

    trackingRafRef.current = requestAnimationFrame(tick);
  }, []);

  const startTracking = useCallback(async () => {
    if (!vrmRef.current && !artwork) {
      showToast("먼저 VRM을 올리거나 직접 그린 캐릭터를 준비해 주세요.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("이 브라우저는 카메라 접근을 지원하지 않습니다.");
      setTrackingState("error");
      return;
    }

    setError(null);
    setTrackingState("loading");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      streamRef.current = stream;

      const video = videoRef.current;
      if (!video) throw new Error("카메라 미리보기를 준비하지 못했습니다.");
      video.srcObject = stream;
      await video.play();

      const worker = createHolisticTrackingWorker();
      workerRef.current = worker;
      trackingRunningRef.current = true;
      frameInFlightRef.current = false;
      let engineReady = false;

      worker.onmessage = (event: MessageEvent<TrackerMessage>) => {
        if (workerRef.current !== worker) return;

        const message = event.data;
        if (message.type === "READY") {
          engineReady = true;
          setDelegate(message.delegate);
          setTrackingState("running");
          showToast("카메라 트래킹을 시작했어요.");
          runTrackingFrames();
          return;
        }

        if (message.type === "DELEGATE") {
          setDelegate(message.delegate);
          setError(null);
          showToast(message.message);
          return;
        }

        if (message.type === "ERROR") {
          frameInFlightRef.current = false;
          if (message.fatal || !engineReady) {
            stopTracking();
            setTrackingState("error");
          }
          setError(`트래킹 엔진: ${message.message}`);
          return;
        }

        frameInFlightRef.current = false;
        const vrm = vrmRef.current;
        if (vrm) {
          const result = message.result;
          applyVrmTracking(vrm, {
            faceLandmarks: result.faceLandmarks?.[0],
            poseLandmarks: result.poseLandmarks?.[0],
            poseWorldLandmarks: result.poseWorldLandmarks?.[0],
            leftHandLandmarks: result.leftHandLandmarks?.[0],
            rightHandLandmarks: result.rightHandLandmarks?.[0],
          });
        } else {
          paperDollRef.current?.applyPose(message.result.poseLandmarks?.[0]);
        }

        if (performance.now() - lastStatsRef.current > 500) {
          lastStatsRef.current = performance.now();
          setInferenceMs(message.inferenceMs);
        }
      };

      worker.onerror = () => {
        if (workerRef.current !== worker) return;

        frameInFlightRef.current = false;
        stopTracking();
        setTrackingState("error");
        setError("트래킹 엔진을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.");
      };

      worker.postMessage({ type: "INIT" });
    } catch (cameraError) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setTrackingState("error");
      setError(formatCameraError(cameraError));
    }
  }, [artwork, runTrackingFrames, showToast, stopTracking]);

  const resetView = useCallback(() => {
    if (paperDollActive) {
      paperDollRef.current?.resetPose();
      return;
    }
    const object = vrmRef.current?.scene ?? mannequinRef.current;
    if (object && cameraRef.current && controlsRef.current) {
      fitObject(object, cameraRef.current, controlsRef.current);
    }
  }, [paperDollActive]);

  const rotateModel = useCallback((direction: -1 | 1) => {
    if (paperDollActive) {
      paperDollRef.current?.rotate(direction);
      return;
    }
    const object = vrmRef.current?.scene ?? mannequinRef.current;
    if (object) object.rotateY(direction * 0.28);
  }, [paperDollActive]);

  const capture = useCallback(async () => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const vrm = vrmRef.current;
    if (!paperDollActive && (!renderer || !scene || !vrm)) {
      showToast("저장할 캐릭터를 먼저 준비해 주세요.");
      return;
    }

    setIsCapturing(true);
    setError(null);
    try {
      let blob: Blob;
      if (paperDollActive) {
        const paperDoll = paperDollRef.current;
        if (!paperDoll) throw new Error("직접 그린 캐릭터를 아직 준비하고 있습니다.");
        blob = await paperDoll.capturePng(1600, 2000);
      } else {
        const helpers = [gridRef.current, floorRef.current].filter(
          (value): value is THREE.Object3D => Boolean(value),
        );
        const result = await captureVrmFullBodyPng({
          renderer: renderer!,
          scene: scene!,
          vrm: vrm!,
          helpers,
          width: 1600,
          height: 2000,
          margin: 0.14,
        });
        blob = result.blob;
      }
      const date = new Date();
      const stamp = [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
        "-",
        String(date.getHours()).padStart(2, "0"),
        String(date.getMinutes()).padStart(2, "0"),
        String(date.getSeconds()).padStart(2, "0"),
      ].join("");
      downloadBlob(blob, `${cleanFilename(displayModelName)}-fullbody-${stamp}.png`);
      showToast("캐릭터 전신 PNG를 다운로드 폴더에 저장했어요.");
    } catch (captureError) {
      setError(
        captureError instanceof Error
          ? captureError.message
          : "전신 이미지를 저장하지 못했습니다.",
      );
    } finally {
      setIsCapturing(false);
    }
  }, [displayModelName, paperDollActive, showToast]);

  return (
    <section className={styles.studio} aria-label="캐릭터 트래킹 스튜디오">
      <aside className={styles.panel} aria-label="시작 단계">
        <div className={styles.panelHeader}>
          <h2>빠른 시작</h2>
          <span className={styles.statusDot} data-ready={characterReady}>
            {characterReady ? "준비됨" : "대기 중"}
          </span>
        </div>

        <div className={styles.stepList}>
          <div
            className={styles.step}
            data-state={characterReady ? "ready" : "active"}
          >
            <div className={styles.stepTop}>
              <span className={styles.stepNumber}>{characterReady ? <Check size={11} /> : "01"}</span>
              <strong>캐릭터 준비</strong>
            </div>
            <p>VRM을 올리거나 캐릭터 만들기에서 완성한 도안을 보내세요.</p>
          </div>
          <div
            className={styles.step}
            data-state={
              trackingRunning ? "ready" : characterReady ? "active" : "waiting"
            }
          >
            <div className={styles.stepTop}>
              <span className={styles.stepNumber}>
                {trackingRunning ? <Check size={11} /> : "02"}
              </span>
              <strong>카메라 연결</strong>
            </div>
            <p>권한을 허용하면 얼굴과 전신 움직임을 기기 안에서 분석해요.</p>
          </div>
          <div
            className={styles.step}
            data-state={trackingRunning ? "active" : characterReady ? "ready" : "waiting"}
          >
            <div className={styles.stepTop}>
              <span className={styles.stepNumber}>03</span>
              <strong>포즈 저장</strong>
            </div>
            <p>원하는 순간을 누르면 전신이 투명 PNG로 자동 저장됩니다.</p>
          </div>
        </div>

        <input
          ref={fileInputRef}
          className={styles.hiddenInput}
          type="file"
          accept=".vrm,model/gltf-binary"
          onChange={(event) => handleModelFile(event.target.files?.[0])}
          aria-label="VRM 파일 선택"
        />

        <div className={styles.actionStack}>
          <button
            className={styles.primaryButton}
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={modelState === "loading"}
          >
            {modelState === "loading" ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <FileUp size={16} />
            )}
            {modelReady ? "다른 VRM 선택" : "VRM 파일 선택"}
          </button>
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={trackingRunning ? stopTracking : startTracking}
            disabled={!characterReady || trackingState === "loading" || modelState === "loading"}
          >
            {trackingState === "loading" ? (
              <LoaderCircle size={16} />
            ) : trackingRunning ? (
              <VideoOff size={16} />
            ) : (
              <Video size={16} />
            )}
            {trackingState === "loading"
              ? "엔진 준비 중"
              : trackingRunning
                ? "트래킹 멈추기"
                : "카메라 시작"}
          </button>
          <button
            className={styles.captureButton}
            type="button"
            onClick={capture}
            disabled={!characterReady || isCapturing || modelState === "loading"}
          >
            {isCapturing ? <LoaderCircle size={17} /> : <Camera size={17} />}
            {isCapturing ? "전신 맞추는 중" : "전신 PNG 자동 저장"}
          </button>
        </div>

        {error ? <div className={styles.errorBox}>{error}</div> : null}

        <div className={styles.privacyNote}>
          <LockKeyhole size={13} aria-hidden="true" />
          <span>
            카메라 영상과 캐릭터 파일은 서버로 전송하지 않습니다. 현재
            브라우저 탭 안에서만 사용됩니다.
          </span>
        </div>
      </aside>

      <div
        className={styles.stage}
        data-dragging={isDragging}
        onDragEnter={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setIsDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          handleModelFile(event.dataTransfer.files?.[0]);
        }}
      >
        <div ref={viewportRef} className={styles.viewport} aria-label="3D 캐릭터 미리보기" />
        {paperDollActive && artwork ? (
          <PaperDollStage
            ref={paperDollRef}
            artwork={artwork}
            className={styles.paperDollViewport}
          />
        ) : null}

        <div className={styles.stageBar}>
          <span className={trackingRunning ? styles.liveBadge : styles.stageBadge}>
            {trackingRunning ? "LIVE TRACKING" : "PREVIEW MODE"}
          </span>
          <span className={styles.stageBadge}>
            {paperDollActive ? "2D PAPER DOLL" : "DRAG · ZOOM · ROTATE"}
          </span>
        </div>

        {!characterReady && modelState !== "loading" ? (
          <div className={styles.emptyState}>
            <span className={styles.dropIcon}>
              <Upload size={24} aria-hidden="true" />
            </span>
            <h3>캐릭터를 무대에 올려볼까요?</h3>
            <p>
              VRM 0.x와 1.x를 지원합니다. 파일은 업로드되지 않고 이 기기에서만
              열립니다.
            </p>
            <button type="button" onClick={() => fileInputRef.current?.click()}>
              파일 찾아보기
            </button>
          </div>
        ) : null}

        {modelState === "loading" ? (
          <div className={styles.emptyState} aria-live="polite">
            <span className={styles.dropIcon}>
              <LoaderCircle size={24} aria-hidden="true" />
            </span>
            <h3>VRM 무대를 준비하고 있어요</h3>
            <p>뼈대와 재질을 확인한 뒤 캐릭터가 가장 잘 보이도록 맞춥니다.</p>
          </div>
        ) : null}

        <video ref={videoRef} playsInline muted className={styles.hiddenInput} />
        {trackingState === "loading" || trackingRunning ? (
          <div className={styles.cameraPreview}>
            <video
              playsInline
              muted
              ref={(node) => {
                if (node && streamRef.current && node.srcObject !== streamRef.current) {
                  node.srcObject = streamRef.current;
                  void node.play();
                }
              }}
            />
            <span>{trackingRunning ? "ON DEVICE" : "LOADING"}</span>
          </div>
        ) : null}

        <div className={styles.stageTools} aria-label="캐릭터 화면 도구">
          <button
            className={styles.iconButton}
            type="button"
            onClick={() => rotateModel(-1)}
            aria-label="캐릭터 왼쪽으로 회전"
          >
            <RotateCcw size={16} />
          </button>
          <button
            className={styles.iconButton}
            type="button"
            onClick={resetView}
            aria-label="전신 화면 맞춤"
          >
            <Focus size={16} />
          </button>
          <button
            className={styles.iconButton}
            type="button"
            onClick={() => rotateModel(1)}
            aria-label="캐릭터 오른쪽으로 회전"
          >
            <RotateCw size={16} />
          </button>
          <span className={styles.stageToolDivider} />
          <button
            className={styles.iconButton}
            type="button"
            onClick={capture}
            disabled={!characterReady || isCapturing || modelState === "loading"}
            aria-label="전신 PNG 저장"
          >
            <Download size={16} />
          </button>
        </div>

        {toast ? (
          <div className={styles.toast} role="status">
            <Sparkles size={14} aria-hidden="true" />
            {toast}
          </div>
        ) : null}
      </div>

      <aside className={styles.panel} aria-label="무대 설정">
        <div className={styles.panelHeader}>
          <h3>무대 설정</h3>
          <CircleUserRound size={17} aria-hidden="true" />
        </div>

        <div className={styles.modelCard}>
          <div className={styles.modelThumb}>
            {paperDollActive && artwork ? (
              // The paper-doll artwork is generated locally by CharacterCreator.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={artwork} alt="직접 그린 캐릭터 도안" />
            ) : (
              <ImageIcon size={27} aria-hidden="true" />
            )}
          </div>
          <div className={styles.modelInfo}>
            <strong>{displayModelName}</strong>
            <span>
              {modelReady
                ? modelSize
                : artworkReady
                  ? "내가 그린 도안 · 트래킹 준비됨"
                  : "VRM을 선택해 주세요"}
            </span>
          </div>
        </div>

        <span className={styles.sectionLabel}>Stage background</span>
        <div className={styles.swatches} aria-label="무대 배경색">
          {STAGE_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={styles.swatch}
              style={{ backgroundColor: color }}
              data-selected={stageColor === color}
              onClick={() => setStageColor(color)}
              aria-label={`배경색 ${color}`}
            />
          ))}
        </div>

        <span className={styles.sectionLabel}>Tracking health</span>
        <div className={styles.metrics}>
          <div className={styles.metric}>
            <span>ENGINE</span>
            <strong>{trackingRunning ? delegate : "OFF"}</strong>
          </div>
          <div className={styles.metric}>
            <span>INFERENCE</span>
            <strong>{inferenceMs ? `${Math.round(inferenceMs)} ms` : "—"}</strong>
          </div>
        </div>

        <span className={styles.sectionLabel}>Export</span>
        <div className={styles.metrics}>
          <div className={styles.metric}>
            <span>SIZE</span>
            <strong>1600 × 2000</strong>
          </div>
          <div className={styles.metric}>
            <span>FORMAT</span>
            <strong>PNG · 투명</strong>
          </div>
        </div>
        <p className={styles.exportNote}>
          저장할 때 현재 포즈의 실제 범위를 다시 계산해 머리부터 발끝까지 자동으로
          화면 안에 맞춥니다.
        </p>
      </aside>
    </section>
  );
}
