/// <reference lib="webworker" />

import {
  FilesetResolver,
  HolisticLandmarker,
  type HolisticLandmarkerResult,
} from "@mediapipe/tasks-vision";

const WASM_ROOT =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/holistic_landmarker/holistic_landmarker/float16/1/holistic_landmarker.task";

let landmarker: HolisticLandmarker | null = null;
let delegate: "GPU" | "CPU" = "CPU";

type WorkerInput =
  | { type: "INIT" }
  | { type: "FRAME"; bitmap: ImageBitmap; timestamp: number }
  | { type: "STOP" };

type WorkerOutput =
  | { type: "READY"; delegate: "GPU" | "CPU" }
  | {
      type: "RESULT";
      result: HolisticLandmarkerResult;
      inferenceMs: number;
    }
  | { type: "ERROR"; message: string };

function reply(message: WorkerOutput) {
  self.postMessage(message);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function createLandmarker() {
  if (landmarker) return;

  let fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
  try {
    // This source is bundled as an ES module worker. Selecting the module WASM
    // loader is essential: the classic loader cannot expose ModuleFactory after
    // a dynamic import inside a module worker.
    fileset = await FilesetResolver.forVisionTasks(WASM_ROOT, true);
  } catch (error) {
    throw new Error(`MediaPipe WASM 파일을 불러오지 못했습니다: ${errorMessage(error)}`);
  }

  const common = {
    runningMode: "VIDEO" as const,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minFaceSuppressionThreshold: 0.3,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minPoseSuppressionThreshold: 0.3,
    minHandLandmarksConfidence: 0.5,
    outputFaceBlendshapes: true,
    outputPoseSegmentationMasks: false,
  };

  let gpuError: unknown;
  if (typeof OffscreenCanvas !== "undefined") {
    try {
      landmarker = await HolisticLandmarker.createFromOptions(fileset, {
        ...common,
        canvas: new OffscreenCanvas(2, 2),
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      });
      delegate = "GPU";
    } catch (error) {
      gpuError = error;
    }
  } else {
    gpuError = new Error("OffscreenCanvas를 지원하지 않는 브라우저입니다.");
  }

  if (!landmarker) {
    try {
      // CPU mode deliberately omits a canvas and remains available when WebGL,
      // OffscreenCanvas, or the GPU delegate cannot initialize.
      landmarker = await HolisticLandmarker.createFromOptions(fileset, {
        ...common,
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
      });
      delegate = "CPU";
    } catch (cpuError) {
      throw new Error(
        `트래킹 모델 초기화에 실패했습니다. GPU: ${errorMessage(gpuError)} / CPU: ${errorMessage(cpuError)}`,
      );
    }
  }

  if (!landmarker) {
    // This should be unreachable, but keeps READY from being emitted without a
    // usable engine if a future MediaPipe release changes its return contract.
    throw new Error("MediaPipe 트래킹 엔진이 생성되지 않았습니다.");
  }

  reply({ type: "READY", delegate });
}

self.onmessage = async (event: MessageEvent<WorkerInput>) => {
  const message = event.data;

  if (message.type === "INIT") {
    try {
      await createLandmarker();
    } catch (error) {
      reply({
        type: "ERROR",
        message: errorMessage(error) || "트래킹 엔진을 준비하지 못했습니다.",
      });
    }
    return;
  }

  if (message.type === "STOP") {
    landmarker?.close();
    landmarker = null;
    self.close();
    return;
  }

  if (!landmarker) {
    message.bitmap.close();
    reply({ type: "ERROR", message: "트래킹 엔진이 아직 준비되지 않았습니다." });
    return;
  }

  const startedAt = performance.now();
  try {
    const result = landmarker.detectForVideo(message.bitmap, message.timestamp);
    reply({
      type: "RESULT",
      result,
      inferenceMs: performance.now() - startedAt,
    });
  } catch (error) {
    reply({
      type: "ERROR",
      message: errorMessage(error) || "프레임 분석에 실패했습니다.",
    });
  } finally {
    message.bitmap.close();
  }
};

export {};
