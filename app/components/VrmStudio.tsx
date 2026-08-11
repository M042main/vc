"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Camera,
  Check,
  CircleUserRound,
  Download,
  FileUp,
  Film,
  Focus,
  Image as ImageIcon,
  ImagePlus,
  LoaderCircle,
  LockOpen,
  LockKeyhole,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  Sparkles,
  Trash2,
  Upload,
  Video,
  VideoOff,
  X,
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
  MAX_PERSISTED_VRM_BYTES,
  MAX_STAGE_BACKGROUND_BYTES,
  STAGE_BACKGROUND_TYPES,
  clearPersistedStageBackground,
  clearPersistedVrmFile,
  isSupportedStageBackground,
  loadPersistedStudio,
  savePersistedStageBackground,
  savePersistedVrmFile,
  saveStudioSettings,
  type StudioBackgroundFit,
} from "../lib/studioPersistence";
import {
  getPaperDollMotionPreset,
} from "../lib/paperDollMotion";
import {
  getVrmMotionPreset,
  VrmLegRotationLock,
  VrmMotionPlayer,
  type VrmMotionPresetId,
} from "../lib/vrmMotion";
import {
  DOLL_MOTION_PRESETS,
  PaperDollStage,
  type PaperDollStageHandle,
} from "./PaperDollStage";
import {
  TrackingLandmarkOverlay,
  type TrackingLandmarkOverlayHandle,
} from "./TrackingLandmarkOverlay";
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

export const CHROMA_KEY_GREEN = "#00ff00";
const STAGE_COLORS = [
  { value: "#171719", label: "차콜" },
  { value: "#332d58", label: "바이올렛" },
  { value: "#254a48", label: "딥 그린" },
  { value: "#eee8dc", label: "오프화이트" },
  { value: CHROMA_KEY_GREEN, label: "크로마키 초록" },
] as const;
type StageColor = (typeof STAGE_COLORS)[number]["value"];
const MAX_VRM_SIZE = MAX_PERSISTED_VRM_BYTES;
const MAX_STAGE_BACKGROUND_DIMENSION = 8192;
const TRACKING_INPUT_MAX_WIDTH = 480;
const TRACKING_INPUT_MAX_HEIGHT = 360;

function trackingInputDimensions(aspectRatio: number) {
  const aspect =
    Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 16 / 9;
  if (aspect >= TRACKING_INPUT_MAX_WIDTH / TRACKING_INPUT_MAX_HEIGHT) {
    return {
      width: TRACKING_INPUT_MAX_WIDTH,
      height: Math.max(1, Math.round(TRACKING_INPUT_MAX_WIDTH / aspect)),
    };
  }
  return {
    width: Math.max(1, Math.round(TRACKING_INPUT_MAX_HEIGHT * aspect)),
    height: TRACKING_INPUT_MAX_HEIGHT,
  };
}

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
    .slice(0, 60) || "virtual-creator-character";
}

function pngBlobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error("PNG 이미지를 온라인 갤러리용으로 준비하지 못했습니다."));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("PNG 이미지 변환 결과가 올바르지 않습니다."));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(blob);
  });
}

function decodeStageBackground(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    const release = () => URL.revokeObjectURL(objectUrl);
    image.decoding = "async";
    image.onload = () => {
      release();
      if (
        image.naturalWidth < 1 ||
        image.naturalHeight < 1 ||
        image.naturalWidth > MAX_STAGE_BACKGROUND_DIMENSION ||
        image.naturalHeight > MAX_STAGE_BACKGROUND_DIMENSION
      ) {
        reject(new Error("배경 이미지는 가로·세로 8192px 이하만 사용할 수 있습니다."));
        return;
      }
      resolve(image);
    };
    image.onerror = () => {
      release();
      reject(new Error("배경 이미지를 읽지 못했습니다."));
    };
    image.src = objectUrl;
  });
}

function drawStageBackground(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  fit: StudioBackgroundFit,
  stageColor: string,
  width: number,
  height: number,
) {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.fillStyle = stageColor;
  context.fillRect(0, 0, width, height);
  const scale =
    fit === "cover"
      ? Math.max(width / image.naturalWidth, height / image.naturalHeight)
      : Math.min(width / image.naturalWidth, height / image.naturalHeight);
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  context.drawImage(
    image,
    (width - drawWidth) / 2,
    (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error("배경을 포함한 PNG를 만들지 못했습니다."));
    }, "image/png");
  });
}

async function includeStageBackgroundInCapture(
  foregroundBlob: Blob,
  stageColor: string,
  backgroundImage: HTMLImageElement | null,
  backgroundFit: StudioBackgroundFit,
  width = 1600,
  height = 2000,
) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("PNG 합성용 캔버스를 준비하지 못했습니다.");

  if (backgroundImage) {
    drawStageBackground(
      canvas,
      backgroundImage,
      backgroundFit,
      stageColor,
      width,
      height,
    );
  } else {
    context.fillStyle = stageColor;
    context.fillRect(0, 0, width, height);
  }

  const foreground = await createImageBitmap(foregroundBlob);
  try {
    context.drawImage(foreground, 0, 0, width, height);
  } finally {
    foreground.close();
  }
  return canvasToPngBlob(canvas);
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

export type VrmStudioCapture = {
  imageDataUrl: string;
  fileName: string;
};

export type VrmStudioCreatedCharacter = {
  id: string;
  name: string;
  artwork: string;
};

export interface VrmStudioProps {
  /** Legacy single-character input. Prefer createdCharacters for new callers. */
  artwork?: string | null;
  /** Up to three locally created paper-doll characters shown in the stage picker. */
  createdCharacters?: readonly VrmStudioCreatedCharacter[];
  /** A string selects a drawing; null selects VRM; undefined leaves selection local. */
  activeCreatedCharacterId?: string | null;
  onSelectCreatedCharacter?: (id: string) => void;
  onSelectVrm?: () => void;
  onCaptureReady?: (capture: VrmStudioCapture) => void | Promise<void>;
}

const MAX_CREATED_CHARACTER_OPTIONS = 3;
const LEGACY_ARTWORK_ID = "__legacy-vrm-studio-artwork__";

export function VrmStudio({
  artwork,
  createdCharacters,
  activeCreatedCharacterId,
  onSelectCreatedCharacter,
  onSelectVrm,
  onCaptureReady,
}: VrmStudioProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const backgroundInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pipVideoRef = useRef<HTMLVideoElement>(null);
  const pipOwnedVideoRef = useRef<HTMLVideoElement | null>(null);
  const pipStreamRef = useRef<MediaStream | null>(null);
  const pipActiveRef = useRef(false);
  const pipSessionRef = useRef(0);
  const pipTransitionRef = useRef(false);
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
  const trackingOverlayRef = useRef<TrackingLandmarkOverlayHandle | null>(null);
  const vrmMotionPlayerRef = useRef<VrmMotionPlayer | null>(null);
  const vrmLegLockRef = useRef<VrmLegRotationLock | null>(null);
  const trackingRafRef = useRef<number | null>(null);
  const trackingRunningRef = useRef(false);
  const trackingSessionRef = useRef(0);
  const paperDollActiveRef = useRef(false);
  const legsLockedRef = useRef(false);
  const stageVisibleRef = useRef(true);
  const frameInFlightRef = useRef(false);
  const modelLoadSessionRef = useRef(0);
  const modelInteractionRef = useRef(0);
  const characterSelectionSessionRef = useRef(0);
  const controlledCreatedCharacterIdRef =
    useRef(activeCreatedCharacterId);
  const restoreModelLoaderRef = useRef<
    (file?: File, options?: { restored?: boolean }) => Promise<void>
  >(async () => undefined);
  const backgroundLoadSessionRef = useRef(0);
  const settingsInteractionRef = useRef(0);
  const stageColorRef = useRef<StageColor>(STAGE_COLORS[0].value);
  const stageBackgroundImageRef = useRef<HTMLImageElement | null>(null);
  const stageBackgroundFitRef = useRef<StudioBackgroundFit>("cover");
  const syncThreeBackgroundRef = useRef<() => void>(() => undefined);
  const lastFrameRef = useRef(0);
  const cameraAspectRatioRef = useRef(16 / 9);
  const lastStatsRef = useRef(0);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureBusyRef = useRef(false);
  const captureDialogRef = useRef<HTMLDivElement>(null);
  const captureDialogFirstChoiceRef = useRef<HTMLButtonElement>(null);
  const captureDialogTriggerRef = useRef<HTMLButtonElement | null>(null);
  const recordingSessionRef = useRef(0);
  const recordingBusyRef = useRef(false);
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
  const [stageColor, setStageColor] = useState<StageColor>(STAGE_COLORS[0].value);
  const [stageBackgroundImage, setStageBackgroundImage] =
    useState<HTMLImageElement | null>(null);
  const [stageBackgroundName, setStageBackgroundName] = useState("");
  const [stageBackgroundFit, setStageBackgroundFit] =
    useState<StudioBackgroundFit>("cover");
  const [persistenceReady, setPersistenceReady] = useState(false);
  const [delegate, setDelegate] = useState<"GPU" | "CPU" | "—">("—");
  const [inferenceMs, setInferenceMs] = useState<number | null>(null);
  const [cameraAspectRatio, setCameraAspectRatio] = useState(16 / 9);
  const [isDragging, setIsDragging] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [captureDialogOpen, setCaptureDialogOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [pipActive, setPipActive] = useState(false);
  const [pipTransitioning, setPipTransitioning] = useState(false);
  const [legsLocked, setLegsLocked] = useState(false);
  const [selectedMotion, setSelectedMotion] =
    useState<VrmMotionPresetId>("idle");
  const [animationPlaying, setAnimationPlaying] = useState(false);
  const [animationSpeed, setAnimationSpeed] = useState(1);
  const [preferVrm, setPreferVrm] = useState(false);
  const [selectedCreatedCharacterId, setSelectedCreatedCharacterId] =
    useState<string | null>(activeCreatedCharacterId ?? null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const selectableCreatedCharacters = useMemo(() => {
    const seen = new Set<string>();
    const options: VrmStudioCreatedCharacter[] = [];
    for (const character of createdCharacters ?? []) {
      const id = character.id;
      if (!id.trim() || !character.artwork || seen.has(id)) continue;
      seen.add(id);
      options.push({
        id,
        name: character.name.trim() || `그림 캐릭터 ${options.length + 1}`,
        artwork: character.artwork,
      });
      if (options.length === MAX_CREATED_CHARACTER_OPTIONS) break;
    }
    if (options.length > 0 || !artwork) return options;
    return [
      {
        id: LEGACY_ARTWORK_ID,
        name: "내가 그린 캐릭터",
        artwork,
      },
    ];
  }, [artwork, createdCharacters]);
  const effectiveCreatedCharacterId =
    activeCreatedCharacterId === undefined
      ? selectedCreatedCharacterId
      : activeCreatedCharacterId;
  const vrmPreferred =
    activeCreatedCharacterId === undefined
      ? preferVrm
      : activeCreatedCharacterId === null;
  const explicitlySelectedCreatedCharacter = effectiveCreatedCharacterId
    ? selectableCreatedCharacters.find(
        ({ id }) => id === effectiveCreatedCharacterId,
      ) ?? null
    : null;
  const selectedCreatedCharacter =
    explicitlySelectedCreatedCharacter ??
    (effectiveCreatedCharacterId === null && vrmPreferred
      ? null
      : selectableCreatedCharacters[0] ?? null);
  const activeArtwork = selectedCreatedCharacter?.artwork ?? null;
  const artworkReady = Boolean(activeArtwork);
  const paperDollActive = artworkReady && !vrmPreferred;
  const modelReady = modelState === "ready" && !paperDollActive;
  const vrmAvailable = modelState === "ready";
  const characterReady = modelReady || paperDollActive;
  const trackingRunning = trackingState === "running";
  const displayModelName = modelReady
    ? modelName
    : paperDollActive
      ? selectedCreatedCharacter?.name ?? "내가 그린 캐릭터"
      : modelName;

  useEffect(() => {
    controlledCreatedCharacterIdRef.current = activeCreatedCharacterId;
    characterSelectionSessionRef.current += 1;
  }, [activeCreatedCharacterId]);

  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const restoreCaptureDialogFocus = useCallback(() => {
    const trigger = captureDialogTriggerRef.current;
    captureDialogTriggerRef.current = null;
    window.requestAnimationFrame(() => trigger?.focus());
  }, []);

  const closeCaptureDialog = useCallback(() => {
    if (captureBusyRef.current) return;
    setCaptureDialogOpen(false);
    restoreCaptureDialogFocus();
  }, [restoreCaptureDialogFocus]);

  const openCaptureDialog = useCallback((trigger: HTMLButtonElement) => {
    if (captureBusyRef.current) return;
    captureDialogTriggerRef.current = trigger;
    setCaptureDialogOpen(true);
  }, []);

  useEffect(() => {
    if (!captureDialogOpen) return;
    const frame = window.requestAnimationFrame(() =>
      captureDialogFirstChoiceRef.current?.focus(),
    );
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !captureBusyRef.current) {
        event.preventDefault();
        closeCaptureDialog();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        captureDialogRef.current?.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        ) ?? [],
      );
      if (focusable.length === 0) return;
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
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [captureDialogOpen, closeCaptureDialog]);

  const releasePipResources = useCallback(
    (
      expectedStream: MediaStream | null = pipStreamRef.current,
      expectedVideo: HTMLVideoElement | null =
        pipOwnedVideoRef.current ?? pipVideoRef.current,
    ) => {
      expectedStream?.getTracks().forEach((track) => track.stop());
      if (
        expectedVideo &&
        (!expectedStream || expectedVideo.srcObject === expectedStream)
      ) {
        expectedVideo.pause();
        expectedVideo.srcObject = null;
      }
      if (!expectedStream || pipStreamRef.current === expectedStream) {
        pipStreamRef.current = null;
        pipActiveRef.current = false;
      }
    },
    [],
  );

  const cleanupStagePictureInPicture = useCallback(() => {
    pipSessionRef.current += 1;
    const video = pipOwnedVideoRef.current ?? pipVideoRef.current;
    const stream = pipStreamRef.current;
    if (document.pictureInPictureElement === video) {
      void document.exitPictureInPicture().catch(() => undefined);
    }
    releasePipResources(stream, video);
    pipTransitionRef.current = false;
  }, [releasePipResources]);

  const exitStagePictureInPicture = useCallback(async () => {
    pipTransitionRef.current = true;
    setPipTransitioning(true);
    const session = ++pipSessionRef.current;
    const video = pipOwnedVideoRef.current ?? pipVideoRef.current;
    const stream = pipStreamRef.current;
    try {
      if (document.pictureInPictureElement === video) {
        try {
          await document.exitPictureInPicture();
        } catch {
          // The browser may already be closing the floating window.
        }
      }
    } finally {
      releasePipResources(stream, video);
      if (pipSessionRef.current === session) {
        pipTransitionRef.current = false;
        setPipTransitioning(false);
        setPipActive(false);
      }
    }
  }, [releasePipResources]);

  const enterStagePictureInPicture = useCallback(async () => {
    if (pipTransitionRef.current) return;
    if (pipActiveRef.current) {
      await exitStagePictureInPicture();
      return;
    }
    if (isRecording) {
      showToast("저장이나 모델 준비가 끝난 뒤 PiP를 시작해 주세요.");
      return;
    }
    if (recordingBusyRef.current) return;
    if (modelState === "loading") {
      showToast("모델 준비가 끝난 뒤 PiP를 시작해 주세요.");
      return;
    }
    const canvas = paperDollActive
      ? paperDollRef.current?.getCanvas()
      : modelReady
        ? rendererRef.current?.domElement
        : null;
    const video = pipVideoRef.current;
    if (
      !canvas ||
      !video ||
      typeof canvas.captureStream !== "function" ||
      typeof video.requestPictureInPicture !== "function" ||
      !document.pictureInPictureEnabled
    ) {
      setError("이 브라우저는 캐릭터 PiP 모드를 지원하지 않습니다.");
      return;
    }

    setError(null);
    pipTransitionRef.current = true;
    setPipTransitioning(true);
    const session = ++pipSessionRef.current;
    let sessionStream: MediaStream | null = null;
    let handleLeave: (() => void) | null = null;
    try {
      const stream = canvas.captureStream(30);
      sessionStream = stream;
      pipStreamRef.current = stream;
      video.srcObject = stream;
      await video.play();
      if (pipSessionRef.current !== session) {
        releasePipResources(stream, video);
        return;
      }
      handleLeave = () => {
        if (pipSessionRef.current !== session) return;
        pipSessionRef.current += 1;
        releasePipResources(stream, video);
        pipTransitionRef.current = false;
        setPipTransitioning(false);
        setPipActive(false);
      };
      video.addEventListener("leavepictureinpicture", handleLeave, {
        once: true,
      });
      await video.requestPictureInPicture();
      if (pipSessionRef.current !== session) {
        if (document.pictureInPictureElement === video) {
          await document.exitPictureInPicture().catch(() => undefined);
        }
        releasePipResources(stream, video);
        return;
      }
      pipActiveRef.current = true;
      setPipActive(true);
      showToast("캐릭터를 작은 PiP 창으로 띄웠어요.");
    } catch {
      if (handleLeave) {
        video.removeEventListener("leavepictureinpicture", handleLeave);
      }
      releasePipResources(sessionStream, video);
      if (pipSessionRef.current === session) {
        setPipActive(false);
        setError("캐릭터 PiP 창을 열지 못했습니다. 브라우저 설정을 확인해 주세요.");
      }
    } finally {
      if (pipSessionRef.current === session) {
        pipTransitionRef.current = false;
        setPipTransitioning(false);
      }
    }
  }, [
    exitStagePictureInPicture,
    isRecording,
    modelReady,
    modelState,
    paperDollActive,
    releasePipResources,
    showToast,
  ]);

  useEffect(() => {
    pipOwnedVideoRef.current = pipVideoRef.current;
  }, []);

  useEffect(() => {
    const mount = viewportRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(stageColorRef.current);
    sceneRef.current = scene;

    const backgroundCanvas = document.createElement("canvas");
    const backgroundTexture = new THREE.CanvasTexture(backgroundCanvas);
    backgroundTexture.colorSpace = THREE.SRGBColorSpace;
    backgroundTexture.generateMipmaps = false;
    backgroundTexture.minFilter = THREE.LinearFilter;
    backgroundTexture.magFilter = THREE.LinearFilter;

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

    const syncStageBackground = () => {
      const image = stageBackgroundImageRef.current;
      if (!image) {
        scene.background = new THREE.Color(stageColorRef.current);
        return;
      }
      const pixelRatio = Math.min(window.devicePixelRatio, 1.5);
      const sourceWidth = Math.max(1, Math.round(mount.clientWidth * pixelRatio));
      const sourceHeight = Math.max(1, Math.round(mount.clientHeight * pixelRatio));
      const scale = Math.min(1, 1920 / Math.max(sourceWidth, sourceHeight));
      drawStageBackground(
        backgroundCanvas,
        image,
        stageBackgroundFitRef.current,
        stageColorRef.current,
        Math.max(1, Math.round(sourceWidth * scale)),
        Math.max(1, Math.round(sourceHeight * scale)),
      );
      backgroundTexture.needsUpdate = true;
      scene.background = backgroundTexture;
    };
    syncThreeBackgroundRef.current = syncStageBackground;

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
      syncStageBackground();
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
        (document.hidden && !pipActiveRef.current && !recordingBusyRef.current) ||
        paperDollActiveRef.current ||
        (!stageVisibleRef.current &&
          !pipActiveRef.current &&
          !recordingBusyRef.current) ||
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
      vrmMotionPlayerRef.current?.dispose();
      vrmMotionPlayerRef.current = null;
      vrmLegLockRef.current?.dispose();
      vrmLegLockRef.current = null;
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
      backgroundTexture.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
      syncThreeBackgroundRef.current = () => undefined;
    };
  }, []);

  useEffect(() => {
    if (sceneRef.current && !stageBackgroundImage) {
      sceneRef.current.background = new THREE.Color(stageColor);
    }
    stageColorRef.current = stageColor;
    stageBackgroundImageRef.current = stageBackgroundImage;
    stageBackgroundFitRef.current = stageBackgroundFit;
    syncThreeBackgroundRef.current();
    const showStageHelpers =
      !stageBackgroundImage && stageColor !== CHROMA_KEY_GREEN;
    if (gridRef.current) gridRef.current.visible = showStageHelpers;
    if (floorRef.current) floorRef.current.visible = showStageHelpers;
  }, [stageBackgroundFit, stageBackgroundImage, stageColor]);

  useEffect(() => {
    if (mannequinRef.current) {
      mannequinRef.current.visible = !modelReady && !paperDollActive;
    }
    if (vrmRef.current) vrmRef.current.scene.visible = modelReady;
  }, [modelReady, paperDollActive]);

  useEffect(() => {
    paperDollActiveRef.current = paperDollActive;
  }, [paperDollActive]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const syncCameraAspectRatio = () => {
      if (!video.videoWidth || !video.videoHeight) return;
      const nextAspectRatio = video.videoWidth / video.videoHeight;
      cameraAspectRatioRef.current = nextAspectRatio;
      setCameraAspectRatio(nextAspectRatio);
    };
    video.addEventListener("loadedmetadata", syncCameraAspectRatio);
    video.addEventListener("resize", syncCameraAspectRatio);
    return () => {
      video.removeEventListener("loadedmetadata", syncCameraAspectRatio);
      video.removeEventListener("resize", syncCameraAspectRatio);
    };
  }, []);

  useEffect(() => {
    legsLockedRef.current = legsLocked;
    if (paperDollActive) paperDollRef.current?.setLegsLocked(legsLocked);
  }, [legsLocked, paperDollActive]);

  const cancelRecording = useCallback(() => {
    recordingSessionRef.current += 1;
    recordingBusyRef.current = false;
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
    trackingOverlayRef.current?.clear();
    setTrackingState("idle");
    setDelegate("—");
    setInferenceMs(null);
  }, []);

  const stopVrmAnimation = useCallback(() => {
    vrmMotionPlayerRef.current?.stop();
    setAnimationPlaying(false);
  }, []);

  const playVrmMotion = useCallback(
    (preset: VrmMotionPresetId) => {
      if (trackingState !== "idle") stopTracking();
      const player = vrmMotionPlayerRef.current;
      if (!player) return;
      player.play(preset, {
        playbackRate: animationSpeed,
        loop: getVrmMotionPreset(preset).loop,
      });
      setAnimationPlaying(true);
    },
    [animationSpeed, stopTracking, trackingState],
  );

  useEffect(() => {
    return () => {
      modelLoadSessionRef.current += 1;
      cancelRecording();
      stopTracking();
      stopVrmAnimation();
      cleanupStagePictureInPicture();
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, [
    cancelRecording,
    cleanupStagePictureInPicture,
    stopTracking,
    stopVrmAnimation,
  ]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden || !recordingBusyRef.current) return;
      cancelRecording();
      paperDollRef.current?.pauseAnimation();
      stopVrmAnimation();
      setIsRecording(false);
      setAnimationPlaying(false);
      setError("애니메이션 녹화 중에는 이 탭을 화면에 유지해 주세요.");
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [cancelRecording, stopVrmAnimation]);

  const handleBackgroundFile = useCallback(
    async (file?: File) => {
      if (!file) return;
      settingsInteractionRef.current += 1;
      const backgroundSession = ++backgroundLoadSessionRef.current;
      setError(null);

      if (!isSupportedStageBackground(file)) {
        const allowed = STAGE_BACKGROUND_TYPES.map((type) =>
          type.replace("image/", "").replace("jpeg", "JPEG").toUpperCase(),
        ).join(" · ");
        setError(
          file.size > MAX_STAGE_BACKGROUND_BYTES
            ? "배경 이미지는 12MB 이하만 사용할 수 있습니다."
            : `배경 이미지는 ${allowed} 형식만 사용할 수 있습니다.`,
        );
        return;
      }

      try {
        const image = await decodeStageBackground(file);
        if (backgroundLoadSessionRef.current !== backgroundSession) return;
        setStageBackgroundImage(image);
        setStageBackgroundName(file.name);
        const persisted = await savePersistedStageBackground(file);
        if (backgroundLoadSessionRef.current !== backgroundSession) return;
        showToast(
          persisted.ok
            ? "사진 배경을 무대에 적용하고 이 기기에 저장했어요."
            : "사진 배경은 적용했지만 저장 공간 제한으로 새로고침 뒤에는 복원되지 않을 수 있어요.",
        );
      } catch (backgroundError) {
        if (backgroundLoadSessionRef.current !== backgroundSession) return;
        setError(
          backgroundError instanceof Error
            ? backgroundError.message
            : "배경 이미지를 적용하지 못했습니다.",
        );
      }
    },
    [showToast],
  );

  const selectStageColor = useCallback((color: StageColor) => {
    settingsInteractionRef.current += 1;
    backgroundLoadSessionRef.current += 1;
    setStageColor(color);
    setStageBackgroundImage(null);
    setStageBackgroundName("");
    void clearPersistedStageBackground();
  }, []);

  const removeStageBackgroundImage = useCallback(() => {
    settingsInteractionRef.current += 1;
    backgroundLoadSessionRef.current += 1;
    setStageBackgroundImage(null);
    setStageBackgroundName("");
    void clearPersistedStageBackground();
    showToast("사진 배경을 지우고 단색 배경으로 돌아왔어요.");
  }, [showToast]);

  const changeStageBackgroundFit = useCallback(
    (fit: StudioBackgroundFit) => {
      settingsInteractionRef.current += 1;
      setStageBackgroundFit(fit);
    },
    [],
  );

  const handleModelFile = useCallback(
    async (file?: File, options: { restored?: boolean } = {}) => {
      if (!file) return;
      if (!options.restored) modelInteractionRef.current += 1;
      if (isRecording) {
        showToast("애니메이션 저장이 끝난 뒤 VRM을 선택해 주세요.");
        return;
      }
      if (recordingBusyRef.current) return;
      await exitStagePictureInPicture();
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
      stopVrmAnimation();
      paperDollRef.current?.pauseAnimation();
      setAnimationPlaying(false);
      const selectionSession = options.restored
        ? characterSelectionSessionRef.current
        : ++characterSelectionSessionRef.current;
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
        vrmMotionPlayerRef.current?.dispose();
        vrmLegLockRef.current?.dispose();
        const motionPlayer = new VrmMotionPlayer(loaded.vrm, {
          fps: 30,
          updateHumanoid: false,
          onStateChange: (snapshot) =>
            setAnimationPlaying(snapshot.state === "playing"),
        });
        const legLock = new VrmLegRotationLock(loaded.vrm, {
          updateHumanoid: false,
        });
        if (legsLockedRef.current) {
          legLock.lock({ mode: "rest", updateHumanoid: false });
        }
        vrmMotionPlayerRef.current = motionPlayer;
        vrmLegLockRef.current = legLock;
        vrmRef.current = loaded.vrm;
        const selectionIsCurrent =
          characterSelectionSessionRef.current === selectionSession;
        const controlledCharacterId =
          controlledCreatedCharacterIdRef.current;
        const shouldActivateVrm =
          selectionIsCurrent &&
          (!options.restored || controlledCharacterId == null);
        if (shouldActivateVrm) {
          setSelectedCreatedCharacterId(null);
          setPreferVrm(true);
          if (!options.restored) onSelectVrm?.();
        }
        mannequinRef.current!.visible = false;

        if (previous) {
          scene.remove(previous.scene);
          disposeVrm(previous);
        }

        fitObject(loaded.vrm.scene, camera, controls);
        setModelName(file.name);
        setModelSize(`${(file.size / 1024 / 1024).toFixed(1)} MB · VRM 캐릭터`);
        setModelState("ready");
        if (options.restored) {
          showToast(
            shouldActivateVrm
              ? "이 기기에 저장한 VRM과 무대 설정을 복원했어요."
              : "저장한 VRM을 복원했어요. 캐릭터 선택에서 언제든 전환할 수 있어요.",
          );
        } else {
          showToast("VRM을 불러왔어요. 이제 카메라를 연결해 보세요.");
          void savePersistedVrmFile(file).then((persisted) => {
            if (modelLoadSessionRef.current !== loadSession || persisted.ok) return;
            showToast(
              "VRM은 열었지만 저장 공간 제한으로 새로고침 뒤에는 복원되지 않을 수 있어요.",
            );
          });
        }
      } catch (loadError) {
        if (modelLoadSessionRef.current !== loadSession) return;
        if (options.restored) void clearPersistedVrmFile();
        setModelState(vrmRef.current ? "ready" : "error");
        setError(
          loadError instanceof Error
            ? loadError.message
            : "VRM 파일을 읽지 못했습니다.",
        );
      }
    },
    [
      exitStagePictureInPicture,
      isRecording,
      onSelectVrm,
      showToast,
      stopTracking,
      stopVrmAnimation,
    ],
  );

  const selectCreatedCharacter = useCallback(
    async (character: VrmStudioCreatedCharacter) => {
      if (
        paperDollActive &&
        selectedCreatedCharacter?.id === character.id
      ) return;
      if (isRecording || recordingBusyRef.current) {
        showToast("애니메이션 저장이 끝난 뒤 캐릭터를 바꿔 주세요.");
        return;
      }
      const selectionSession = ++characterSelectionSessionRef.current;
      await exitStagePictureInPicture();
      if (characterSelectionSessionRef.current !== selectionSession) return;

      stopVrmAnimation();
      paperDollRef.current?.pauseAnimation();
      setAnimationPlaying(false);
      setSelectedCreatedCharacterId(character.id);
      setPreferVrm(false);
      if (character.id !== LEGACY_ARTWORK_ID) {
        onSelectCreatedCharacter?.(character.id);
      }
      showToast(`${character.name} 캐릭터로 전환했어요.`);
    },
    [
      exitStagePictureInPicture,
      isRecording,
      onSelectCreatedCharacter,
      paperDollActive,
      selectedCreatedCharacter?.id,
      showToast,
      stopVrmAnimation,
    ],
  );

  const selectVrmCharacter = useCallback(async () => {
    if (modelReady) return;
    if (!vrmAvailable || !vrmRef.current) {
      showToast("먼저 VRM 파일을 선택해 주세요.");
      return;
    }
    if (isRecording || recordingBusyRef.current) {
      showToast("애니메이션 저장이 끝난 뒤 캐릭터를 바꿔 주세요.");
      return;
    }
    const selectionSession = ++characterSelectionSessionRef.current;
    await exitStagePictureInPicture();
    if (characterSelectionSessionRef.current !== selectionSession) return;

    paperDollRef.current?.pauseAnimation();
    stopVrmAnimation();
    setAnimationPlaying(false);
    setSelectedCreatedCharacterId(null);
    setPreferVrm(true);
    onSelectVrm?.();
    showToast(`${modelName} VRM으로 전환했어요.`);
  }, [
    exitStagePictureInPicture,
    isRecording,
    modelName,
    modelReady,
    onSelectVrm,
    showToast,
    stopVrmAnimation,
    vrmAvailable,
  ]);

  useEffect(() => {
    restoreModelLoaderRef.current = handleModelFile;
  }, [handleModelFile]);

  useEffect(() => {
    let active = true;
    const modelInteraction = modelInteractionRef.current;
    const backgroundInteraction = backgroundLoadSessionRef.current;
    const settingsInteraction = settingsInteractionRef.current;

    void (async () => {
      const snapshot = await loadPersistedStudio();
      if (!active) return;

      if (
        snapshot.settings &&
        settingsInteractionRef.current === settingsInteraction
      ) {
        const restoredColor = STAGE_COLORS.find(
          ({ value }) => value === snapshot.settings?.stageColor,
        )?.value;
        if (restoredColor) setStageColor(restoredColor);
        setStageBackgroundFit(snapshot.settings.backgroundFit);
        setSelectedMotion(snapshot.settings.selectedMotion);
        setAnimationSpeed(snapshot.settings.animationSpeed);
        legsLockedRef.current = snapshot.settings.legsLocked;
        setLegsLocked(snapshot.settings.legsLocked);
      }

      const restoredBackground = snapshot.background;
      if (
        restoredBackground &&
        snapshot.settings?.backgroundMode !== "solid" &&
        backgroundLoadSessionRef.current === backgroundInteraction
      ) {
        try {
          const image = await decodeStageBackground(restoredBackground.blob);
          if (!active) return;
          if (backgroundLoadSessionRef.current === backgroundInteraction) {
            setStageBackgroundImage(image);
            setStageBackgroundName(restoredBackground.name);
          }
        } catch {
          if (
            active &&
            backgroundLoadSessionRef.current === backgroundInteraction
          ) {
            void clearPersistedStageBackground();
          }
        }
      }

      if (!active) return;
      setPersistenceReady(true);

      if (
        snapshot.vrm &&
        modelInteractionRef.current === modelInteraction
      ) {
        await restoreModelLoaderRef.current(snapshot.vrm.file, { restored: true });
      }
    })().catch(() => {
      if (!active) return;
      setPersistenceReady(true);
    });

    return () => {
      active = false;
      backgroundLoadSessionRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!persistenceReady) return;
    void saveStudioSettings({
      stageColor,
      backgroundMode: stageBackgroundImage ? "image" : "solid",
      backgroundFit: stageBackgroundFit,
      selectedMotion,
      animationSpeed,
      legsLocked,
    });
  }, [
    animationSpeed,
    legsLocked,
    persistenceReady,
    selectedMotion,
    stageBackgroundFit,
    stageBackgroundImage,
    stageColor,
  ]);

  const runTrackingFrames = useCallback(() => {
    const tick = async (timestamp: number) => {
      if (!trackingRunningRef.current) return;
      trackingRafRef.current = requestAnimationFrame(tick);

      const video = videoRef.current;
      const worker = workerRef.current;
      if (
        !video ||
        !worker ||
        (!stageVisibleRef.current && !pipActiveRef.current) ||
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        frameInFlightRef.current ||
        timestamp - lastFrameRef.current < 66
      ) {
        return;
      }

      frameInFlightRef.current = true;
      lastFrameRef.current = timestamp;
      try {
        const inputSize = trackingInputDimensions(cameraAspectRatioRef.current);
        const bitmap = await createImageBitmap(video, {
          resizeWidth: inputSize.width,
          resizeHeight: inputSize.height,
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
    if (recordingBusyRef.current) return;
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
    stopVrmAnimation();
    trackingOverlayRef.current?.clear();
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
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        const aspectRatio = video.videoWidth / video.videoHeight;
        cameraAspectRatioRef.current = aspectRatio;
        setCameraAspectRatio(aspectRatio);
      }
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
        trackingOverlayRef.current?.draw({
          poseLandmarks: result.poseLandmarks?.[0],
          faceLandmarks: result.faceLandmarks?.[0],
          leftHandLandmarks: result.leftHandLandmarks?.[0],
          rightHandLandmarks: result.rightHandLandmarks?.[0],
        });
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
          }, {
            enableLegs: !legsLockedRef.current,
            applyHipsPosition: !legsLockedRef.current,
            applyHipsRotation: !legsLockedRef.current,
          });
          if (legsLockedRef.current) vrmLegLockRef.current?.enforce();
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
  }, [
    characterReady,
    isRecording,
    runTrackingFrames,
    showToast,
    stopTracking,
    stopVrmAnimation,
  ]);

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
    (preset: VrmMotionPresetId) => {
      if (!paperDollActive && !modelReady) return;
      settingsInteractionRef.current += 1;
      if (trackingState !== "idle") stopTracking();
      setSelectedMotion(preset);
      if (paperDollActive) {
        paperDollRef.current?.setAnimationSpeed(animationSpeed);
        paperDollRef.current?.playPreset(preset);
        setAnimationPlaying(true);
      } else {
        playVrmMotion(preset);
      }
      const motionName = paperDollActive
        ? getPaperDollMotionPreset(preset).name
        : getVrmMotionPreset(preset).label;
      showToast(`${motionName} 애니메이션을 재생합니다.`);
    },
    [
      animationSpeed,
      modelReady,
      paperDollActive,
      playVrmMotion,
      showToast,
      stopTracking,
      trackingState,
    ],
  );

  const toggleAnimation = useCallback(() => {
    if (!paperDollActive && !modelReady) return;
    if (animationPlaying) {
      if (paperDollActive) paperDollRef.current?.pauseAnimation();
      else vrmMotionPlayerRef.current?.pause();
      setAnimationPlaying(false);
      return;
    }
    if (trackingState !== "idle") stopTracking();
    if (paperDollActive) {
      paperDollRef.current?.setAnimationSpeed(animationSpeed);
      paperDollRef.current?.playPreset(selectedMotion);
      setAnimationPlaying(true);
    } else {
      const player = vrmMotionPlayerRef.current;
      if (player?.getSnapshot().state === "paused") player.resume();
      else playVrmMotion(selectedMotion);
    }
  }, [
    animationPlaying,
    animationSpeed,
    modelReady,
    paperDollActive,
    playVrmMotion,
    selectedMotion,
    stopTracking,
    trackingState,
  ]);

  const changeAnimationSpeed = useCallback((speed: number) => {
    settingsInteractionRef.current += 1;
    setAnimationSpeed(speed);
    paperDollRef.current?.setAnimationSpeed(speed);
    vrmMotionPlayerRef.current?.setPlaybackRate(speed);
  }, []);

  const toggleLegLock = useCallback(() => {
    settingsInteractionRef.current += 1;
    const nextLocked = !legsLockedRef.current;
    legsLockedRef.current = nextLocked;
    setLegsLocked(nextLocked);
    paperDollRef.current?.setLegsLocked(nextLocked);
    const legLock = vrmLegLockRef.current;
    if (nextLocked) {
      legLock?.lock({ mode: "current", updateHumanoid: false });
      showToast("다리를 현재 자세에 고정했어요. 상체만 자유롭게 추적합니다.");
    } else {
      legLock?.unlock({ restore: false });
      showToast("다리 고정을 풀었어요. 전신 움직임을 다시 추적합니다.");
    }
  }, [showToast]);

  const recordAnimation = useCallback(async () => {
    if (
      (!paperDollActive && !modelReady) ||
      isRecording ||
      recordingBusyRef.current
    ) {
      return;
    }
    recordingBusyRef.current = true;
    const session = ++recordingSessionRef.current;
    setIsRecording(true);
    setError(null);
    let paperDoll: PaperDollStageHandle | null = null;
    let vrmMotion: VrmMotionPlayer | null = null;
    let canvasStream: MediaStream | null = null;
    try {
      if (trackingState !== "idle") stopTracking();
      await exitStagePictureInPicture();
      if (recordingSessionRef.current !== session) return;

      paperDoll = paperDollRef.current;
      vrmMotion = vrmMotionPlayerRef.current;
      const canvas = paperDollActive
        ? paperDoll?.getCanvas()
        : rendererRef.current?.domElement;
      if (!canvas || (paperDollActive ? !paperDoll : !vrmMotion)) {
        throw new Error("애니메이션 캔버스를 아직 준비하고 있습니다.");
      }
      if (typeof MediaRecorder === "undefined" || !canvas.captureStream) {
        throw new Error("이 브라우저는 애니메이션 WebM 저장을 지원하지 않습니다.");
      }

      if (paperDollActive) {
        paperDoll!.setAnimationSpeed(animationSpeed);
        paperDoll!.playPreset(selectedMotion);
      } else {
        vrmMotion!.play(selectedMotion, {
          playbackRate: animationSpeed,
          loop: getVrmMotionPreset(selectedMotion).loop,
        });
      }
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
      let releaseDelay: () => void = () => undefined;
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

      const clip = paperDollActive
        ? getPaperDollMotionPreset(selectedMotion)
        : getVrmMotionPreset(selectedMotion);
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
        if (paperDollActive) paperDoll?.pauseAnimation();
        else stopVrmAnimation();
        recordingBusyRef.current = false;
        setAnimationPlaying(false);
        setIsRecording(false);
      }
    }
  }, [
    animationSpeed,
    displayModelName,
    exitStagePictureInPicture,
    isRecording,
    modelReady,
    paperDollActive,
    selectedMotion,
    showToast,
    stopTracking,
    stopVrmAnimation,
    trackingState,
  ]);

  const capture = useCallback(async (includeBackground: boolean) => {
    if (captureBusyRef.current) return;
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const vrm = vrmRef.current;
    if (!paperDollActive && (!renderer || !scene || !vrm)) {
      showToast("저장할 캐릭터를 먼저 준비해 주세요.");
      return;
    }
    const captureBackground = {
      color: stageColorRef.current,
      image: stageBackgroundImageRef.current,
      fit: stageBackgroundFitRef.current,
    };

    captureBusyRef.current = true;
    setCaptureDialogOpen(false);
    restoreCaptureDialogFocus();
    setIsCapturing(true);
    setError(null);
    let downloaded = false;
    try {
      let transparentBlob: Blob;
      if (paperDollActive) {
        const paperDoll = paperDollRef.current;
        if (!paperDoll) throw new Error("직접 그린 캐릭터를 아직 준비하고 있습니다.");
        transparentBlob = await paperDoll.capturePng(1600, 2000);
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
        transparentBlob = result.blob;
      }
      const blob = includeBackground
        ? await includeStageBackgroundInCapture(
            transparentBlob,
            captureBackground.color,
            captureBackground.image,
            captureBackground.fit,
          )
        : transparentBlob;
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
      const fileName = `${cleanFilename(displayModelName)}-fullbody${
        includeBackground ? "-background" : ""
      }-${stamp}.png`;
      downloadBlob(blob, fileName);
      downloaded = true;
      if (onCaptureReady) {
        const imageDataUrl = await pngBlobToDataUrl(blob);
        await onCaptureReady({ imageDataUrl, fileName });
      }
      showToast("캐릭터 전신 PNG를 저장했어요.");
    } catch (captureError) {
      const message =
        captureError instanceof Error
          ? captureError.message
          : "전신 이미지를 저장하지 못했습니다.";
      setError(
        downloaded
          ? `PNG 다운로드는 완료됐지만 온라인 갤러리 등록에 실패했습니다. ${message}`
          : message,
      );
    } finally {
      captureBusyRef.current = false;
      setIsCapturing(false);
    }
  }, [
    displayModelName,
    onCaptureReady,
    paperDollActive,
    restoreCaptureDialogFocus,
    showToast,
  ]);

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
        <input
          ref={backgroundInputRef}
          className={styles.hiddenInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(event) => {
            void handleBackgroundFile(event.target.files?.[0]);
            event.currentTarget.value = "";
          }}
          aria-label="무대 사진 배경 선택"
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
            {vrmAvailable ? "다른 VRM 선택" : "VRM 파일 선택"}
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
            onClick={(event) => openCaptureDialog(event.currentTarget)}
            disabled={!characterReady || isCapturing || isRecording || modelState === "loading"}
            aria-haspopup="dialog"
          >
            {isCapturing ? <LoaderCircle size={17} /> : <Camera size={17} />}
            {isCapturing ? "전신 맞추는 중" : "전신 PNG 자동 저장"}
          </button>
        </div>

        {paperDollActive || modelReady ? (
          <section className={styles.animationLab} aria-label="캐릭터 애니메이션 만들기">
            <div className={styles.animationHeading}>
              <span>ANIMATION LAB</span>
              <strong>
                {paperDollActive
                  ? "저장한 그림을 움직여 보세요"
                  : "VRM에 프리셋 움직임을 더해 보세요"}
              </strong>
            </div>
            <div className={styles.motionGrid}>
              {DOLL_MOTION_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className={styles.motionPresetButton}
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
            카메라 영상은 서버로 전송하지 않습니다. VRM과 사진 배경은 다음
            방문에 복원할 수 있도록 이 기기의 브라우저에만 저장됩니다.
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
        {paperDollActive && activeArtwork ? (
          <PaperDollStage
            ref={paperDollRef}
            artwork={activeArtwork}
            backgroundColor={stageColor}
            backgroundImage={stageBackgroundImage}
            backgroundFit={stageBackgroundFit}
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
              : pipActive
                ? "PICTURE IN PICTURE"
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
          <TrackingLandmarkOverlay
            ref={trackingOverlayRef}
            mirror
            sourceAspectRatio={cameraAspectRatio}
            fit="cover"
            hidden={trackingState !== "loading" && !trackingRunning}
          />
          <span>{trackingRunning ? "ON DEVICE" : "LOADING"}</span>
        </div>

        <video
          ref={pipVideoRef}
          className={styles.pipSourceVideo}
          playsInline
          muted
          aria-hidden="true"
        />

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
            onClick={enterStagePictureInPicture}
            disabled={
              !characterReady ||
              isRecording ||
              pipTransitioning ||
              modelState === "loading"
            }
            data-active={pipActive}
            aria-pressed={pipActive}
            aria-busy={pipTransitioning}
            aria-label={
              pipTransitioning
                ? "캐릭터 PiP 전환 중"
                : pipActive
                  ? "캐릭터 PiP 닫기"
                  : "캐릭터 PiP 열기"
            }
            title={
              pipTransitioning
                ? "캐릭터 PiP 전환 중"
                : pipActive
                  ? "캐릭터 PiP 닫기"
                  : "캐릭터 PiP 열기"
            }
          >
            {pipTransitioning ? (
              <LoaderCircle size={17} className="spin" />
            ) : (
              <PictureInPicture2 size={17} />
            )}
          </button>
          <button
            className={styles.iconButton}
            type="button"
            onClick={(event) => openCaptureDialog(event.currentTarget)}
            disabled={!characterReady || isCapturing || isRecording || modelState === "loading"}
            aria-label="전신 PNG 저장"
            aria-haspopup="dialog"
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

        <span className={styles.sectionLabel}>캐릭터 선택</span>
        {vrmAvailable || selectableCreatedCharacters.length > 0 ? (
          <div className={styles.characterChoices} role="group" aria-label="무대 캐릭터 선택">
            {vrmAvailable ? (
              <button
                type="button"
                className={styles.characterChoice}
                data-selected={modelReady}
                aria-pressed={modelReady}
                aria-label={`${modelName} VRM 선택`}
                disabled={isRecording}
                onClick={() => void selectVrmCharacter()}
              >
                <span className={styles.characterChoiceThumb} data-vrm="true">
                  <CircleUserRound size={25} aria-hidden="true" />
                  <small>VRM</small>
                </span>
                <span className={styles.characterChoiceInfo}>
                  <strong>{modelName}</strong>
                  <small>{modelSize || "3D 캐릭터"}</small>
                </span>
              </button>
            ) : null}
            {selectableCreatedCharacters.map((character) => {
              const selected =
                paperDollActive &&
                selectedCreatedCharacter?.id === character.id;
              return (
                <button
                  key={character.id}
                  type="button"
                  className={styles.characterChoice}
                  data-selected={selected}
                  aria-pressed={selected}
                  aria-label={`${character.name} 그림 캐릭터 선택`}
                  disabled={isRecording || modelState === "loading"}
                  onClick={() => void selectCreatedCharacter(character)}
                >
                  <span className={styles.characterChoiceThumb}>
                    {/* CharacterCreator exports a local transparent PNG Data URL. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={character.artwork} alt="" />
                  </span>
                  <span className={styles.characterChoiceInfo}>
                    <strong>{character.name}</strong>
                    <small>그림 캐릭터</small>
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className={styles.modelCard}>
            <div className={styles.modelThumb}>
              <ImageIcon size={27} aria-hidden="true" />
            </div>
            <div className={styles.modelInfo}>
              <strong>{displayModelName}</strong>
              <span>VRM을 올리거나 그림 캐릭터를 만들어 주세요</span>
            </div>
          </div>
        )}

        <span className={styles.sectionLabel}>Stage background</span>
        <div className={styles.swatches} aria-label="무대 배경색">
          {STAGE_COLORS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={styles.swatch}
              style={{ backgroundColor: value }}
              data-selected={!stageBackgroundImage && stageColor === value}
              data-chroma={value === CHROMA_KEY_GREEN}
              aria-pressed={!stageBackgroundImage && stageColor === value}
              onClick={() => selectStageColor(value)}
              aria-label={`배경색 ${label}`}
              title={label}
            />
          ))}
        </div>

        <div
          className={styles.backgroundImagePanel}
          data-active={Boolean(stageBackgroundImage)}
        >
          <button
            type="button"
            className={styles.backgroundUploadButton}
            onClick={() => backgroundInputRef.current?.click()}
            disabled={isRecording}
          >
            <ImagePlus size={15} aria-hidden="true" />
            {stageBackgroundImage ? "사진 배경 바꾸기" : "사진 배경 선택"}
          </button>
          {stageBackgroundImage ? (
            <>
              <strong className={styles.backgroundFileName} title={stageBackgroundName}>
                {stageBackgroundName}
              </strong>
              <div className={styles.backgroundFitControls} aria-label="사진 배경 맞춤 방식">
                <button
                  type="button"
                  data-selected={stageBackgroundFit === "cover"}
                  aria-pressed={stageBackgroundFit === "cover"}
                  onClick={() => changeStageBackgroundFit("cover")}
                >
                  화면 채우기
                </button>
                <button
                  type="button"
                  data-selected={stageBackgroundFit === "contain"}
                  aria-pressed={stageBackgroundFit === "contain"}
                  onClick={() => changeStageBackgroundFit("contain")}
                >
                  전체 보기
                </button>
              </div>
              <button
                type="button"
                className={styles.backgroundRemoveButton}
                onClick={removeStageBackgroundImage}
              >
                <Trash2 size={13} aria-hidden="true" />
                사진 배경 지우기
              </button>
            </>
          ) : (
            <small>PNG · JPEG · WebP, 최대 12MB</small>
          )}
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

        <button
          type="button"
          className={styles.legLockButton}
          data-locked={legsLocked}
          aria-pressed={legsLocked}
          onClick={toggleLegLock}
          disabled={
            !characterReady ||
            isRecording ||
            animationPlaying ||
            modelState === "loading"
          }
        >
          {legsLocked ? <LockKeyhole size={15} /> : <LockOpen size={15} />}
          <span>
            <strong>{legsLocked ? "다리 고정됨" : "다리 움직임 추적"}</strong>
            <small>{legsLocked ? "눌러서 다리 풀기" : "눌러서 현재 자세 고정"}</small>
          </span>
        </button>

        <span className={styles.sectionLabel}>Export</span>
        <div className={styles.metrics}>
          <div className={styles.metric}>
            <span>SIZE</span>
            <strong>1600 × 2000</strong>
          </div>
          <div className={styles.metric}>
            <span>FORMAT</span>
            <strong>{characterReady ? "PNG · WEBM" : "PNG · 투명"}</strong>
          </div>
        </div>
        <p className={styles.exportNote}>
          {characterReady
            ? "현재 포즈는 투명 PNG로, 선택한 동작은 브라우저에서 바로 WebM으로 저장합니다."
            : "저장할 때 현재 포즈의 실제 범위를 다시 계산해 머리부터 발끝까지 자동으로 화면 안에 맞춥니다."}
        </p>
      </aside>

      {captureDialogOpen ? (
        <div className={styles.captureDialogBackdrop}>
          <div
            ref={captureDialogRef}
            className={styles.captureDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="capture-dialog-title"
            aria-describedby="capture-dialog-description"
          >
            <button
              type="button"
              className={styles.captureDialogClose}
              onClick={closeCaptureDialog}
              aria-label="PNG 저장 창 닫기"
            >
              <X size={18} aria-hidden="true" />
            </button>
            <span className={styles.captureDialogEyebrow}>FULL-BODY PNG</span>
            <h2 id="capture-dialog-title">배경을 함께 저장할까요?</h2>
            <p id="capture-dialog-description">
              현재 포즈의 전신을 자동으로 맞춘 뒤 선택한 방식으로 저장합니다.
            </p>
            <div className={styles.captureDialogChoices}>
              <button
                ref={captureDialogFirstChoiceRef}
                type="button"
                className={styles.captureDialogChoice}
                onClick={() => void capture(false)}
                disabled={isCapturing}
              >
                <span
                  className={styles.transparentChoicePreview}
                  aria-hidden="true"
                >
                  <Sparkles size={21} />
                </span>
                <span>
                  <strong>배경 미포함</strong>
                  <small>캐릭터만 투명 PNG로 저장</small>
                </span>
              </button>
              <button
                type="button"
                className={styles.captureDialogChoice}
                onClick={() => void capture(true)}
                disabled={isCapturing}
              >
                <span
                  className={styles.backgroundChoicePreview}
                  style={{ backgroundColor: stageColor }}
                  aria-hidden="true"
                >
                  <ImageIcon size={21} />
                </span>
                <span>
                  <strong>배경 포함</strong>
                  <small>
                    {stageBackgroundImage
                      ? "현재 사진 배경과 함께 저장"
                      : "현재 무대 배경색과 함께 저장"}
                  </small>
                </span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
