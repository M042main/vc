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

const FACE_CONNECTIONS: readonly Connection[] = [
  ...connectPath([
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397,
    365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58,
    132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10,
  ]),
  ...connectPath([
    61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269,
    267, 0, 37, 39, 40, 185, 61,
  ]),
  ...connectPath([
    78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311,
    312, 13, 82, 81, 80, 191, 78,
  ]),
  ...connectPath([
    33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159,
    160, 161, 246, 33,
  ]),
  ...connectPath([
    263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386,
    387, 388, 466, 263,
  ]),
  ...connectPath([70, 63, 105, 66, 107]),
  ...connectPath([336, 296, 334, 293, 300]),
  ...connectPath([168, 6, 197, 195, 5, 4, 1, 19, 94, 2]),
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
  if (!landmarks?.length) return;

  const project = (landmark: TrackingLandmark) => ({
    x:
      projection.x +
      (mirror ? 1 - landmark.x : landmark.x) * projection.width,
    y: projection.y + landmark.y * projection.height,
  });

  context.beginPath();
  for (const [startIndex, endIndex] of connections) {
    const start = landmarks[startIndex];
    const end = landmarks[endIndex];
    if (!isDrawableLandmark(start) || !isDrawableLandmark(end)) continue;

    const startPoint = project(start);
    const endPoint = project(end);
    context.moveTo(startPoint.x, startPoint.y);
    context.lineTo(endPoint.x, endPoint.y);
  }
  context.globalAlpha = 0.72;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = lineWidth;
  context.strokeStyle = color;
  context.stroke();

  context.beginPath();
  for (const landmark of landmarks) {
    if (!isDrawableLandmark(landmark)) continue;
    const point = project(landmark);
    context.moveTo(point.x + pointRadius, point.y);
    context.arc(point.x, point.y, pointRadius, 0, Math.PI * 2);
  }
  context.globalAlpha = 0.94;
  context.fillStyle = color;
  context.fill();
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

  drawLandmarkList(
    context,
    frame.faceLandmarks,
    FACE_CONNECTIONS,
    projection,
    frame.mirror,
    "#b7a7ff",
    unit * 0.52,
    unit * 0.72,
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
