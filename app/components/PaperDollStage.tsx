"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  getPaperDollMotionPreset,
  PaperDollMotionPlayer,
  type PaperDollExpression,
  type PaperDollMotionPresetId,
  type PaperDollMotionSample,
} from "../lib/paperDollMotion";

export type PaperDollLandmark = {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
};

export type DollExpression = {
  blink: number;
  blinkLeft: number;
  blinkRight: number;
  mouthOpen: number;
  jawOpen: number;
  smile: number;
  browUp: number;
  browUpLeft: number;
  browUpRight: number;
  lookX: number;
  lookY: number;
};

export const DOLL_MOTION_PRESETS = [
  { id: "idle", label: "숨쉬기" },
  { id: "walk", label: "제자리 걷기" },
  { id: "dance", label: "신나는 춤" },
  { id: "greeting", label: "손 흔들기" },
] as const satisfies readonly {
  id: PaperDollMotionPresetId;
  label: string;
}[];

export type PaperDollStageHandle = {
  applyPose: (landmarks?: readonly PaperDollLandmark[]) => void;
  applyTracking: (
    poseLandmarks?: readonly PaperDollLandmark[],
    faceLandmarks?: readonly PaperDollLandmark[],
  ) => void;
  playPreset: (preset: PaperDollMotionPresetId) => void;
  pauseAnimation: () => void;
  stopAnimation: () => void;
  setAnimationSpeed: (speed: number) => void;
  setLegsLocked: (locked: boolean) => void;
  getCanvas: () => HTMLCanvasElement | null;
  capturePng: (width?: number, height?: number) => Promise<Blob>;
  resetPose: () => void;
  rotate: (direction: -1 | 1) => void;
};

export type PaperDollStageProps = {
  artwork: string;
  backgroundColor?: string;
  backgroundImage?: CanvasImageSource | null;
  backgroundFit?: "cover" | "contain";
  className?: string;
  onAnimationPlayingChange?: (playing: boolean) => void;
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

const LEG_BONES = [
  "leftUpperLeg",
  "leftLowerLeg",
  "rightUpperLeg",
  "rightLowerLeg",
] as const satisfies readonly BoneName[];

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

type MeshVertex = {
  source: Point;
  upperWeight: number;
};

type MeshTriangle = readonly [MeshVertex, MeshVertex, MeshVertex];

type LimbMesh = {
  sprite: RigSprite;
  upperBone: BoneName;
  lowerBone: BoneName;
  triangles: readonly MeshTriangle[];
};

type DollSprites = {
  limbs: readonly LimbMesh[];
  torso: RigSprite;
  headBase: RigSprite;
  face: RigSprite;
};

const ARTWORK_WIDTH = 600;
const ARTWORK_HEIGHT = 760;
const ARTWORK_CENTER = { x: ARTWORK_WIDTH / 2, y: ARTWORK_HEIGHT / 2 };
const ARTWORK_OWNERS = [
  "head",
  "leftArm",
  "rightArm",
  "leftLeg",
  "rightLeg",
  "torso",
] as const;
type ArtworkOwner = (typeof ARTWORK_OWNERS)[number];
type OwnedSprites = Record<ArtworkOwner, RigSprite>;
const OWNER_SEAM_BLEED_PX = 8;
const FACE_REGION = { x: 236, y: 60, width: 128, height: 140 } as const;
const FACE_MESH_X = [236, 252, 264, 276, 288, 300, 312, 324, 336, 348, 364] as const;
const FACE_MESH_Y = [60, 78, 90, 100, 110, 120, 134, 146, 156, 170, 184, 200] as const;
let artworkOwnerMapCache: Uint8Array | null = null;

const NEUTRAL_EXPRESSION: DollExpression = {
  blink: 0,
  blinkLeft: 0,
  blinkRight: 0,
  mouthOpen: 0,
  jawOpen: 0,
  smile: 0,
  browUp: 0,
  browUpLeft: 0,
  browUpRight: 0,
  lookX: 0,
  lookY: 0,
};

const REST_JOINTS: Record<JointName, Point> = {
  leftShoulder: { x: 221, y: 238 },
  leftElbow: { x: 126, y: 238 },
  leftWrist: { x: 42, y: 238 },
  rightShoulder: { x: 379, y: 238 },
  rightElbow: { x: 474, y: 238 },
  rightWrist: { x: 558, y: 238 },
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
      { x: 18, y: 202 },
      { x: 145, y: 202 },
      { x: 145, y: 274 },
      { x: 18, y: 274 },
    ],
  },
  {
    bone: "rightLowerArm",
    start: "rightElbow",
    end: "rightWrist",
    mask: [
      { x: 455, y: 202 },
      { x: 582, y: 202 },
      { x: 582, y: 274 },
      { x: 455, y: 274 },
    ],
  },
  {
    bone: "leftUpperArm",
    start: "leftShoulder",
    end: "leftElbow",
    mask: [
      { x: 112, y: 202 },
      { x: 243, y: 202 },
      { x: 243, y: 274 },
      { x: 112, y: 274 },
    ],
  },
  {
    bone: "rightUpperArm",
    start: "rightShoulder",
    end: "rightElbow",
    mask: [
      { x: 357, y: 202 },
      { x: 488, y: 202 },
      { x: 488, y: 274 },
      { x: 357, y: 274 },
    ],
  },
];

const LIMB_CHAINS = [
  { owner: "leftArm", upperBone: "leftUpperArm", lowerBone: "leftLowerArm" },
  { owner: "rightArm", upperBone: "rightUpperArm", lowerBone: "rightLowerArm" },
  { owner: "leftLeg", upperBone: "leftUpperLeg", lowerBone: "leftLowerLeg" },
  { owner: "rightLeg", upperBone: "rightUpperLeg", lowerBone: "rightLowerLeg" },
] as const satisfies readonly {
  owner: ArtworkOwner;
  upperBone: BoneName;
  lowerBone: BoneName;
}[];

function getRigPart(bone: BoneName) {
  const part = DOLL_PARTS.find((candidate) => candidate.bone === bone);
  if (!part) throw new Error(`캐릭터 뼈대 ${bone} 구성을 찾지 못했습니다.`);
  return part;
}

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

function landmarkDistance(
  landmarks: readonly PaperDollLandmark[],
  first: number,
  second: number,
) {
  const a = landmarks[first];
  const b = landmarks[second];
  if (!a || !b) return 0;
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function expressionFromFaceLandmarks(
  landmarks?: readonly PaperDollLandmark[],
): DollExpression {
  if (!landmarks || landmarks.length < 455) return { ...NEUTRAL_EXPRESSION };

  const leftEyeWidth = landmarkDistance(landmarks, 33, 133);
  const rightEyeWidth = landmarkDistance(landmarks, 362, 263);
  const leftEyeOpen = leftEyeWidth
    ? landmarkDistance(landmarks, 159, 145) / leftEyeWidth
    : 0.3;
  const rightEyeOpen = rightEyeWidth
    ? landmarkDistance(landmarks, 386, 374) / rightEyeWidth
    : 0.3;
  const blinkLeft = clamp((0.22 - leftEyeOpen) / 0.15, 0, 1);
  const blinkRight = clamp((0.22 - rightEyeOpen) / 0.15, 0, 1);

  const mouthWidth = landmarkDistance(landmarks, 78, 308);
  const mouthOpenRatio = mouthWidth
    ? landmarkDistance(landmarks, 13, 14) / mouthWidth
    : 0;
  const faceWidth = landmarkDistance(landmarks, 234, 454) || mouthWidth * 2.8;
  const smileRatio = faceWidth ? mouthWidth / faceWidth : 0.3;
  const normalizedFaceWidth = Math.max(faceWidth, 0.001);
  const leftBrowRatio = landmarkDistance(landmarks, 105, 159) / normalizedFaceWidth;
  const rightBrowRatio = landmarkDistance(landmarks, 334, 386) / normalizedFaceWidth;
  const browUpLeft = clamp((leftBrowRatio - 0.035) / 0.055, 0, 1);
  const browUpRight = clamp((rightBrowRatio - 0.035) / 0.055, 0, 1);
  const mouthOpen = clamp((mouthOpenRatio - 0.04) / 0.42, 0, 1);
  const lowerJawRatio =
    landmarkDistance(landmarks, 14, 152) / normalizedFaceWidth;
  const jawFromChin = clamp((lowerJawRatio - 0.17) / 0.2, 0, 1);
  const jawOpen = clamp(mouthOpen * 0.82 + jawFromChin * 0.18, 0, 1);
  const upperLip = landmarks[13];
  const lowerLip = landmarks[14];
  const leftMouthCorner = landmarks[61];
  const rightMouthCorner = landmarks[291];
  const mouthCenterY =
    upperLip && lowerLip ? (upperLip.y + lowerLip.y) / 2 : 0;
  const mouthCornerY =
    leftMouthCorner && rightMouthCorner
      ? (leftMouthCorner.y + rightMouthCorner.y) / 2
      : mouthCenterY;
  const cornerLift = (mouthCenterY - mouthCornerY) / normalizedFaceWidth;
  const smile = clamp(
    (smileRatio - 0.28) / 0.16 + clamp((cornerLift - 0.004) / 0.045, 0, 1) * 0.35,
    0,
    1,
  );

  let lookX = 0;
  let lookY = 0;
  const leftIris = landmarks[468];
  const leftEyeOuter = landmarks[33];
  const leftEyeInner = landmarks[133];
  if (leftIris && leftEyeOuter && leftEyeInner) {
    const eyeCenterX = (leftEyeOuter.x + leftEyeInner.x) / 2;
    const eyeCenterY = (leftEyeOuter.y + leftEyeInner.y) / 2;
    const eyeSpan = Math.max(0.001, leftEyeWidth);
    lookX = clamp((leftIris.x - eyeCenterX) / eyeSpan * 3, -1, 1);
    lookY = clamp((leftIris.y - eyeCenterY) / eyeSpan * 4, -1, 1);
  }

  return {
    blink: (blinkLeft + blinkRight) / 2,
    blinkLeft,
    blinkRight,
    mouthOpen,
    jawOpen,
    smile,
    browUp: (browUpLeft + browUpRight) / 2,
    browUpLeft,
    browUpRight,
    lookX,
    lookY,
  };
}

function expressionFromMotion(expression: PaperDollExpression): DollExpression {
  return {
    blink: (expression.blinkLeft + expression.blinkRight) / 2,
    blinkLeft: expression.blinkLeft,
    blinkRight: expression.blinkRight,
    mouthOpen: expression.mouthOpen,
    jawOpen: expression.mouthOpen * 0.82,
    smile: expression.smile,
    browUp: expression.browUp,
    browUpLeft: expression.browUp,
    browUpRight: expression.browUp,
    lookX: expression.lookX,
    lookY: expression.lookY,
  };
}

function blendExpression(
  current: DollExpression,
  next: DollExpression,
  amount = 0.38,
): DollExpression {
  return {
    blink: current.blink + (next.blink - current.blink) * amount,
    blinkLeft: current.blinkLeft + (next.blinkLeft - current.blinkLeft) * amount,
    blinkRight:
      current.blinkRight + (next.blinkRight - current.blinkRight) * amount,
    mouthOpen: current.mouthOpen + (next.mouthOpen - current.mouthOpen) * amount,
    jawOpen: current.jawOpen + (next.jawOpen - current.jawOpen) * amount,
    smile: current.smile + (next.smile - current.smile) * amount,
    browUp: current.browUp + (next.browUp - current.browUp) * amount,
    browUpLeft:
      current.browUpLeft + (next.browUpLeft - current.browUpLeft) * amount,
    browUpRight:
      current.browUpRight + (next.browUpRight - current.browUpRight) * amount,
    lookX: current.lookX + (next.lookX - current.lookX) * amount,
    lookY: current.lookY + (next.lookY - current.lookY) * amount,
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

function distanceToSegment(point: Point, start: Point, end: Point) {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared === 0) return distance(point, start);
  const amount = clamp(
    ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) /
      lengthSquared,
    0,
    1,
  );
  return Math.hypot(
    point.x - (start.x + deltaX * amount),
    point.y - (start.y + deltaY * amount),
  );
}

function pointInPolygon(point: Point, polygon: readonly Point[]) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index];
    const b = polygon[previous];
    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || 0.0001) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distanceToPolygon(point: Point, polygon: readonly Point[]) {
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length; index += 1) {
    minimum = Math.min(
      minimum,
      distanceToSegment(
        point,
        polygon[index],
        polygon[(index + 1) % polygon.length],
      ),
    );
  }
  return pointInPolygon(point, polygon) ? -minimum : minimum;
}

function distanceToPolygons(
  point: Point,
  polygons: readonly (readonly Point[])[],
) {
  let minimum = Number.POSITIVE_INFINITY;
  for (const polygon of polygons) {
    minimum = Math.min(minimum, distanceToPolygon(point, polygon));
  }
  return minimum;
}

function distanceToHead(point: Point) {
  const radiusX = 82;
  const radiusY = 101;
  const offsetX = point.x - 300;
  const offsetY = point.y - 111;
  const normalized = Math.hypot(offsetX / radiusX, offsetY / radiusY);
  if (normalized === 0) return -Math.min(radiusX, radiusY);
  const boundaryScale = 1 / normalized;
  const boundaryDistance = Math.hypot(
    offsetX - offsetX * boundaryScale,
    offsetY - offsetY * boundaryScale,
  );
  return normalized < 1 ? -boundaryDistance : boundaryDistance;
}

const ARTWORK_OWNER_POLYGONS = {
  leftArm: [
    getRigPart("leftUpperArm").mask,
    getRigPart("leftLowerArm").mask,
  ],
  rightArm: [
    getRigPart("rightUpperArm").mask,
    getRigPart("rightLowerArm").mask,
  ],
  leftLeg: [
    getRigPart("leftUpperLeg").mask,
    getRigPart("leftLowerLeg").mask,
  ],
  rightLeg: [
    getRigPart("rightUpperLeg").mask,
    getRigPart("rightLowerLeg").mask,
  ],
  torso: [TORSO_MASK],
} as const satisfies Record<
  Exclude<ArtworkOwner, "head">,
  readonly (readonly Point[])[]
>;

/**
 * Build a stable nearest-part map once. Each opaque artwork pixel uses this map,
 * so painted sleeves, skirts, hair, and props outside the body guide survive as
 * part of the closest animated region instead of being clipped away.
 */
function getArtworkOwnerMap() {
  if (artworkOwnerMapCache) return artworkOwnerMapCache;

  const owners = new Uint8Array(ARTWORK_WIDTH * ARTWORK_HEIGHT);
  for (let y = 0; y < ARTWORK_HEIGHT; y += 1) {
    for (let x = 0; x < ARTWORK_WIDTH; x += 1) {
      const point = { x: x + 0.5, y: y + 0.5 };
      let bestOwnerIndex = 0;
      let bestDistance = distanceToHead(point);
      let secondOwnerIndex = -1;
      let secondDistance = Number.POSITIVE_INFINITY;
      for (let index = 1; index < ARTWORK_OWNERS.length; index += 1) {
        const owner = ARTWORK_OWNERS[index];
        if (owner === "head") continue;
        const candidateDistance = distanceToPolygons(
          point,
          ARTWORK_OWNER_POLYGONS[owner],
        );
        if (candidateDistance < bestDistance - 0.001) {
          secondDistance = bestDistance;
          secondOwnerIndex = bestOwnerIndex;
          bestDistance = candidateDistance;
          bestOwnerIndex = index;
        } else if (candidateDistance < secondDistance - 0.001) {
          secondDistance = candidateDistance;
          secondOwnerIndex = index;
        }
      }
      let ownerMask = 1 << bestOwnerIndex;
      if (
        secondOwnerIndex >= 0 &&
        secondDistance - bestDistance <= OWNER_SEAM_BLEED_PX
      ) {
        ownerMask |= 1 << secondOwnerIndex;
      }
      owners[y * ARTWORK_WIDTH + x] = ownerMask;
    }
  }
  artworkOwnerMapCache = owners;
  return owners;
}

type MutableBounds = {
  minimumX: number;
  minimumY: number;
  maximumX: number;
  maximumY: number;
};

function fallbackBounds(owner: ArtworkOwner) {
  if (owner === "head") return { x: 216, y: 6, width: 168, height: 208 };
  const polygons = ARTWORK_OWNER_POLYGONS[owner];
  const points = polygons.flat();
  const minimumX = Math.max(0, Math.floor(Math.min(...points.map(({ x }) => x)) - 2));
  const minimumY = Math.max(0, Math.floor(Math.min(...points.map(({ y }) => y)) - 2));
  const maximumX = Math.min(
    ARTWORK_WIDTH,
    Math.ceil(Math.max(...points.map(({ x }) => x)) + 2),
  );
  const maximumY = Math.min(
    ARTWORK_HEIGHT,
    Math.ceil(Math.max(...points.map(({ y }) => y)) + 2),
  );
  return {
    x: minimumX,
    y: minimumY,
    width: Math.max(1, maximumX - minimumX),
    height: Math.max(1, maximumY - minimumY),
  };
}

function createOwnedSprites(image: HTMLImageElement): OwnedSprites {
  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = ARTWORK_WIDTH;
  sourceCanvas.height = ARTWORK_HEIGHT;
  const sourceContext = sourceCanvas.getContext("2d", {
    willReadFrequently: true,
  });
  if (!sourceContext) throw new Error("캐릭터 픽셀을 분리하지 못했습니다.");
  sourceContext.drawImage(image, 0, 0, ARTWORK_WIDTH, ARTWORK_HEIGHT);
  const source = sourceContext.getImageData(0, 0, ARTWORK_WIDTH, ARTWORK_HEIGHT);
  const ownerMap = getArtworkOwnerMap();
  const bounds = ARTWORK_OWNERS.map<MutableBounds>(() => ({
    minimumX: ARTWORK_WIDTH,
    minimumY: ARTWORK_HEIGHT,
    maximumX: -1,
    maximumY: -1,
  }));

  for (let pixel = 0; pixel < ownerMap.length; pixel += 1) {
    if (source.data[pixel * 4 + 3] === 0) continue;
    const x = pixel % ARTWORK_WIDTH;
    const y = Math.floor(pixel / ARTWORK_WIDTH);
    for (let ownerIndex = 0; ownerIndex < ARTWORK_OWNERS.length; ownerIndex += 1) {
      if ((ownerMap[pixel] & (1 << ownerIndex)) === 0) continue;
      const ownerBounds = bounds[ownerIndex];
      ownerBounds.minimumX = Math.min(ownerBounds.minimumX, x);
      ownerBounds.minimumY = Math.min(ownerBounds.minimumY, y);
      ownerBounds.maximumX = Math.max(ownerBounds.maximumX, x);
      ownerBounds.maximumY = Math.max(ownerBounds.maximumY, y);
    }
  }

  return Object.fromEntries(
    ARTWORK_OWNERS.map((owner, ownerIndex) => {
      const measured = bounds[ownerIndex];
      const fallback = fallbackBounds(owner);
      const x = measured.maximumX >= measured.minimumX ? measured.minimumX : fallback.x;
      const y = measured.maximumY >= measured.minimumY ? measured.minimumY : fallback.y;
      const width =
        measured.maximumX >= measured.minimumX
          ? measured.maximumX - measured.minimumX + 1
          : fallback.width;
      const height =
        measured.maximumY >= measured.minimumY
          ? measured.maximumY - measured.minimumY + 1
          : fallback.height;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("캐릭터 파트 이미지를 준비하지 못했습니다.");
      const pixels = context.createImageData(width, height);

      for (let localY = 0; localY < height; localY += 1) {
        const sourceY = y + localY;
        if (sourceY < 0 || sourceY >= ARTWORK_HEIGHT) continue;
        for (let localX = 0; localX < width; localX += 1) {
          const sourceX = x + localX;
          if (sourceX < 0 || sourceX >= ARTWORK_WIDTH) continue;
          const sourcePixel = sourceY * ARTWORK_WIDTH + sourceX;
          if ((ownerMap[sourcePixel] & (1 << ownerIndex)) === 0) continue;
          const sourceOffset = sourcePixel * 4;
          const targetOffset = (localY * width + localX) * 4;
          pixels.data[targetOffset] = source.data[sourceOffset];
          pixels.data[targetOffset + 1] = source.data[sourceOffset + 1];
          pixels.data[targetOffset + 2] = source.data[sourceOffset + 2];
          pixels.data[targetOffset + 3] = source.data[sourceOffset + 3];
        }
      }
      context.putImageData(pixels, 0, 0);
      return [owner, { canvas, x, y } satisfies RigSprite] as const;
    }),
  ) as OwnedSprites;
}

function cellHasOpaquePixel(
  pixels: Uint8ClampedArray,
  canvasWidth: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
) {
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      if (pixels[(y * canvasWidth + x) * 4 + 3] > 0) return true;
    }
  }
  return false;
}

function createMeshVertex(
  source: Point,
  upperPart: RigPart,
  lowerPart: RigPart,
): MeshVertex {
  const upperDistance = distanceToSegment(
    source,
    REST_JOINTS[upperPart.start],
    REST_JOINTS[upperPart.end],
  );
  const lowerDistance = distanceToSegment(
    source,
    REST_JOINTS[lowerPart.start],
    REST_JOINTS[lowerPart.end],
  );
  const upperScore = 1 / Math.pow(upperDistance + 7, 3.2);
  const lowerScore = 1 / Math.pow(lowerDistance + 7, 3.2);
  return {
    source,
    upperWeight: upperScore / (upperScore + lowerScore),
  };
}

function createLimbMesh(
  sprite: RigSprite,
  upperBone: BoneName,
  lowerBone: BoneName,
): LimbMesh {
  const upperPart = getRigPart(upperBone);
  const lowerPart = getRigPart(lowerBone);
  const triangles: MeshTriangle[] = [];
  const spriteContext = sprite.canvas.getContext("2d", {
    willReadFrequently: true,
  });
  if (!spriteContext) throw new Error("캐릭터 관절 메시를 준비하지 못했습니다.");
  const spritePixels = spriteContext.getImageData(
    0,
    0,
    sprite.canvas.width,
    sprite.canvas.height,
  ).data;
  // A moderately coarse mesh keeps elbows and knees soft without turning each
  // 15 fps tracking update into hundreds of tiny high-cost canvas operations.
  const cell = 32;

  for (let localY = 0; localY < sprite.canvas.height; localY += cell) {
    for (let localX = 0; localX < sprite.canvas.width; localX += cell) {
      const localRight = Math.min(localX + cell, sprite.canvas.width);
      const localBottom = Math.min(localY + cell, sprite.canvas.height);
      if (
        !cellHasOpaquePixel(
          spritePixels,
          sprite.canvas.width,
          localX,
          localY,
          localRight,
          localBottom,
        )
      ) continue;
      const x = sprite.x + localX;
      const y = sprite.y + localY;
      const right = sprite.x + localRight;
      const bottom = sprite.y + localBottom;
      const topLeft = createMeshVertex({ x, y }, upperPart, lowerPart);
      const topRight = createMeshVertex({ x: right, y }, upperPart, lowerPart);
      const bottomLeft = createMeshVertex({ x, y: bottom }, upperPart, lowerPart);
      const bottomRight = createMeshVertex(
        { x: right, y: bottom },
        upperPart,
        lowerPart,
      );
      triangles.push([topLeft, topRight, bottomRight]);
      triangles.push([topLeft, bottomRight, bottomLeft]);
    }
  }

  return { sprite, upperBone, lowerBone, triangles };
}

function createFacialSprites(head: RigSprite) {
  const baseCanvas = document.createElement("canvas");
  baseCanvas.width = head.canvas.width;
  baseCanvas.height = head.canvas.height;
  const baseContext = baseCanvas.getContext("2d");
  if (!baseContext) throw new Error("머리 레이어를 준비하지 못했습니다.");
  baseContext.drawImage(head.canvas, 0, 0);

  const faceX = Math.max(head.x, FACE_REGION.x);
  const faceY = Math.max(head.y, FACE_REGION.y);
  const faceRight = Math.min(
    head.x + head.canvas.width,
    FACE_REGION.x + FACE_REGION.width,
  );
  const faceBottom = Math.min(
    head.y + head.canvas.height,
    FACE_REGION.y + FACE_REGION.height,
  );
  const faceWidth = Math.max(1, faceRight - faceX);
  const faceHeight = Math.max(1, faceBottom - faceY);
  const faceCanvas = document.createElement("canvas");
  faceCanvas.width = faceWidth;
  faceCanvas.height = faceHeight;
  const faceContext = faceCanvas.getContext("2d");
  if (!faceContext) throw new Error("표정 레이어를 준비하지 못했습니다.");

  if (faceRight > faceX && faceBottom > faceY) {
    const sourceX = faceX - head.x;
    const sourceY = faceY - head.y;
    faceContext.drawImage(
      head.canvas,
      sourceX,
      sourceY,
      faceWidth,
      faceHeight,
      0,
      0,
      faceWidth,
      faceHeight,
    );
    baseContext.clearRect(sourceX, sourceY, faceWidth, faceHeight);
  }

  return {
    base: { canvas: baseCanvas, x: head.x, y: head.y } satisfies RigSprite,
    face: { canvas: faceCanvas, x: faceX, y: faceY } satisfies RigSprite,
  };
}

function createDollSprites(image: HTMLImageElement): DollSprites {
  const sprites = createOwnedSprites(image);
  const head = createFacialSprites(sprites.head);
  return {
    limbs: LIMB_CHAINS.map(({ owner, upperBone, lowerBone }) =>
      createLimbMesh(sprites[owner], upperBone, lowerBone),
    ),
    torso: sprites.torso,
    headBase: head.base,
    face: head.face,
  };
}

type BoneTransform = {
  restStart: Point;
  targetStart: Point;
  restCosine: number;
  restSine: number;
  targetCosine: number;
  targetSine: number;
  lengthScale: number;
};

function createBoneTransform(
  part: RigPart,
  targets: Record<JointName, Point>,
): BoneTransform {
  const restStart = REST_JOINTS[part.start];
  const restEnd = REST_JOINTS[part.end];
  const targetStart = targets[part.start];
  const targetEnd = targets[part.end];
  const sourceLength = distance(restStart, restEnd);
  const targetLength = distance(targetStart, targetEnd);
  const restAngle = angleBetween(restStart, restEnd);
  const targetAngle = angleBetween(targetStart, targetEnd);
  return {
    restStart,
    targetStart,
    restCosine: Math.cos(-restAngle),
    restSine: Math.sin(-restAngle),
    targetCosine: Math.cos(targetAngle),
    targetSine: Math.sin(targetAngle),
    lengthScale: targetLength / sourceLength,
  };
}

function transformByBone(point: Point, transform: BoneTransform): Point {
  const offsetX = point.x - transform.restStart.x;
  const offsetY = point.y - transform.restStart.y;
  const along =
    (offsetX * transform.restCosine - offsetY * transform.restSine) *
    transform.lengthScale;
  const across = offsetX * transform.restSine + offsetY * transform.restCosine;
  return {
    x:
      transform.targetStart.x +
      along * transform.targetCosine -
      across * transform.targetSine,
    y:
      transform.targetStart.y +
      along * transform.targetSine +
      across * transform.targetCosine,
  };
}

function expandTriangle(points: readonly [Point, Point, Point], pixels = 0.65) {
  const center = {
    x: (points[0].x + points[1].x + points[2].x) / 3,
    y: (points[0].y + points[1].y + points[2].y) / 3,
  };
  return points.map((point) => {
    const length = Math.max(1, distance(center, point));
    return {
      x: center.x + (point.x - center.x) * (1 + pixels / length),
      y: center.y + (point.y - center.y) * (1 + pixels / length),
    };
  }) as [Point, Point, Point];
}

function drawTexturedTriangle(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  source: readonly [Point, Point, Point],
  destination: readonly [Point, Point, Point],
) {
  const [s0, s1, s2] = source;
  const [d0, d1, d2] = destination;
  const determinant =
    s0.x * (s1.y - s2.y) +
    s1.x * (s2.y - s0.y) +
    s2.x * (s0.y - s1.y);
  if (Math.abs(determinant) < 0.0001) return;

  const a =
    (d0.x * (s1.y - s2.y) +
      d1.x * (s2.y - s0.y) +
      d2.x * (s0.y - s1.y)) /
    determinant;
  const c =
    (d0.x * (s2.x - s1.x) +
      d1.x * (s0.x - s2.x) +
      d2.x * (s1.x - s0.x)) /
    determinant;
  const e =
    (d0.x * (s1.x * s2.y - s2.x * s1.y) +
      d1.x * (s2.x * s0.y - s0.x * s2.y) +
      d2.x * (s0.x * s1.y - s1.x * s0.y)) /
    determinant;
  const b =
    (d0.y * (s1.y - s2.y) +
      d1.y * (s2.y - s0.y) +
      d2.y * (s0.y - s1.y)) /
    determinant;
  const d =
    (d0.y * (s2.x - s1.x) +
      d1.y * (s0.x - s2.x) +
      d2.y * (s1.x - s0.x)) /
    determinant;
  const f =
    (d0.y * (s1.x * s2.y - s2.x * s1.y) +
      d1.y * (s2.x * s0.y - s0.x * s2.y) +
      d2.y * (s0.x * s1.y - s1.x * s0.y)) /
    determinant;

  context.save();
  const clip = expandTriangle([d0, d1, d2]);
  context.beginPath();
  context.moveTo(clip[0].x, clip[0].y);
  context.lineTo(clip[1].x, clip[1].y);
  context.lineTo(clip[2].x, clip[2].y);
  context.closePath();
  context.clip();
  context.transform(a, b, c, d, e, f);
  context.drawImage(image, 0, 0);
  context.restore();
}

function drawLimb(
  context: CanvasRenderingContext2D,
  mesh: LimbMesh,
  targets: Record<JointName, Point>,
) {
  const upperPart = getRigPart(mesh.upperBone);
  const lowerPart = getRigPart(mesh.lowerBone);
  const upperTransform = createBoneTransform(upperPart, targets);
  const lowerTransform = createBoneTransform(lowerPart, targets);
  for (const triangle of mesh.triangles) {
    const source = triangle.map((vertex) => ({
      x: vertex.source.x - mesh.sprite.x,
      y: vertex.source.y - mesh.sprite.y,
    })) as [Point, Point, Point];
    const destination = triangle.map((vertex) => {
      const upper = transformByBone(vertex.source, upperTransform);
      const lower = transformByBone(vertex.source, lowerTransform);
      return {
        x: upper.x * vertex.upperWeight + lower.x * (1 - vertex.upperWeight),
        y: upper.y * vertex.upperWeight + lower.y * (1 - vertex.upperWeight),
      };
    }) as [Point, Point, Point];
    drawTexturedTriangle(context, mesh.sprite.canvas, source, destination);
  }
}

function drawTorso(context: CanvasRenderingContext2D, sprite: RigSprite) {
  context.drawImage(sprite.canvas, sprite.x, sprite.y);
}

function regionInfluence(
  point: Point,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
) {
  const normalized = Math.hypot(
    (point.x - centerX) / radiusX,
    (point.y - centerY) / radiusY,
  );
  if (normalized >= 1) return 0;
  const amount = 1 - normalized;
  return amount * amount * (3 - 2 * amount);
}

function warpFacialPoint(source: Point, expression: DollExpression): Point {
  const warped = { ...source };
  const applyEye = (centerX: number, blink: number) => {
    const influence = regionInfluence(source, centerX, 111, 27, 18);
    warped.y += (111 - source.y) * blink * influence * 0.94;
    warped.x += expression.lookX * 3 * influence * (1 - blink * 0.55);
    warped.y += expression.lookY * 1.8 * influence * (1 - blink * 0.55);
  };
  applyEye(270, expression.blinkLeft);
  applyEye(330, expression.blinkRight);

  const leftBrow = regionInfluence(source, 270, 88, 32, 15);
  const rightBrow = regionInfluence(source, 330, 88, 32, 15);
  warped.y -= expression.browUpLeft * leftBrow * 7;
  warped.y -= expression.browUpRight * rightBrow * 7;

  const mouthInfluence = regionInfluence(source, 300, 152, 62, 24);
  const lipAmount = clamp((source.y - 140) / 12, 0, 1);
  const mouthX = (source.x - 300) / 62;
  warped.x +=
    (source.x - 300) * expression.smile * mouthInfluence * lipAmount * 0.1;
  warped.y +=
    (source.y - 152) * expression.mouthOpen * mouthInfluence * lipAmount * 0.7 -
    Math.abs(mouthX) * expression.smile * mouthInfluence * lipAmount * 6.5;

  const jawInfluence = regionInfluence(source, 300, 169, 64, 31);
  const lowerFaceAmount = clamp((source.y - 150) / 42, 0, 1);
  warped.y += expression.jawOpen * jawInfluence * lowerFaceAmount * 11;
  warped.x +=
    (source.x - 300) * expression.jawOpen * jawInfluence * lowerFaceAmount * 0.018;
  return warped;
}

function meshAxis(
  spriteStart: number,
  spriteLength: number,
  anchors: readonly number[],
) {
  const points = new Set<number>([0, spriteLength]);
  const spriteEnd = spriteStart + spriteLength;
  for (const anchor of anchors) {
    if (anchor > spriteStart && anchor < spriteEnd) {
      points.add(anchor - spriteStart);
    }
  }
  return [...points].sort((left, right) => left - right);
}

function drawFacialFeatures(
  context: CanvasRenderingContext2D,
  sprite: RigSprite,
  expression: DollExpression,
) {
  const columns = meshAxis(sprite.x, sprite.canvas.width, FACE_MESH_X);
  const rows = meshAxis(sprite.y, sprite.canvas.height, FACE_MESH_Y);
  const warp = (local: Point) =>
    warpFacialPoint(
      { x: sprite.x + local.x, y: sprite.y + local.y },
      expression,
    );

  for (let row = 0; row < rows.length - 1; row += 1) {
    for (let column = 0; column < columns.length - 1; column += 1) {
      const left = columns[column];
      const right = columns[column + 1];
      const top = rows[row];
      const bottom = rows[row + 1];
      const a = { x: left, y: top };
      const b = { x: right, y: top };
      const c = { x: right, y: bottom };
      const d = { x: left, y: bottom };
      drawTexturedTriangle(
        context,
        sprite.canvas,
        [a, b, c],
        [warp(a), warp(b), warp(c)],
      );
      drawTexturedTriangle(
        context,
        sprite.canvas,
        [a, c, d],
        [warp(a), warp(c), warp(d)],
      );
    }
  }
}

function drawHead(
  context: CanvasRenderingContext2D,
  base: RigSprite,
  face: RigSprite,
  rotation: number,
  expression: DollExpression,
) {
  const neck = { x: 300, y: 202 };
  context.save();
  context.translate(neck.x, neck.y);
  context.rotate(rotation);
  context.translate(-neck.x, -neck.y);
  context.drawImage(base.canvas, base.x, base.y);
  drawFacialFeatures(context, face, expression);
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

function canvasImageSize(image: CanvasImageSource) {
  const source = image as {
    naturalWidth?: number;
    naturalHeight?: number;
    videoWidth?: number;
    videoHeight?: number;
    width?: number;
    height?: number;
  };
  const width = source.naturalWidth || source.videoWidth || source.width || 0;
  const height = source.naturalHeight || source.videoHeight || source.height || 0;
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

function drawFittedBackground(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  width: number,
  height: number,
  fit: "cover" | "contain",
) {
  const source = canvasImageSize(image);
  if (!source) return;
  const scale =
    fit === "contain"
      ? Math.min(width / source.width, height / source.height)
      : Math.max(width / source.width, height / source.height);
  const fittedWidth = source.width * scale;
  const fittedHeight = source.height * scale;
  context.drawImage(
    image,
    (width - fittedWidth) / 2,
    (height - fittedHeight) / 2,
    fittedWidth,
    fittedHeight,
  );
}

export const PaperDollStage = forwardRef<PaperDollStageHandle, PaperDollStageProps>(
  function PaperDollStage(
    {
      artwork,
      backgroundColor,
      backgroundImage,
      backgroundFit = "cover",
      className,
      onAnimationPlayingChange,
    },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const imageRef = useRef<HTMLImageElement | null>(null);
    const spritesRef = useRef<DollSprites | null>(null);
    const poseRef = useRef<DollPose>(createRestPose());
    const expressionRef = useRef<DollExpression>({ ...NEUTRAL_EXPRESSION });
    const motionPlayerRef = useRef<PaperDollMotionPlayer | null>(null);
    const lockedLegWorldAnglesRef = useRef<Partial<Record<BoneName, number>> | null>(
      null,
    );
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
        if (!captureSafe) {
          if (backgroundColor) {
            context.fillStyle = backgroundColor;
            context.fillRect(0, 0, canvas.width, canvas.height);
          }
          if (backgroundImage) {
            drawFittedBackground(
              context,
              backgroundImage,
              canvas.width,
              canvas.height,
              backgroundFit,
            );
          }
        }
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = quality;

        const pose = poseRef.current;
        const expression = expressionRef.current;
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

        for (const limb of sprites.limbs) {
          drawLimb(context, limb, targets);
        }
        drawTorso(context, sprites.torso);
        drawHead(
          context,
          sprites.headBase,
          sprites.face,
          pose.headRotation,
          expression,
        );

        context.restore();
      },
      [backgroundColor, backgroundFit, backgroundImage],
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

    useEffect(() => {
      const applyMotionSample = (sample: PaperDollMotionSample) => {
        poseRef.current = poseFromLandmarks(sample.landmarks);
        expressionRef.current = expressionFromMotion(sample.pose.expression);
        redraw();
      };
      const player = new PaperDollMotionPlayer({
        onFrame: applyMotionSample,
        onStateChange: (snapshot) =>
          onAnimationPlayingChange?.(snapshot.state === "playing"),
      });
      motionPlayerRef.current = player;
      player.load(getPaperDollMotionPreset("idle"), { autoplay: true, loop: true });

      return () => {
        player.dispose();
        if (motionPlayerRef.current === player) motionPlayerRef.current = null;
      };
    }, [onAnimationPlayingChange, redraw]);

    useImperativeHandle(
      ref,
      () => ({
        applyPose(landmarks) {
          motionPlayerRef.current?.pause();
          const nextPose = poseFromLandmarks(landmarks);
          const lockedAngles = lockedLegWorldAnglesRef.current;
          if (lockedAngles) {
            for (const bone of LEG_BONES) {
              const worldAngle = lockedAngles[bone];
              if (worldAngle !== undefined) {
                nextPose.boneAngles[bone] = wrapAngle(worldAngle - nextPose.rotation);
              }
            }
          }
          poseRef.current = blendPose(poseRef.current, nextPose);
          redraw();
        },
        applyTracking(poseLandmarks, faceLandmarks) {
          motionPlayerRef.current?.pause();
          const nextPose = poseFromLandmarks(poseLandmarks);
          const lockedAngles = lockedLegWorldAnglesRef.current;
          if (lockedAngles) {
            for (const bone of LEG_BONES) {
              const worldAngle = lockedAngles[bone];
              if (worldAngle !== undefined) {
                nextPose.boneAngles[bone] = wrapAngle(worldAngle - nextPose.rotation);
              }
            }
          }
          poseRef.current = blendPose(poseRef.current, nextPose);
          expressionRef.current = blendExpression(
            expressionRef.current,
            expressionFromFaceLandmarks(faceLandmarks),
          );
          redraw();
        },
        playPreset(preset) {
          const player = motionPlayerRef.current;
          if (!player) return;
          player.load(getPaperDollMotionPreset(preset), {
            autoplay: true,
            loop: preset !== "greeting",
          });
          requestAnimationFrame(() => redraw());
        },
        pauseAnimation() {
          motionPlayerRef.current?.pause();
          redraw();
        },
        stopAnimation() {
          motionPlayerRef.current?.stop();
          poseRef.current = createRestPose();
          expressionRef.current = { ...NEUTRAL_EXPRESSION };
          redraw();
        },
        setAnimationSpeed(speed) {
          motionPlayerRef.current?.setPlaybackRate(speed);
        },
        setLegsLocked(locked) {
          if (!locked) {
            lockedLegWorldAnglesRef.current = null;
            return;
          }
          const pose = poseRef.current;
          lockedLegWorldAnglesRef.current = Object.fromEntries(
            LEG_BONES.map((bone) => [bone, wrapAngle(pose.boneAngles[bone] + pose.rotation)]),
          ) as Partial<Record<BoneName, number>>;
        },
        getCanvas() {
          return canvasRef.current;
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
          motionPlayerRef.current?.pause();
          poseRef.current = createRestPose();
          expressionRef.current = { ...NEUTRAL_EXPRESSION };
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
      const middleMouse = event.pointerType === "mouse" && event.button === 1;
      const directTouch = event.pointerType === "touch" && event.isPrimary;
      if (!middleMouse && !directTouch) return;
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
          aria-label="가운데 마우스 버튼 또는 한 손가락으로 이동할 수 있는 관절 캐릭터"
        />
      </div>
    );
  },
);

PaperDollStage.displayName = "PaperDollStage";

export default PaperDollStage;
