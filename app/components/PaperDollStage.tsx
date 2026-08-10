"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type PointerEvent as ReactPointerEvent,
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

type Point = { x: number; y: number };

type JointName =
  | "leftShoulder"
  | "leftElbow"
  | "leftWrist"
  | "rightShoulder"
  | "rightElbow"
  | "rightWrist"
  | "leftHip"
  | "leftKnee"
  | "leftAnkle"
  | "rightHip"
  | "rightKnee"
  | "rightAnkle";

type BoneName =
  | "leftUpperArm"
  | "leftLowerArm"
  | "rightUpperArm"
  | "rightLowerArm"
  | "leftUpperLeg"
  | "leftLowerLeg"
  | "rightUpperLeg"
  | "rightLowerLeg";

type DollPose = {
  rotation: number;
  scale: number;
  x: number;
  y: number;
  headRotation: number;
  boneAngles: Record<BoneName, number>;
};

type RigPart = {
  bone: BoneName;
  start: JointName;
  end: JointName;
  mask: readonly Point[];
};

type RigSprite = {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
};

type DollSprites = {
  parts: Record<BoneName, RigSprite>;
  torso: RigSprite;
  head: RigSprite;
};

const ARTWORK_WIDTH = 600;
const ARTWORK_HEIGHT = 760;
const ARTWORK_CENTER = { x: ARTWORK_WIDTH / 2, y: ARTWORK_HEIGHT / 2 };

const REST_JOINTS: Record<JointName, Point> = {
  leftShoulder: { x: 221, y: 238 },
  leftElbow: { x: 202, y: 350 },
  leftWrist: { x: 182, y: 442 },
  rightShoulder: { x: 379, y: 238 },
  rightElbow: { x: 398, y: 350 },
  rightWrist: { x: 418, y: 442 },
  leftHip: { x: 268, y: 470 },
  leftKnee: { x: 236, y: 572 },
  leftAnkle: { x: 226, y: 704 },
  rightHip: { x: 332, y: 470 },
  rightKnee: { x: 364, y: 572 },
  rightAnkle: { x: 374, y: 704 },
};

// Parts overlap around the joints on purpose. Drawing the upper segment after
// the lower one hides tiny seams while keeping every painted pixel attached to
// a real shoulder, elbow, hip, or knee pivot.
const DOLL_PARTS: readonly RigPart[] = [
  {
    bone: "leftLowerLeg",
    start: "leftKnee",
    end: "leftAnkle",
    mask: [
      { x: 194, y: 536 },
      { x: 278, y: 536 },
      { x: 277, y: 748 },
      { x: 166, y: 748 },
      { x: 166, y: 695 },
    ],
  },
  {
    bone: "rightLowerLeg",
    start: "rightKnee",
    end: "rightAnkle",
    mask: [
      { x: 322, y: 536 },
      { x: 406, y: 536 },
      { x: 434, y: 695 },
      { x: 434, y: 748 },
      { x: 323, y: 748 },
    ],
  },
  {
    bone: "leftUpperLeg",
    start: "leftHip",
    end: "leftKnee",
    mask: [
      { x: 203, y: 438 },
      { x: 302, y: 438 },
      { x: 294, y: 594 },
      { x: 188, y: 594 },
    ],
  },
  {
    bone: "rightUpperLeg",
    start: "rightHip",
    end: "rightKnee",
    mask: [
      { x: 298, y: 438 },
      { x: 397, y: 438 },
      { x: 412, y: 594 },
      { x: 306, y: 594 },
    ],
  },
  {
    bone: "leftLowerArm",
    start: "leftElbow",
    end: "leftWrist",
    mask: [
      { x: 169, y: 321 },
      { x: 232, y: 321 },
      { x: 220, y: 467 },
      { x: 148, y: 467 },
    ],
  },
  {
    bone: "rightLowerArm",
    start: "rightElbow",
    end: "rightWrist",
    mask: [
      { x: 368, y: 321 },
      { x: 431, y: 321 },
      { x: 452, y: 467 },
      { x: 380, y: 467 },
    ],
  },
  {
    bone: "leftUpperArm",
    start: "leftShoulder",
    end: "leftElbow",
    mask: [
      { x: 185, y: 210 },
      { x: 251, y: 210 },
      { x: 235, y: 367 },
      { x: 169, y: 367 },
    ],
  },
  {
    bone: "rightUpperArm",
    start: "rightShoulder",
    end: "rightElbow",
    mask: [
      { x: 349, y: 210 },
      { x: 415, y: 210 },
      { x: 431, y: 367 },
      { x: 365, y: 367 },
    ],
  },
];

const TORSO_MASK: readonly Point[] = [
  { x: 218, y: 188 },
  { x: 382, y: 188 },
  { x: 379, y: 446 },
  { x: 350, y: 503 },
  { x: 300, y: 489 },
  { x: 250, y: 503 },
  { x: 221, y: 446 },
];

function angleBetween(from: Point, to: Point) {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

function distance(from: Point, to: Point) {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

const REST_BONE_ANGLES = Object.fromEntries(
  DOLL_PARTS.map((part) => [
    part.bone,
    angleBetween(REST_JOINTS[part.start], REST_JOINTS[part.end]),
  ]),
) as Record<BoneName, number>;

function createRestPose(): DollPose {
  return {
    rotation: 0,
    scale: 1,
    x: 0,
    y: 0,
    headRotation: 0,
    boneAngles: { ...REST_BONE_ANGLES },
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function wrapAngle(angle: number) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function smoothAngle(current: number, target: number, amount: number) {
  return current + wrapAngle(target - current) * amount;
}

function visible(landmark?: PaperDollLandmark) {
  return Boolean(
    landmark &&
      Number.isFinite(landmark.x) &&
      Number.isFinite(landmark.y) &&
      (landmark.visibility ?? 1) > 0.35,
  );
}

function mirrored(landmark: PaperDollLandmark): Point {
  return { x: 1 - landmark.x, y: landmark.y };
}

function constrainedBoneAngle(
  start: PaperDollLandmark | undefined,
  end: PaperDollLandmark | undefined,
  bodyRotation: number,
  restAngle: number,
  maximumDelta: number,
) {
  if (!visible(start) || !visible(end)) return restAngle;
  const angle = wrapAngle(angleBetween(mirrored(start!), mirrored(end!)) - bodyRotation);
  return restAngle + clamp(wrapAngle(angle - restAngle), -maximumDelta, maximumDelta);
}

function poseFromLandmarks(landmarks?: readonly PaperDollLandmark[]): DollPose {
  const leftShoulder = landmarks?.[11];
  const rightShoulder = landmarks?.[12];
  const leftElbow = landmarks?.[13];
  const rightElbow = landmarks?.[14];
  const leftWrist = landmarks?.[15];
  const rightWrist = landmarks?.[16];
  const leftEar = landmarks?.[7];
  const rightEar = landmarks?.[8];
  const leftHip = landmarks?.[23];
  const rightHip = landmarks?.[24];
  const leftKnee = landmarks?.[25];
  const rightKnee = landmarks?.[26];
  const leftAnkle = landmarks?.[27];
  const rightAnkle = landmarks?.[28];

  if (!visible(leftShoulder) || !visible(rightShoulder)) return createRestPose();

  const mirroredLeftShoulder = mirrored(leftShoulder!);
  const mirroredRightShoulder = mirrored(rightShoulder!);
  const shoulderCenter = {
    x: (mirroredLeftShoulder.x + mirroredRightShoulder.x) / 2,
    y: (mirroredLeftShoulder.y + mirroredRightShoulder.y) / 2,
  };
  const shoulderWidth = distance(mirroredLeftShoulder, mirroredRightShoulder);
  const rotation = clamp(
    angleBetween(mirroredLeftShoulder, mirroredRightShoulder),
    -0.34,
    0.34,
  );

  let bodyCenter = shoulderCenter;
  if (visible(leftHip) && visible(rightHip)) {
    const hipCenter = {
      x: (mirrored(leftHip!).x + mirrored(rightHip!).x) / 2,
      y: (leftHip!.y + rightHip!.y) / 2,
    };
    bodyCenter = {
      x: (shoulderCenter.x * 2 + hipCenter.x) / 3,
      y: (shoulderCenter.y * 2 + hipCenter.y) / 3,
    };
  }

  const boneAngles: Record<BoneName, number> = {
    leftUpperArm: constrainedBoneAngle(
      leftShoulder,
      leftElbow,
      rotation,
      REST_BONE_ANGLES.leftUpperArm,
      Math.PI * 0.92,
    ),
    leftLowerArm: constrainedBoneAngle(
      leftElbow,
      leftWrist,
      rotation,
      REST_BONE_ANGLES.leftLowerArm,
      Math.PI * 0.92,
    ),
    rightUpperArm: constrainedBoneAngle(
      rightShoulder,
      rightElbow,
      rotation,
      REST_BONE_ANGLES.rightUpperArm,
      Math.PI * 0.92,
    ),
    rightLowerArm: constrainedBoneAngle(
      rightElbow,
      rightWrist,
      rotation,
      REST_BONE_ANGLES.rightLowerArm,
      Math.PI * 0.92,
    ),
    leftUpperLeg: constrainedBoneAngle(
      leftHip,
      leftKnee,
      rotation,
      REST_BONE_ANGLES.leftUpperLeg,
      1.15,
    ),
    leftLowerLeg: constrainedBoneAngle(
      leftKnee,
      leftAnkle,
      rotation,
      REST_BONE_ANGLES.leftLowerLeg,
      1.15,
    ),
    rightUpperLeg: constrainedBoneAngle(
      rightHip,
      rightKnee,
      rotation,
      REST_BONE_ANGLES.rightUpperLeg,
      1.15,
    ),
    rightLowerLeg: constrainedBoneAngle(
      rightKnee,
      rightAnkle,
      rotation,
      REST_BONE_ANGLES.rightLowerLeg,
      1.15,
    ),
  };

  let headRotation = 0;
  if (visible(leftEar) && visible(rightEar)) {
    headRotation = clamp(
      wrapAngle(angleBetween(mirrored(leftEar!), mirrored(rightEar!)) - rotation),
      -0.45,
      0.45,
    );
  }

  return {
    rotation,
    scale: clamp(shoulderWidth / 0.27, 0.88, 1.12),
    x: clamp(bodyCenter.x - 0.5, -0.14, 0.14),
    y: clamp(bodyCenter.y - 0.42, -0.09, 0.09),
    headRotation,
    boneAngles,
  };
}

function blendPose(current: DollPose, next: DollPose): DollPose {
  const boneAngles = { ...current.boneAngles };
  for (const bone of Object.keys(boneAngles) as BoneName[]) {
    boneAngles[bone] = smoothAngle(current.boneAngles[bone], next.boneAngles[bone], 0.42);
  }

  return {
    rotation: smoothAngle(current.rotation, next.rotation, 0.3),
    scale: current.scale * 0.72 + next.scale * 0.28,
    x: current.x * 0.7 + next.x * 0.3,
    y: current.y * 0.7 + next.y * 0.3,
    headRotation: smoothAngle(current.headRotation, next.headRotation, 0.34),
    boneAngles,
  };
}

function extend(start: Point, angle: number, length: number): Point {
  return {
    x: start.x + Math.cos(angle) * length,
    y: start.y + Math.sin(angle) * length,
  };
}

function targetJointsForPose(pose: DollPose): Record<JointName, Point> {
  const target = Object.fromEntries(
    Object.entries(REST_JOINTS).map(([name, point]) => [name, { ...point }]),
  ) as Record<JointName, Point>;

  target.leftElbow = extend(
    target.leftShoulder,
    pose.boneAngles.leftUpperArm,
    distance(REST_JOINTS.leftShoulder, REST_JOINTS.leftElbow),
  );
  target.leftWrist = extend(
    target.leftElbow,
    pose.boneAngles.leftLowerArm,
    distance(REST_JOINTS.leftElbow, REST_JOINTS.leftWrist),
  );
  target.rightElbow = extend(
    target.rightShoulder,
    pose.boneAngles.rightUpperArm,
    distance(REST_JOINTS.rightShoulder, REST_JOINTS.rightElbow),
  );
  target.rightWrist = extend(
    target.rightElbow,
    pose.boneAngles.rightLowerArm,
    distance(REST_JOINTS.rightElbow, REST_JOINTS.rightWrist),
  );
  target.leftKnee = extend(
    target.leftHip,
    pose.boneAngles.leftUpperLeg,
    distance(REST_JOINTS.leftHip, REST_JOINTS.leftKnee),
  );
  target.leftAnkle = extend(
    target.leftKnee,
    pose.boneAngles.leftLowerLeg,
    distance(REST_JOINTS.leftKnee, REST_JOINTS.leftAnkle),
  );
  target.rightKnee = extend(
    target.rightHip,
    pose.boneAngles.rightUpperLeg,
    distance(REST_JOINTS.rightHip, REST_JOINTS.rightKnee),
  );
  target.rightAnkle = extend(
    target.rightKnee,
    pose.boneAngles.rightLowerLeg,
    distance(REST_JOINTS.rightKnee, REST_JOINTS.rightAnkle),
  );

  return target;
}

function clipPolygon(context: CanvasRenderingContext2D, points: readonly Point[]) {
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) {
    context.lineTo(points[index].x, points[index].y);
  }
  context.closePath();
  context.clip();
}

function polygonBounds(points: readonly Point[]) {
  const xValues = points.map((point) => point.x);
  const yValues = points.map((point) => point.y);
  const padding = 2;
  const minimumX = Math.floor(Math.min(...xValues) - padding);
  const minimumY = Math.floor(Math.min(...yValues) - padding);
  const maximumX = Math.ceil(Math.max(...xValues) + padding);
  const maximumY = Math.ceil(Math.max(...yValues) + padding);
  return {
    x: minimumX,
    y: minimumY,
    width: maximumX - minimumX,
    height: maximumY - minimumY,
  };
}

function createPolygonSprite(image: HTMLImageElement, points: readonly Point[]): RigSprite {
  const bounds = polygonBounds(points);
  const canvas = document.createElement("canvas");
  canvas.width = bounds.width;
  canvas.height = bounds.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("캐릭터 관절 이미지를 준비하지 못했습니다.");
  context.translate(-bounds.x, -bounds.y);
  clipPolygon(context, points);
  context.drawImage(image, 0, 0, ARTWORK_WIDTH, ARTWORK_HEIGHT);
  return { canvas, x: bounds.x, y: bounds.y };
}

function createHeadSprite(image: HTMLImageElement): RigSprite {
  const bounds = { x: 216, y: 6, width: 168, height: 208 };
  const canvas = document.createElement("canvas");
  canvas.width = bounds.width;
  canvas.height = bounds.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("캐릭터 머리 이미지를 준비하지 못했습니다.");
  context.translate(-bounds.x, -bounds.y);
  context.beginPath();
  context.ellipse(300, 111, 82, 101, 0, 0, Math.PI * 2);
  context.clip();
  context.drawImage(image, 0, 0, ARTWORK_WIDTH, ARTWORK_HEIGHT);
  return { canvas, x: bounds.x, y: bounds.y };
}

function createDollSprites(image: HTMLImageElement): DollSprites {
  const parts = Object.fromEntries(
    DOLL_PARTS.map((part) => [part.bone, createPolygonSprite(image, part.mask)]),
  ) as Record<BoneName, RigSprite>;
  return {
    parts,
    torso: createPolygonSprite(image, TORSO_MASK),
    head: createHeadSprite(image),
  };
}

function drawSegment(
  context: CanvasRenderingContext2D,
  sprite: RigSprite,
  part: RigPart,
  targets: Record<JointName, Point>,
) {
  const restStart = REST_JOINTS[part.start];
  const restEnd = REST_JOINTS[part.end];
  const targetStart = targets[part.start];
  const targetEnd = targets[part.end];
  const sourceLength = distance(restStart, restEnd);
  const targetLength = distance(targetStart, targetEnd);

  context.save();
  context.translate(targetStart.x, targetStart.y);
  context.rotate(angleBetween(targetStart, targetEnd));
  context.scale(targetLength / sourceLength, 1);
  context.rotate(-angleBetween(restStart, restEnd));
  context.translate(-restStart.x, -restStart.y);
  context.drawImage(sprite.canvas, sprite.x, sprite.y);
  context.restore();
}

function drawTorso(context: CanvasRenderingContext2D, sprite: RigSprite) {
  context.drawImage(sprite.canvas, sprite.x, sprite.y);
}

function drawHead(
  context: CanvasRenderingContext2D,
  sprite: RigSprite,
  rotation: number,
) {
  const neck = { x: 300, y: 202 };
  context.save();
  context.translate(neck.x, neck.y);
  context.rotate(rotation);
  context.translate(-neck.x, -neck.y);
  context.drawImage(sprite.canvas, sprite.x, sprite.y);
  context.restore();
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("캐릭터 PNG를 만들지 못했습니다."));
    }, "image/png");
  });
}

function findOpaqueBounds(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("캐릭터 범위를 계산하지 못했습니다.");

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let minimumX = canvas.width;
  let minimumY = canvas.height;
  let maximumX = -1;
  let maximumY = -1;

  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      if (pixels[(y * canvas.width + x) * 4 + 3] === 0) continue;
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
    }
  }

  if (maximumX < minimumX || maximumY < minimumY) {
    throw new Error("저장할 캐릭터 그림이 비어 있습니다.");
  }

  return {
    x: minimumX,
    y: minimumY,
    width: maximumX - minimumX + 1,
    height: maximumY - minimumY + 1,
  };
}

export const PaperDollStage = forwardRef<PaperDollStageHandle, PaperDollStageProps>(
  function PaperDollStage({ artwork, className }, ref) {
    const hostRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const imageRef = useRef<HTMLImageElement | null>(null);
    const spritesRef = useRef<DollSprites | null>(null);
    const poseRef = useRef<DollPose>(createRestPose());
    const manualRotationRef = useRef(0);
    const manualPanRef = useRef<Point>({ x: 0, y: 0 });
    const panGestureRef = useRef<{
      pointerId: number;
      startX: number;
      startY: number;
      origin: Point;
    } | null>(null);

    const drawTo = useCallback(
      (
        canvas: HTMLCanvasElement,
        width: number,
        height: number,
        quality: ImageSmoothingQuality = "medium",
        captureSafe = false,
      ) => {
        const context = canvas.getContext("2d");
        const image = imageRef.current;
        const sprites = spritesRef.current;
        if (
          !context ||
          !image ||
          !sprites ||
          !image.complete ||
          image.naturalWidth === 0
        ) {
          return;
        }

        context.clearRect(0, 0, canvas.width, canvas.height);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = quality;

        const pose = poseRef.current;
        const baseScale = captureSafe
          ? Math.min(
              (width * 0.5) / ARTWORK_WIDTH,
              (height * 0.6) / ARTWORK_HEIGHT,
            )
          : Math.min(
              (width * 0.72) / ARTWORK_WIDTH,
              (height * 0.84) / ARTWORK_HEIGHT,
            );
        const scale = baseScale * (captureSafe ? 1 : pose.scale);
        const centerX = captureSafe
          ? width / 2
          : width / 2 + (pose.x + manualPanRef.current.x) * width;
        const centerY = captureSafe
          ? height / 2
          : height * 0.51 + (pose.y + manualPanRef.current.y) * height;
        const targets = targetJointsForPose(pose);

        context.save();
        context.translate(centerX, centerY);
        context.rotate(pose.rotation + manualRotationRef.current);
        context.scale(scale, scale);
        context.translate(-ARTWORK_CENTER.x, -ARTWORK_CENTER.y);

        for (const part of DOLL_PARTS) {
          drawSegment(context, sprites.parts[part.bone], part, targets);
        }
        drawTorso(context, sprites.torso);
        drawHead(context, sprites.head, pose.headRotation);

        context.restore();
      },
      [],
    );

    const redraw = useCallback(() => {
      const host = hostRef.current;
      const canvas = canvasRef.current;
      if (!host || !canvas) return;

      const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.round(host.clientWidth * pixelRatio));
      const height = Math.max(1, Math.round(host.clientHeight * pixelRatio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      drawTo(canvas, width, height, "medium");
    }, [drawTo]);

    useEffect(() => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => {
        spritesRef.current = createDollSprites(image);
        redraw();
      };
      imageRef.current = image;
      image.src = artwork;
      redraw();

      return () => {
        image.onload = null;
        if (imageRef.current === image) imageRef.current = null;
        spritesRef.current = null;
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
          poseRef.current = blendPose(poseRef.current, poseFromLandmarks(landmarks));
          redraw();
        },
        async capturePng(width = 1600, height = 2000) {
          if (
            !imageRef.current?.complete ||
            imageRef.current.naturalWidth === 0 ||
            !spritesRef.current
          ) {
            throw new Error("직접 그린 캐릭터를 아직 준비하고 있습니다.");
          }
          const scratch = document.createElement("canvas");
          scratch.width = width;
          scratch.height = height;
          drawTo(scratch, width, height, "high", true);

          const bounds = findOpaqueBounds(scratch);
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("캐릭터 PNG를 만들지 못했습니다.");

          const fittedScale = Math.min(
            (width * 0.86) / bounds.width,
            (height * 0.9) / bounds.height,
          );
          const fittedWidth = bounds.width * fittedScale;
          const fittedHeight = bounds.height * fittedScale;
          context.imageSmoothingEnabled = true;
          context.imageSmoothingQuality = "high";
          context.drawImage(
            scratch,
            bounds.x,
            bounds.y,
            bounds.width,
            bounds.height,
            (width - fittedWidth) / 2,
            (height - fittedHeight) / 2,
            fittedWidth,
            fittedHeight,
          );
          return canvasToBlob(canvas);
        },
        resetPose() {
          poseRef.current = createRestPose();
          manualRotationRef.current = 0;
          manualPanRef.current = { x: 0, y: 0 };
          redraw();
        },
        rotate(direction) {
          manualRotationRef.current = clamp(
            manualRotationRef.current + direction * 0.08,
            -0.3,
            0.3,
          );
          redraw();
        },
      }),
      [drawTo, redraw],
    );

    const beginPan = (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (event.pointerType !== "mouse" || event.button !== 1) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      panGestureRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        origin: { ...manualPanRef.current },
      };
    };

    const movePan = (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const gesture = panGestureRef.current;
      const host = hostRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId || !host) return;
      event.preventDefault();
      manualPanRef.current = {
        x: clamp(gesture.origin.x + (event.clientX - gesture.startX) / host.clientWidth, -0.24, 0.24),
        y: clamp(gesture.origin.y + (event.clientY - gesture.startY) / host.clientHeight, -0.2, 0.2),
      };
      redraw();
    };

    const endPan = (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const gesture = panGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      panGestureRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    };

    return (
      <div ref={hostRef} className={className} aria-label="직접 그린 관절 캐릭터 미리보기">
        <canvas
          ref={canvasRef}
          onPointerDown={beginPan}
          onPointerMove={movePan}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          onAuxClick={(event) => {
            if (event.button === 1) event.preventDefault();
          }}
          aria-label="가운데 마우스 버튼으로 이동할 수 있는 관절 캐릭터"
        />
      </div>
    );
  },
);

PaperDollStage.displayName = "PaperDollStage";

export default PaperDollStage;
