"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import styles from "./TrackingLandmarkOverlay.module.css";

export interface TrackingLandmark {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
  presence?: number;
}

export type TrackingLandmarkList = readonly TrackingLandmark[];

export interface TrackingLandmarkFrame {
  poseLandmarks?: TrackingLandmarkList | null;
  faceLandmarks?: TrackingLandmarkList | null;
  leftHandLandmarks?: TrackingLandmarkList | null;
  rightHandLandmarks?: TrackingLandmarkList | null;
}

export interface TrackingLandmarkOverlayHandle {
  /** Queues the newest tracking frame; intermediate frames are coalesced at 15fps. */
  draw(frame: TrackingLandmarkFrame): void;
  /** Immediately removes every landmark from the overlay. */
  clear(): void;
}

export interface TrackingLandmarkOverlayProps {
  /** Reflect normalized X coordinates to match a mirrored selfie preview. */
  mirror?: boolean;
  /** Stops drawing and releases the backing canvas while the preview is hidden. */
  hidden?: boolean;
  /** Intrinsic camera-frame aspect ratio. Set this when the video uses object-fit. */
  sourceAspectRatio?: number;
  /** Must match the camera preview's object-fit value. */
  fit?: "cover" | "contain" | "fill";
  className?: string;
}

interface OverlayFrame extends TrackingLandmarkFrame {
  mirror: boolean;
  sourceAspectRatio?: number;
  fit: "cover" | "contain" | "fill";
}

interface CanvasSize {
  width: number;
  height: number;
  dpr: number;
}

type Connection = readonly [start: number, end: number];

const MAX_DPR = 2;
const FRAME_INTERVAL_MS = 1000 / 15;
const MIN_CONFIDENCE = 0.2;

const POSE_CONNECTIONS: readonly Connection[] = [
  [0, 1], [1, 2], [2, 3], [3, 7],
  [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  [11, 12], [11, 13], [13, 15], [15, 17], [17, 19],
  [15, 19], [15, 21], [12, 14], [14, 16], [16, 18],
  [18, 20], [16, 20], [16, 22], [11, 23], [12, 24],
  [23, 24], [23, 25], [24, 26], [25, 27], [26, 28],
  [27, 29], [28, 30], [29, 31], [30, 32], [27, 31],
  [28, 32],
];

const HAND_CONNECTIONS: readonly Connection[] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

function connectPath(path: readonly number[]): Connection[] {
  const connections: Connection[] = [];
  for (let index = 1; index < path.length; index += 1) {
    connections.push([path[index - 1], path[index]]);
  }
  return connections;
}

// Keep the official 478-point Face Mesh result intact. These semantic paths
// only add readable structure on top of the complete point cloud; they never
// slice or remap the face landmark array.
const FACE_OVAL_CONNECTIONS: readonly Connection[] = connectPath([
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397,
  365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58,
  132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10,
]);

const RIGHT_EYE_CONNECTIONS: readonly Connection[] = [
  ...connectPath([33, 7, 163, 144, 145, 153, 154, 155, 133]),
  ...connectPath([33, 246, 161, 160, 159, 158, 157, 173, 133]),
];

const LEFT_EYE_CONNECTIONS: readonly Connection[] = [
  ...connectPath([263, 249, 390, 373, 374, 380, 381, 382, 362]),
  ...connectPath([263, 466, 388, 387, 386, 385, 384, 398, 362]),
];

const EYE_CONNECTIONS: readonly Connection[] = [
  ...RIGHT_EYE_CONNECTIONS,
  ...LEFT_EYE_CONNECTIONS,
];

const RIGHT_EYEBROW_CONNECTIONS: readonly Connection[] = [
  ...connectPath([46, 53, 52, 65, 55]),
  ...connectPath([70, 63, 105, 66, 107]),
];

const LEFT_EYEBROW_CONNECTIONS: readonly Connection[] = [
  ...connectPath([276, 283, 282, 295, 285]),
  ...connectPath([300, 293, 334, 296, 336]),
];

const EYEBROW_CONNECTIONS: readonly Connection[] = [
  ...RIGHT_EYEBROW_CONNECTIONS,
  ...LEFT_EYEBROW_CONNECTIONS,
];

const NOSE_CONNECTIONS: readonly Connection[] = [
  ...connectPath([168, 6, 197, 195, 5, 4, 1, 2]),
  ...connectPath([168, 193, 122, 196, 3, 51, 45, 4]),
  ...connectPath([168, 417, 351, 419, 248, 281, 275, 4]),
  ...connectPath([49, 48, 64, 98, 97, 2, 326, 327, 294, 278, 279]),
  [1, 98],
  [1, 327],
];

const UPPER_LIP_CONNECTIONS: readonly Connection[] = [
  ...connectPath([61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291]),
  ...connectPath([78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308]),
];

const LOWER_LIP_CONNECTIONS: readonly Connection[] = [
  ...connectPath([61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291]),
  ...connectPath([78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308]),
];

const MOUTH_OUTLINE_CONNECTIONS: readonly Connection[] = [
  ...UPPER_LIP_CONNECTIONS,
  ...LOWER_LIP_CONNECTIONS,
  [61, 78],
  [291, 308],
  [0, 13],
  [17, 14],
];

const RIGHT_IRIS_CONNECTIONS: readonly Connection[] = connectPath([
  469, 470, 471, 472, 469,
]);

const LEFT_IRIS_CONNECTIONS: readonly Connection[] = connectPath([
  474, 475, 476, 477, 474,
]);

const IRIS_CONNECTIONS: readonly Connection[] = [
  ...RIGHT_IRIS_CONNECTIONS,
  ...LEFT_IRIS_CONNECTIONS,
];

const IRIS_CENTER_INDICES = [468, 473] as const;

function landmarkIndices(connections: readonly Connection[]) {
  return [...new Set(connections.flatMap(([start, end]) => [start, end]))];
}

const EYE_INDICES = landmarkIndices(EYE_CONNECTIONS);
const FACE_OVAL_INDICES = landmarkIndices(FACE_OVAL_CONNECTIONS);
const EYEBROW_INDICES = landmarkIndices(EYEBROW_CONNECTIONS);
const NOSE_INDICES = landmarkIndices(NOSE_CONNECTIONS);
const UPPER_LIP_INDICES = landmarkIndices(UPPER_LIP_CONNECTIONS);
const LOWER_LIP_INDICES = landmarkIndices(LOWER_LIP_CONNECTIONS);
const MOUTH_OUTLINE_INDICES = [61, 78, 0, 13, 291, 308, 17, 14] as const;
const IRIS_INDICES = landmarkIndices(IRIS_CONNECTIONS);

const FACE_SEMANTIC_LAYERS: readonly {
  connections: readonly Connection[];
  indices: readonly number[];
  color: string;
}[] = [
  {
    connections: FACE_OVAL_CONNECTIONS,
    indices: FACE_OVAL_INDICES,
    color: "#c8b8ff",
  },
  { connections: EYE_CONNECTIONS, indices: EYE_INDICES, color: "#75e9ff" },
  {
    connections: EYEBROW_CONNECTIONS,
    indices: EYEBROW_INDICES,
    color: "#ffe36b",
  },
  { connections: NOSE_CONNECTIONS, indices: NOSE_INDICES, color: "#ffad66" },
  {
    connections: UPPER_LIP_CONNECTIONS,
    indices: UPPER_LIP_INDICES,
    color: "#ff78b7",
  },
  {
    connections: LOWER_LIP_CONNECTIONS,
    indices: LOWER_LIP_INDICES,
    color: "#ff597d",
  },
  {
    connections: MOUTH_OUTLINE_CONNECTIONS,
    indices: MOUTH_OUTLINE_INDICES,
    color: "#ffd0e3",
  },
  {
    connections: IRIS_CONNECTIONS,
    indices: IRIS_INDICES,
    color: "#7dff9a",
  },
];

function confidence(landmark: TrackingLandmark) {
  return Math.min(landmark.visibility ?? 1, landmark.presence ?? 1);
}

function isDrawableLandmark(
  landmark: TrackingLandmark | undefined,
): landmark is TrackingLandmark {
  return Boolean(
    landmark &&
      Number.isFinite(landmark.x) &&
      Number.isFinite(landmark.y) &&
      confidence(landmark) >= MIN_CONFIDENCE,
  );
}

function projectionFor(
  size: CanvasSize,
  sourceAspectRatio: number | undefined,
  fit: OverlayFrame["fit"],
) {
  if (
    fit === "fill" ||
    !sourceAspectRatio ||
    !Number.isFinite(sourceAspectRatio) ||
    sourceAspectRatio <= 0
  ) {
    return { x: 0, y: 0, width: size.width, height: size.height };
  }

  const targetAspectRatio = size.width / size.height;
  const sourceIsWider = sourceAspectRatio > targetAspectRatio;
  const useHeight = fit === "cover" ? sourceIsWider : !sourceIsWider;

  if (useHeight) {
    const width = size.height * sourceAspectRatio;
    return {
      x: (size.width - width) / 2,
      y: 0,
      width,
      height: size.height,
    };
  }

  const height = size.width / sourceAspectRatio;
  return {
    x: 0,
    y: (size.height - height) / 2,
    width: size.width,
    height,
  };
}

function projectLandmark(
  landmark: TrackingLandmark,
  projection: ReturnType<typeof projectionFor>,
  mirror: boolean,
) {
  return {
    x:
      projection.x +
      (mirror ? 1 - landmark.x : landmark.x) * projection.width,
    y: projection.y + landmark.y * projection.height,
  };
}

function drawLandmarkConnections(
  context: CanvasRenderingContext2D,
  landmarks: TrackingLandmarkList | null | undefined,
  connections: readonly Connection[],
  projection: ReturnType<typeof projectionFor>,
  mirror: boolean,
  color: string,
  lineWidth: number,
  alpha: number,
) {
  if (!landmarks?.length) return;

  context.beginPath();
  for (const [startIndex, endIndex] of connections) {
    const start = landmarks[startIndex];
    const end = landmarks[endIndex];
    if (!isDrawableLandmark(start) || !isDrawableLandmark(end)) continue;

    const startPoint = projectLandmark(start, projection, mirror);
    const endPoint = projectLandmark(end, projection, mirror);
    context.moveTo(startPoint.x, startPoint.y);
    context.lineTo(endPoint.x, endPoint.y);
  }
  context.globalAlpha = alpha;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = lineWidth;
  context.strokeStyle = color;
  context.stroke();
}

function drawLandmarkPoints(
  context: CanvasRenderingContext2D,
  landmarks: TrackingLandmarkList | null | undefined,
  indices: readonly number[] | undefined,
  projection: ReturnType<typeof projectionFor>,
  mirror: boolean,
  color: string,
  pointRadius: number,
  alpha: number,
) {
  if (!landmarks?.length) return;

  context.beginPath();
  const drawPoint = (landmark: TrackingLandmark | undefined) => {
    if (!isDrawableLandmark(landmark)) return;
    const point = projectLandmark(landmark, projection, mirror);
    context.moveTo(point.x + pointRadius, point.y);
    context.arc(point.x, point.y, pointRadius, 0, Math.PI * 2);
  };
  if (indices) {
    for (const index of indices) drawPoint(landmarks[index]);
  } else {
    // Intentionally walk every supplied point. A 478-landmark face therefore
    // renders all 478 points, including both five-point iris groups.
    for (const landmark of landmarks) drawPoint(landmark);
  }
  context.globalAlpha = alpha;
  context.fillStyle = color;
  context.fill();
}

function drawLandmarkList(
  context: CanvasRenderingContext2D,
  landmarks: TrackingLandmarkList | null | undefined,
  connections: readonly Connection[],
  projection: ReturnType<typeof projectionFor>,
  mirror: boolean,
  color: string,
  pointRadius: number,
  lineWidth: number,
) {
  drawLandmarkConnections(
    context,
    landmarks,
    connections,
    projection,
    mirror,
    color,
    lineWidth,
    0.72,
  );
  drawLandmarkPoints(
    context,
    landmarks,
    undefined,
    projection,
    mirror,
    color,
    pointRadius,
    0.94,
  );
}

function drawFaceLandmarks(
  context: CanvasRenderingContext2D,
  landmarks: TrackingLandmarkList | null | undefined,
  projection: ReturnType<typeof projectionFor>,
  mirror: boolean,
  unit: number,
) {
  if (!landmarks?.length) return;

  // A subtle complete point cloud preserves all topology without turning the
  // camera preview into an opaque mesh. Semantic overlays then make each
  // expression-bearing region immediately readable.
  drawLandmarkPoints(
    context,
    landmarks,
    undefined,
    projection,
    mirror,
    "#eeeaff",
    unit * 0.32,
    0.7,
  );

  for (const layer of FACE_SEMANTIC_LAYERS) {
    drawLandmarkConnections(
      context,
      landmarks,
      layer.connections,
      projection,
      mirror,
      "#13131a",
      unit * 1.12,
      0.58,
    );
    drawLandmarkConnections(
      context,
      landmarks,
      layer.connections,
      projection,
      mirror,
      layer.color,
      unit * 0.62,
      0.96,
    );
    drawLandmarkPoints(
      context,
      landmarks,
      layer.indices,
      projection,
      mirror,
      layer.color,
      unit * 0.46,
      0.98,
    );
  }

  drawLandmarkPoints(
    context,
    landmarks,
    IRIS_CENTER_INDICES,
    projection,
    mirror,
    "#ffffff",
    unit * 0.86,
    1,
  );
}

function hasAnyLandmarks(frame: OverlayFrame) {
  return Boolean(
    frame.poseLandmarks?.length ||
      frame.faceLandmarks?.length ||
      frame.leftHandLandmarks?.length ||
      frame.rightHandLandmarks?.length,
  );
}

function clearCanvas(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
}

function drawFrame(
  canvas: HTMLCanvasElement,
  size: CanvasSize,
  frame: OverlayFrame,
) {
  const pixelWidth = Math.max(1, Math.round(size.width * size.dpr));
  const pixelHeight = Math.max(1, Math.round(size.height * size.dpr));
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!hasAnyLandmarks(frame) || size.width <= 0 || size.height <= 0) return;

  context.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
  const projection = projectionFor(size, frame.sourceAspectRatio, frame.fit);
  const unit = Math.max(0.75, Math.min(size.width, size.height) / 110);

  drawFaceLandmarks(
    context,
    frame.faceLandmarks,
    projection,
    frame.mirror,
    unit,
  );
  drawLandmarkList(
    context,
    frame.poseLandmarks,
    POSE_CONNECTIONS,
    projection,
    frame.mirror,
    "#dfff45",
    unit * 1.25,
    unit * 1.15,
  );
  drawLandmarkList(
    context,
    frame.leftHandLandmarks,
    HAND_CONNECTIONS,
    projection,
    frame.mirror,
    "#ff7357",
    unit,
    unit,
  );
  drawLandmarkList(
    context,
    frame.rightHandLandmarks,
    HAND_CONNECTIONS,
    projection,
    frame.mirror,
    "#5de1ff",
    unit,
    unit,
  );

  context.globalAlpha = 1;
  context.setTransform(1, 0, 0, 1, 0, 0);
}

export const TrackingLandmarkOverlay = forwardRef<
  TrackingLandmarkOverlayHandle,
  TrackingLandmarkOverlayProps
>(function TrackingLandmarkOverlay(
  {
    mirror = true,
    hidden = false,
    sourceAspectRatio,
    fit = "cover",
    className,
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<OverlayFrame>({ mirror, fit, sourceAspectRatio });
  const sizeRef = useRef<CanvasSize>({ width: 0, height: 0, dpr: 1 });
  const hiddenRef = useRef(hidden);
  const intersectingRef = useRef(true);
  const documentVisibleRef = useRef(true);
  const timeoutRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastDrawAtRef = useRef(-Infinity);

  const cancelScheduledDraw = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }, []);

  const isActive = useCallback(
    () =>
      !hiddenRef.current &&
      intersectingRef.current &&
      documentVisibleRef.current,
    [],
  );

  const suspendCanvas = useCallback(() => {
    cancelScheduledDraw();
    const canvas = canvasRef.current;
    if (!canvas) return;
    clearCanvas(canvas);
    canvas.width = 1;
    canvas.height = 1;
  }, [cancelScheduledDraw]);

  const scheduleDraw = useCallback(
    (immediate = false) => {
      if (!isActive()) return;
      if (timeoutRef.current !== null || animationFrameRef.current !== null) {
        return;
      }

      const queueAnimationFrame = () => {
        timeoutRef.current = null;
        if (!isActive()) return;
        animationFrameRef.current = window.requestAnimationFrame((drawAt) => {
          animationFrameRef.current = null;
          if (!isActive()) return;
          lastDrawAtRef.current = drawAt;
          const canvas = canvasRef.current;
          if (canvas) drawFrame(canvas, sizeRef.current, frameRef.current);
        });
      };

      const wait = immediate
        ? 0
        : Math.max(
            0,
            FRAME_INTERVAL_MS - (performance.now() - lastDrawAtRef.current),
          );
      if (wait > 1) {
        timeoutRef.current = window.setTimeout(queueAnimationFrame, wait);
      } else {
        queueAnimationFrame();
      }
    },
    [isActive],
  );

  useImperativeHandle(
    ref,
    () => ({
      draw(frame) {
        frameRef.current = { ...frameRef.current, ...frame };
        scheduleDraw();
      },
      clear() {
        frameRef.current = {
          ...frameRef.current,
          poseLandmarks: null,
          faceLandmarks: null,
          leftHandLandmarks: null,
          rightHandLandmarks: null,
        };
        cancelScheduledDraw();
        const canvas = canvasRef.current;
        if (canvas) clearCanvas(canvas);
      },
    }),
    [cancelScheduledDraw, scheduleDraw],
  );

  useEffect(() => {
    frameRef.current = {
      ...frameRef.current,
      mirror,
      sourceAspectRatio,
      fit,
    };
    hiddenRef.current = hidden;

    if (hidden) {
      suspendCanvas();
    } else {
      scheduleDraw();
    }
  }, [
    fit,
    hidden,
    mirror,
    scheduleDraw,
    sourceAspectRatio,
    suspendCanvas,
  ]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const updateSize = (width: number, height: number) => {
      sizeRef.current = {
        width: Math.max(0, width),
        height: Math.max(0, height),
        dpr: Math.min(MAX_DPR, Math.max(1, window.devicePixelRatio || 1)),
      };
      if (width > 0 && height > 0) scheduleDraw(true);
    };

    const bounds = canvas.getBoundingClientRect();
    updateSize(bounds.width, bounds.height);

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      updateSize(entry.contentRect.width, entry.contentRect.height);
    });
    resizeObserver.observe(canvas);

    let intersectionObserver: IntersectionObserver | null = null;
    if ("IntersectionObserver" in window) {
      intersectionObserver = new IntersectionObserver((entries) => {
        intersectingRef.current = entries[0]?.isIntersecting ?? true;
        if (intersectingRef.current) scheduleDraw(true);
        else suspendCanvas();
      });
      intersectionObserver.observe(canvas);
    }

    const handleVisibilityChange = () => {
      documentVisibleRef.current = document.visibilityState !== "hidden";
      if (documentVisibleRef.current) scheduleDraw(true);
      else suspendCanvas();
    };
    documentVisibleRef.current = document.visibilityState !== "hidden";
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      resizeObserver.disconnect();
      intersectionObserver?.disconnect();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      suspendCanvas();
    };
  }, [scheduleDraw, suspendCanvas]);

  const classes = className
    ? `${styles.canvas} ${className}`
    : styles.canvas;

  return (
    <canvas
      ref={canvasRef}
      className={classes}
      data-hidden={hidden}
      hidden={hidden}
      aria-hidden="true"
    />
  );
});
