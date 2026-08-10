"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
  Check,
  CircleUserRound,
  Download,
  FileUp,
  Film,
  Focus,
  Image as ImageIcon,
  LoaderCircle,
  LockKeyhole,
  Pause,
  Play,
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
  getPaperDollMotionPreset,
  type PaperDollMotionPresetId,
} from "../lib/paperDollMotion";
import {
  DOLL_MOTION_PRESETS,
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
  const trackingSessionRef = useRef(0);
  const paperDollActiveRef = useRef(false);
  const stageVisibleRef = useRef(true);
  const frameInFlightRef = useRef(false);
  const modelLoadSessionRef = useRef(0);
  const lastFrameRef = useRef(0);
  const lastStatsRef = useRef(0);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingSessionRef = useRef(0);
  const activeRecordingRef = useRef<{
    session: number;
    recorder: MediaRecorder;
    stream: MediaStream;
    timer: number;
    releaseDelay: () => void;
  } | null>(null);

  const [modelState, setModelState] = useState<ModelState>("empty");
  const [trackingState, setTrackingState] = useState<TrackingState>("idle");
  const [modelName, setModelName] = useState("아직 불러온 모델이 없어요");
  const [modelSize, setModelSize] = useState("");
  const [stageColor, setStageColor] = useState(STAGE_COLORS[0]);
  const [delegate, setDelegate] = useState<"GPU" | "CPU" | "—">("—");
  const [inferenceMs, setInferenceMs] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [selectedMotion, setSelectedMotion] =
    useState<PaperDollMotionPresetId>("idle");
  const [animationPlaying, setAnimationPlaying] = useState(false);
  const [animationSpeed, setAnimationSpeed] = useState(1);
  const [preferVrm, setPreferVrm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const artworkReady = Boolean(artwork);
  const paperDollActive = artworkReady && !preferVrm;
  const modelReady = modelState === "ready" && !paperDollActive;
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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setClearAlpha(1);
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = true;
    controls.screenSpacePanning = true;
    controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
    controls.minDistance = 1;
    controls.maxDistance = 8;
    controls.target.set(0, 0.9, 0);
    controlsRef.current = controls;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x4b3d74, 2.2));
    const keyLight = new THREE.DirectionalLight(0xfff6df, 3.2);
    keyLight.position.set(3.4, 5, 4.2);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(512, 512);
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

    const visibilityObserver = new IntersectionObserver(
      ([entry]) => {
        stageVisibleRef.current = entry?.isIntersecting ?? true;
      },
      { rootMargin: "120px" },
    );
    visibilityObserver.observe(mount);

    const clock = new THREE.Clock();
    let raf = 0;
    let lastRenderAt = 0;
    const render = (timestamp = 0) => {
      raf = requestAnimationFrame(render);
      if (
        document.hidden ||
        paperDollActiveRef.current ||
        !stageVisibleRef.current ||
        timestamp - lastRenderAt < 33
      ) {
        return;
      }
      lastRenderAt = timestamp;
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
      visibilityObserver.disconnect();
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
    if (vrmRef.current) vrmRef.current.scene.visible = modelReady;
  }, [artworkReady, modelReady]);

  useEffect(() => {
    paperDollActiveRef.current = paperDollActive;
  }, [paperDollActive]);

  const cancelRecording = useCallback(() => {
    recordingSessionRef.current += 1;
    const active = activeRecordingRef.current;
    activeRecordingRef.current = null;
    if (!active) return;
    window.clearTimeout(active.timer);
    active.releaseDelay();
    if (active.recorder.state !== "inactive") {
      try {
        active.recorder.stop();
      } catch {
        // The browser may already be finalizing the recorder.
      }
    }
    active.stream.getTracks().forEach((track) => track.stop());
  }, []);

  const stopTracking = useCallback(() => {
    trackingSessionRef.current += 1;
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
      modelLoadSessionRef.current += 1;
      cancelRecording();
      stopTracking();
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, [cancelRecording, stopTracking]);

  const handleModelFile = useCallback(
    async (file?: File) => {
      if (!file) return;
      if (isRecording) {
        showToast("애니메이션 저장이 끝난 뒤 VRM을 선택해 주세요.");
        return;
      }
      setError(null);

      if (!file.name.toLowerCase().endsWith(".vrm")) {
        setError(".vrm 형식의 파일만 불러올 수 있습니다.");
        setModelState(vrmRef.current ? "ready" : "error");
        return;
      }
      if (file.size > MAX_VRM_SIZE) {
        setError("VRM 파일은 80MB 이하만 사용할 수 있습니다.");
        setModelState(vrmRef.current ? "ready" : "error");
        return;
      }

      stopTracking();
      paperDollRef.current?.pauseAnimation();
      setAnimationPlaying(false);
      const loadSession = ++modelLoadSessionRef.current;

      const scene = sceneRef.current;
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (!scene || !camera || !controls) return;

      setModelState("loading");
      try {
        const loaded = await loadVrm(file, { maxBytes: MAX_VRM_SIZE });
        if (modelLoadSessionRef.current !== loadSession) {
          disposeVrm(loaded.vrm);
          return;
        }
        const previous = vrmRef.current;

        loaded.vrm.scene.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });

        scene.add(loaded.vrm.scene);
        vrmRef.current = loaded.vrm;
        setPreferVrm(true);
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
        if (modelLoadSessionRef.current !== loadSession) return;
        setModelState(vrmRef.current ? "ready" : "error");
        setError(
          loadError instanceof Error
            ? loadError.message
            : "VRM 파일을 읽지 못했습니다.",
        );
      }
    },
    [isRecording, showToast, stopTracking],
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
        !stageVisibleRef.current ||
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
          resizeWidth: 480,
          resizeHeight: 270,
          resizeQuality: "low",
        });
        if (!trackingRunningRef.current || workerRef.current !== worker) {
          bitmap.close();
          if (workerRef.current === worker) frameInFlightRef.current = false;
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
    if (isRecording) {
      showToast("애니메이션 저장이 끝난 뒤 카메라를 시작해 주세요.");
      return;
    }
    if (!characterReady) {
      showToast("먼저 VRM을 올리거나 직접 그린 캐릭터를 준비해 주세요.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("이 브라우저는 카메라 접근을 지원하지 않습니다.");
      setTrackingState("error");
      return;
    }

    setError(null);
    paperDollRef.current?.pauseAnimation();
    setAnimationPlaying(false);
    setTrackingState("loading");
    const session = ++trackingSessionRef.current;
    let sessionStream: MediaStream | null = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 360 },
          aspectRatio: { ideal: 16 / 9 },
          frameRate: { ideal: 24, max: 30 },
        },
      });
      sessionStream = stream;
      if (trackingSessionRef.current !== session) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;

      const video = videoRef.current;
      if (!video) throw new Error("카메라 미리보기를 준비하지 못했습니다.");
      video.srcObject = stream;
      await video.play();
      if (trackingSessionRef.current !== session) {
        stream.getTracks().forEach((track) => track.stop());
        if (video.srcObject === stream) video.srcObject = null;
        if (streamRef.current === stream) streamRef.current = null;
        return;
      }

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
        const result = message.result;
        const vrm = vrmRef.current;
        if (paperDollActiveRef.current) {
          paperDollRef.current?.applyTracking(
            result.poseLandmarks?.[0],
            result.faceLandmarks?.[0],
          );
        } else if (vrm) {
          applyVrmTracking(vrm, {
            faceLandmarks: result.faceLandmarks?.[0],
            poseLandmarks: result.poseLandmarks?.[0],
            poseWorldLandmarks: result.poseWorldLandmarks?.[0],
            leftHandLandmarks: result.leftHandLandmarks?.[0],
            rightHandLandmarks: result.rightHandLandmarks?.[0],
          });
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
      sessionStream?.getTracks().forEach((track) => track.stop());
      if (videoRef.current?.srcObject === sessionStream) {
        videoRef.current.srcObject = null;
      }
      if (streamRef.current === sessionStream) streamRef.current = null;
      if (trackingSessionRef.current !== session) return;
      setTrackingState("error");
      setError(formatCameraError(cameraError));
    }
  }, [characterReady, isRecording, runTrackingFrames, showToast, stopTracking]);

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

  const selectMotionPreset = useCallback(
    (preset: PaperDollMotionPresetId) => {
      if (!paperDollActive) return;
      if (trackingState !== "idle") stopTracking();
      setSelectedMotion(preset);
      paperDollRef.current?.setAnimationSpeed(animationSpeed);
      paperDollRef.current?.playPreset(preset);
      setAnimationPlaying(true);
      showToast(`${getPaperDollMotionPreset(preset).name} 애니메이션을 재생합니다.`);
    },
    [animationSpeed, paperDollActive, showToast, stopTracking, trackingState],
  );

  const toggleAnimation = useCallback(() => {
    if (!paperDollActive) return;
    if (animationPlaying) {
      paperDollRef.current?.pauseAnimation();
      setAnimationPlaying(false);
      return;
    }
    if (trackingState !== "idle") stopTracking();
    paperDollRef.current?.setAnimationSpeed(animationSpeed);
    paperDollRef.current?.playPreset(selectedMotion);
    setAnimationPlaying(true);
  }, [
    animationPlaying,
    animationSpeed,
    paperDollActive,
    selectedMotion,
    stopTracking,
    trackingState,
  ]);

  const changeAnimationSpeed = useCallback((speed: number) => {
    setAnimationSpeed(speed);
    paperDollRef.current?.setAnimationSpeed(speed);
  }, []);

  const recordAnimation = useCallback(async () => {
    if (!paperDollActive || isRecording) return;
    const paperDoll = paperDollRef.current;
    const canvas = paperDoll?.getCanvas();
    if (!paperDoll || !canvas) {
      showToast("애니메이션 캔버스를 아직 준비하고 있습니다.");
      return;
    }
    if (typeof MediaRecorder === "undefined" || !canvas.captureStream) {
      setError("이 브라우저는 애니메이션 WebM 저장을 지원하지 않습니다.");
      return;
    }

    if (trackingState !== "idle") stopTracking();
    const session = ++recordingSessionRef.current;
    setIsRecording(true);
    setError(null);
    let canvasStream: MediaStream | null = null;
    try {
      paperDoll.setAnimationSpeed(animationSpeed);
      paperDoll.playPreset(selectedMotion);
      setAnimationPlaying(true);

      canvasStream = canvas.captureStream(30);
      const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(
        (candidate) => MediaRecorder.isTypeSupported(candidate),
      );
      if (!mimeType) {
        throw new Error("이 브라우저는 WebM 애니메이션 저장을 지원하지 않습니다.");
      }
      const recorder = new MediaRecorder(
        canvasStream,
        { mimeType, videoBitsPerSecond: 4_000_000 },
      );
      const chunks: Blob[] = [];
      let recorderFailure: Error | null = null;
      let releaseDelay = () => undefined;
      const completed = new Promise<Blob>((resolve) => {
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunks.push(event.data);
        };
        recorder.onerror = () => {
          recorderFailure = new Error("애니메이션 녹화 중 문제가 생겼습니다.");
          releaseDelay();
        };
        recorder.onstop = () =>
          resolve(new Blob(chunks, { type: mimeType }));
      });

      const clip = getPaperDollMotionPreset(selectedMotion);
      const delay = new Promise<void>((resolve) => {
        releaseDelay = resolve;
      });
      const timer = window.setTimeout(
        releaseDelay,
        clip.durationMs / animationSpeed + 180,
      );
      activeRecordingRef.current = {
        session,
        recorder,
        stream: canvasStream,
        timer,
        releaseDelay,
      };
      recorder.start(120);
      await delay;
      if (recordingSessionRef.current !== session) return;
      if (recorder.state !== "inactive") recorder.stop();
      const blob = await completed;
      if (recordingSessionRef.current !== session) return;
      if (recorderFailure) throw recorderFailure;
      if (blob.size === 0) throw new Error("저장된 애니메이션이 비어 있습니다.");
      downloadBlob(
        blob,
        `${cleanFilename(displayModelName)}-${selectedMotion}-animation.webm`,
      );
      showToast("캐릭터 애니메이션 WebM을 기기에 저장했어요.");
    } catch (recordingError) {
      if (recordingSessionRef.current === session) {
        setError(
          recordingError instanceof Error
            ? recordingError.message
            : "애니메이션을 저장하지 못했습니다.",
        );
      }
    } finally {
      const active = activeRecordingRef.current;
      if (active?.session === session) {
        window.clearTimeout(active.timer);
        active.stream.getTracks().forEach((track) => track.stop());
        activeRecordingRef.current = null;
      } else {
        canvasStream?.getTracks().forEach((track) => track.stop());
      }
      if (recordingSessionRef.current === session) {
        paperDoll.pauseAnimation();
        setAnimationPlaying(false);
        setIsRecording(false);
      }
    }
  }, [
    animationSpeed,
    displayModelName,
    isRecording,
    paperDollActive,
    selectedMotion,
    showToast,
    stopTracking,
    trackingState,
  ]);

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
          samples: 2,
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
              <strong>포즈·애니메이션 저장</strong>
            </div>
            <p>현재 포즈는 PNG로, 선택한 움직임은 WebM으로 저장할 수 있어요.</p>
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
            disabled={modelState === "loading" || isRecording}
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
            disabled={
              !characterReady ||
              trackingState === "loading" ||
              modelState === "loading" ||
              isRecording
            }
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
            disabled={!characterReady || isCapturing || isRecording || modelState === "loading"}
          >
            {isCapturing ? <LoaderCircle size={17} /> : <Camera size={17} />}
            {isCapturing ? "전신 맞추는 중" : "전신 PNG 자동 저장"}
          </button>
        </div>

        {paperDollActive ? (
          <section className={styles.animationLab} aria-label="캐릭터 애니메이션 만들기">
            <div className={styles.animationHeading}>
              <span>ANIMATION LAB</span>
              <strong>저장한 그림을 움직여 보세요</strong>
            </div>
            <div className={styles.motionGrid}>
              {DOLL_MOTION_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  data-selected={selectedMotion === preset.id}
                  aria-pressed={selectedMotion === preset.id}
                  onClick={() => selectMotionPreset(preset.id)}
                  disabled={isRecording || trackingState === "loading"}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className={styles.motionControls}>
              <button
                type="button"
                className={styles.playButton}
                onClick={toggleAnimation}
                disabled={isRecording || trackingState === "loading"}
              >
                {animationPlaying ? <Pause size={14} /> : <Play size={14} />}
                {animationPlaying ? "일시정지" : "애니메이션 재생"}
              </button>
              <label className={styles.speedControl}>
                <span>속도</span>
                <select
                  value={animationSpeed}
                  onChange={(event) => changeAnimationSpeed(Number(event.target.value))}
                  disabled={isRecording}
                  aria-label="애니메이션 재생 속도"
                >
                  <option value={0.75}>0.75×</option>
                  <option value={1}>1×</option>
                  <option value={1.25}>1.25×</option>
                  <option value={1.5}>1.5×</option>
                </select>
              </label>
            </div>
            <button
              type="button"
              className={styles.recordButton}
              onClick={recordAnimation}
              disabled={isRecording || trackingState === "loading"}
            >
              {isRecording ? <LoaderCircle size={15} /> : <Film size={15} />}
              {isRecording ? "애니메이션 녹화 중" : "애니메이션 WebM 저장"}
            </button>
          </section>
        ) : null}

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
        style={paperDollActive ? { background: stageColor } : undefined}
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
          if (isRecording) return;
          handleModelFile(event.dataTransfer.files?.[0]);
        }}
      >
        <div
          ref={viewportRef}
          className={styles.viewport}
          data-hidden={paperDollActive}
          aria-hidden={paperDollActive}
          aria-label="3D 캐릭터 미리보기"
        />
        {paperDollActive && artwork ? (
          <PaperDollStage
            ref={paperDollRef}
            artwork={artwork}
            className={styles.paperDollViewport}
            onAnimationPlayingChange={setAnimationPlaying}
          />
        ) : null}

        <div className={styles.stageBar}>
          <span
            className={trackingRunning || animationPlaying ? styles.liveBadge : styles.stageBadge}
          >
            {trackingRunning
              ? "LIVE TRACKING"
              : animationPlaying
                ? "ANIMATION PLAYING"
                : "PREVIEW MODE"}
          </span>
          <span className={styles.stageBadge}>
            {paperDollActive
              ? "2D JOINT PUPPET · MIDDLE PAN"
              : "ROTATE · MIDDLE PAN · WHEEL ZOOM"}
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

        <div
          className={styles.cameraPreview}
          data-visible={trackingState === "loading" || trackingRunning}
          aria-hidden={trackingState !== "loading" && !trackingRunning}
        >
          <video ref={videoRef} playsInline muted />
          <span>{trackingRunning ? "ON DEVICE" : "LOADING"}</span>
        </div>

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
            disabled={!characterReady || isCapturing || isRecording || modelState === "loading"}
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
            <strong>{paperDollActive ? "PNG · WEBM" : "PNG · 투명"}</strong>
          </div>
        </div>
        <p className={styles.exportNote}>
          {paperDollActive
            ? "현재 포즈는 투명 PNG로, 선택한 동작은 브라우저에서 바로 WebM으로 저장합니다."
            : "저장할 때 현재 포즈의 실제 범위를 다시 계산해 머리부터 발끝까지 자동으로 화면 안에 맞춥니다."}
        </p>
      </aside>
    </section>
  );
}
