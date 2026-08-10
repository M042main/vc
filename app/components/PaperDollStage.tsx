"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

export type PaperDollLandmark = {
  x: number;
  y: number;
  visibility?: number;
};

export type PaperDollStageHandle = {
  applyPose: (landmarks?: readonly PaperDollLandmark[]) => void;
  capturePng: (width?: number, height?: number) => Promise<Blob>;
  resetPose: () => void;
  rotate: (direction: -1 | 1) => void;
};

type PaperDollStageProps = {
  artwork: string;
  className?: string;
};

type DollPose = {
  rotation: number;
  scale: number;
  x: number;
  y: number;
};

const REST_POSE: DollPose = { rotation: 0, scale: 1, x: 0, y: 0 };

function visible(landmark?: PaperDollLandmark) {
  return Boolean(landmark && (landmark.visibility ?? 1) > 0.35);
}

function poseFromLandmarks(landmarks?: readonly PaperDollLandmark[]): DollPose {
  const leftShoulder = landmarks?.[11];
  const rightShoulder = landmarks?.[12];
  const leftHip = landmarks?.[23];
  const rightHip = landmarks?.[24];

  if (!visible(leftShoulder) || !visible(rightShoulder)) return REST_POSE;

  const shoulderX = (leftShoulder!.x + rightShoulder!.x) / 2;
  const shoulderY = (leftShoulder!.y + rightShoulder!.y) / 2;
  const shoulderWidth = Math.hypot(
    rightShoulder!.x - leftShoulder!.x,
    rightShoulder!.y - leftShoulder!.y,
  );
  const shoulderAngle = Math.atan2(
    rightShoulder!.y - leftShoulder!.y,
    rightShoulder!.x - leftShoulder!.x,
  );

  let bodyX = shoulderX;
  let bodyY = shoulderY;
  if (visible(leftHip) && visible(rightHip)) {
    bodyX = (shoulderX * 2 + (leftHip!.x + rightHip!.x) / 2) / 3;
    bodyY = (shoulderY * 2 + (leftHip!.y + rightHip!.y) / 2) / 3;
  }

  return {
    rotation: Math.max(-0.28, Math.min(0.28, shoulderAngle)),
    scale: Math.max(0.9, Math.min(1.1, shoulderWidth / 0.27)),
    // The camera preview is mirrored, so mirror horizontal tracking as well.
    x: Math.max(-0.13, Math.min(0.13, 0.5 - bodyX)),
    y: Math.max(-0.08, Math.min(0.08, bodyY - 0.42)),
  };
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("캐릭터 PNG를 만들지 못했습니다."));
    }, "image/png");
  });
}

export const PaperDollStage = forwardRef<PaperDollStageHandle, PaperDollStageProps>(
  function PaperDollStage({ artwork, className }, ref) {
    const hostRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const imageRef = useRef<HTMLImageElement | null>(null);
    const poseRef = useRef<DollPose>({ ...REST_POSE });
    const manualRotationRef = useRef(0);

    const drawTo = useCallback(
      (canvas: HTMLCanvasElement, width: number, height: number) => {
        const context = canvas.getContext("2d");
        const image = imageRef.current;
        if (!context || !image || !image.complete || image.naturalWidth === 0) return;

        context.clearRect(0, 0, canvas.width, canvas.height);

        const pose = poseRef.current;
        const baseScale = Math.min(
          (width * 0.72) / image.naturalWidth,
          (height * 0.84) / image.naturalHeight,
        );
        const drawWidth = image.naturalWidth * baseScale * pose.scale;
        const drawHeight = image.naturalHeight * baseScale * pose.scale;
        const centerX = width / 2 + pose.x * width;
        const centerY = height * 0.51 + pose.y * height;

        context.save();
        context.translate(centerX, centerY);
        context.rotate(pose.rotation + manualRotationRef.current);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
        context.restore();
      },
      [],
    );

    const redraw = useCallback(() => {
      const host = hostRef.current;
      const canvas = canvasRef.current;
      if (!host || !canvas) return;

      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(host.clientWidth * pixelRatio));
      const height = Math.max(1, Math.round(host.clientHeight * pixelRatio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      drawTo(canvas, width, height);
    }, [drawTo]);

    useEffect(() => {
      const image = new Image();
      image.decoding = "async";
      image.onload = redraw;
      imageRef.current = image;
      image.src = artwork;
      redraw();

      return () => {
        image.onload = null;
        if (imageRef.current === image) imageRef.current = null;
      };
    }, [artwork, redraw]);

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      const observer = new ResizeObserver(redraw);
      observer.observe(host);
      redraw();
      return () => observer.disconnect();
    }, [redraw]);

    useImperativeHandle(
      ref,
      () => ({
        applyPose(landmarks) {
          const next = poseFromLandmarks(landmarks);
          const current = poseRef.current;
          poseRef.current = {
            rotation: current.rotation * 0.7 + next.rotation * 0.3,
            scale: current.scale * 0.72 + next.scale * 0.28,
            x: current.x * 0.7 + next.x * 0.3,
            y: current.y * 0.7 + next.y * 0.3,
          };
          redraw();
        },
        async capturePng(width = 1600, height = 2000) {
          if (!imageRef.current?.complete || imageRef.current.naturalWidth === 0) {
            throw new Error("직접 그린 캐릭터를 아직 준비하고 있습니다.");
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          drawTo(canvas, width, height);
          return canvasToBlob(canvas);
        },
        resetPose() {
          poseRef.current = { ...REST_POSE };
          manualRotationRef.current = 0;
          redraw();
        },
        rotate(direction) {
          manualRotationRef.current = Math.max(
            -0.3,
            Math.min(0.3, manualRotationRef.current + direction * 0.08),
          );
          redraw();
        },
      }),
      [drawTo, redraw],
    );

    return (
      <div ref={hostRef} className={className} aria-label="직접 그린 캐릭터 미리보기">
        <canvas ref={canvasRef} />
      </div>
    );
  },
);

PaperDollStage.displayName = "PaperDollStage";

export default PaperDollStage;
