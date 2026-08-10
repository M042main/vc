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

async function createLandmarker() {
  if (landmarker) return;

  const fileset = await FilesetResolver.forVisionTasks(WASM_ROOT);
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

  try {
    if (typeof OffscreenCanvas === "undefined") throw new Error("No OffscreenCanvas");
    landmarker = await HolisticLandmarker.createFromOptions(fileset, {
      ...common,
      canvas: new OffscreenCanvas(2, 2),
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
    });
    delegate = "GPU";
  } catch {
    landmarker = await HolisticLandmarker.createFromOptions(fileset, {
      ...common,
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
    });
    delegate = "CPU";
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
        message:
          error instanceof Error
            ? error.message
            : "트래킹 엔진을 준비하지 못했습니다.",
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
      message:
        error instanceof Error ? error.message : "프레임 분석에 실패했습니다.",
    });
  } finally {
    message.bitmap.close();
  }
};

export {};
