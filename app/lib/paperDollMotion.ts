/**
 * Browser-only keyframe animation support for the 2D character stage.
 *
 * The generated landmark list is structurally compatible with
 * `PaperDollStageHandle.applyPose`, so an integration only needs to forward
 * each sample:
 *
 *   const player = new PaperDollMotionPlayer({
 *     onFrame: ({ landmarks }) => paperDollRef.current?.applyPose(landmarks),
 *   });
 */

export type PaperDollMotionBone =
  | "leftUpperArm"
  | "leftLowerArm"
  | "rightUpperArm"
  | "rightLowerArm"
  | "leftUpperLeg"
  | "leftLowerLeg"
  | "rightUpperLeg"
  | "rightLowerLeg";

export interface PaperDollExpression {
  blinkLeft: number;
  blinkRight: number;
  smile: number;
  mouthOpen: number;
  browUp: number;
  lookX: number;
  lookY: number;
}

export interface PaperDollMotionPose {
  /** Horizontal stage offset in normalized camera coordinates. */
  x: number;
  /** Vertical stage offset in normalized camera coordinates. */
  y: number;
  /** Whole-character scale. A value of 1 is the authored size. */
  scale: number;
  /** Whole-character lean in radians. */
  rotation: number;
  /** Head angle relative to the torso in radians. */
  headRotation: number;
  /** Rotation deltas from PaperDollStage's standing rest pose. */
  boneRotations: Record<PaperDollMotionBone, number>;
  expression: PaperDollExpression;
}

export type PaperDollPosePatch = Partial<
  Omit<PaperDollMotionPose, "boneRotations" | "expression">
> & {
  boneRotations?: Partial<Record<PaperDollMotionBone, number>>;
  expression?: Partial<PaperDollExpression>;
};

export type PaperDollMotionEasing =
  | "linear"
  | "ease-in"
  | "ease-out"
  | "ease-in-out"
  | "step";

export interface PaperDollMotionKeyframe {
  /** Milliseconds from the beginning of the clip. */
  timeMs: number;
  pose: PaperDollPosePatch;
  /** Easing used while leaving this keyframe. */
  easing?: PaperDollMotionEasing;
}

export interface PaperDollMotionClip {
  id: string;
  name: string;
  durationMs: number;
  loop: boolean;
  keyframes: readonly PaperDollMotionKeyframe[];
}

export interface PaperDollMotionLandmark {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
}

export interface PaperDollMotionSample {
  clipId: string;
  timeMs: number;
  progress: number;
  pose: PaperDollMotionPose;
  /** Compatible with `PaperDollStageHandle.applyPose`. */
  landmarks: readonly PaperDollMotionLandmark[];
}

export type PaperDollMotionPlayerState =
  | "idle"
  | "playing"
  | "paused"
  | "ended"
  | "disposed";

export interface PaperDollMotionPlayerSnapshot {
  clipId: string | null;
  state: PaperDollMotionPlayerState;
  positionMs: number;
  durationMs: number;
  playbackRate: number;
  loop: boolean;
}

export interface PaperDollMotionPlayerOptions {
  clip?: PaperDollMotionClip;
  playbackRate?: number;
  loop?: boolean;
  onFrame?: (sample: PaperDollMotionSample) => void;
  onStateChange?: (snapshot: PaperDollMotionPlayerSnapshot) => void;
  /** Test hook; regular callers should use the browser default. */
  requestFrame?: (callback: FrameRequestCallback) => number;
  /** Test hook; regular callers should use the browser default. */
  cancelFrame?: (handle: number) => void;
}

export interface LoadPaperDollMotionOptions {
  autoplay?: boolean;
  loop?: boolean;
  startAtMs?: number;
}

const BONE_NAMES: readonly PaperDollMotionBone[] = [
  "leftUpperArm",
  "leftLowerArm",
  "rightUpperArm",
  "rightLowerArm",
  "leftUpperLeg",
  "leftLowerLeg",
  "rightUpperLeg",
  "rightLowerLeg",
];

const REST_BONE_ANGLES: Readonly<Record<PaperDollMotionBone, number>> = {
  leftUpperArm: Math.atan2(112, -19),
  leftLowerArm: Math.atan2(92, -20),
  rightUpperArm: Math.atan2(112, 19),
  rightLowerArm: Math.atan2(92, 20),
  leftUpperLeg: Math.atan2(102, -32),
  leftLowerLeg: Math.atan2(132, -10),
  rightUpperLeg: Math.atan2(102, 32),
  rightLowerLeg: Math.atan2(132, 10),
};

export const NEUTRAL_PAPER_DOLL_EXPRESSION: Readonly<PaperDollExpression> = {
  blinkLeft: 0,
  blinkRight: 0,
  smile: 0,
  mouthOpen: 0,
  browUp: 0,
  lookX: 0,
  lookY: 0,
};

export const NEUTRAL_PAPER_DOLL_POSE: Readonly<PaperDollMotionPose> = {
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  headRotation: 0,
  boneRotations: {
    leftUpperArm: 0,
    leftLowerArm: 0,
    rightUpperArm: 0,
    rightLowerArm: 0,
    leftUpperLeg: 0,
    leftLowerLeg: 0,
    rightUpperLeg: 0,
    rightLowerLeg: 0,
  },
  expression: { ...NEUTRAL_PAPER_DOLL_EXPRESSION },
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function wrap(value: number, length: number) {
  return ((value % length) + length) % length;
}

function lerp(from: number, to: number, amount: number) {
  return from + (to - from) * amount;
}

function lerpAngle(from: number, to: number, amount: number) {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * amount;
}

function ease(amount: number, easing: PaperDollMotionEasing) {
  if (easing === "step") return 0;
  if (easing === "ease-in") return amount * amount;
  if (easing === "ease-out") return 1 - (1 - amount) * (1 - amount);
  if (easing === "ease-in-out") {
    return amount < 0.5
      ? 2 * amount * amount
      : 1 - Math.pow(-2 * amount + 2, 2) / 2;
  }
  return amount;
}

function resolvePose(patch: PaperDollPosePatch): PaperDollMotionPose {
  const boneRotations = { ...NEUTRAL_PAPER_DOLL_POSE.boneRotations };
  for (const bone of BONE_NAMES) {
    const value = patch.boneRotations?.[bone];
    if (value !== undefined) boneRotations[bone] = value;
  }

  return {
    x: patch.x ?? NEUTRAL_PAPER_DOLL_POSE.x,
    y: patch.y ?? NEUTRAL_PAPER_DOLL_POSE.y,
    scale: patch.scale ?? NEUTRAL_PAPER_DOLL_POSE.scale,
    rotation: patch.rotation ?? NEUTRAL_PAPER_DOLL_POSE.rotation,
    headRotation:
      patch.headRotation ?? NEUTRAL_PAPER_DOLL_POSE.headRotation,
    boneRotations,
    expression: {
      ...NEUTRAL_PAPER_DOLL_EXPRESSION,
      ...patch.expression,
    },
  };
}

function interpolatePose(
  from: PaperDollMotionPose,
  to: PaperDollMotionPose,
  amount: number,
): PaperDollMotionPose {
  const boneRotations = { ...from.boneRotations };
  for (const bone of BONE_NAMES) {
    boneRotations[bone] = lerpAngle(
      from.boneRotations[bone],
      to.boneRotations[bone],
      amount,
    );
  }

  return {
    x: lerp(from.x, to.x, amount),
    y: lerp(from.y, to.y, amount),
    scale: lerp(from.scale, to.scale, amount),
    rotation: lerpAngle(from.rotation, to.rotation, amount),
    headRotation: lerpAngle(from.headRotation, to.headRotation, amount),
    boneRotations,
    expression: {
      blinkLeft: lerp(from.expression.blinkLeft, to.expression.blinkLeft, amount),
      blinkRight: lerp(from.expression.blinkRight, to.expression.blinkRight, amount),
      smile: lerp(from.expression.smile, to.expression.smile, amount),
      mouthOpen: lerp(from.expression.mouthOpen, to.expression.mouthOpen, amount),
      browUp: lerp(from.expression.browUp, to.expression.browUp, amount),
      lookX: lerp(from.expression.lookX, to.expression.lookX, amount),
      lookY: lerp(from.expression.lookY, to.expression.lookY, amount),
    },
  };
}

function assertFiniteNumber(value: number, label: string) {
  if (!Number.isFinite(value)) throw new Error(`${label} 값이 올바르지 않습니다.`);
}

export function validatePaperDollMotionClip(clip: PaperDollMotionClip) {
  if (!clip.id.trim()) throw new Error("모션 ID가 비어 있습니다.");
  if (!clip.name.trim()) throw new Error("모션 이름이 비어 있습니다.");
  assertFiniteNumber(clip.durationMs, "모션 길이");
  if (clip.durationMs <= 0) throw new Error("모션 길이는 0보다 커야 합니다.");
  if (clip.keyframes.length === 0) throw new Error("모션 키프레임이 없습니다.");

  let previousTime = -1;
  for (const [index, keyframe] of clip.keyframes.entries()) {
    assertFiniteNumber(keyframe.timeMs, `${index + 1}번 키프레임 시간`);
    if (keyframe.timeMs < 0 || keyframe.timeMs > clip.durationMs) {
      throw new Error("키프레임 시간이 모션 길이 밖에 있습니다.");
    }
    if (keyframe.timeMs <= previousTime) {
      throw new Error("키프레임 시간은 오름차순이어야 합니다.");
    }
    previousTime = keyframe.timeMs;
  }
}

type SkeletonPoint = { x: number; y: number };

function extend(
  point: SkeletonPoint,
  angle: number,
  length: number,
): SkeletonPoint {
  return {
    x: point.x + Math.cos(angle) * length,
    y: point.y + Math.sin(angle) * length,
  };
}

function lineEndpoints(
  center: SkeletonPoint,
  width: number,
  rotation: number,
): [SkeletonPoint, SkeletonPoint] {
  const x = Math.cos(rotation) * width * 0.5;
  const y = Math.sin(rotation) * width * 0.5;
  return [
    { x: center.x - x, y: center.y - y },
    { x: center.x + x, y: center.y + y },
  ];
}

/**
 * Converts a keyframe pose into a synthetic MediaPipe Pose landmark list.
 * PaperDollStage already understands this format, so no component change is
 * required to preview a preset animation.
 */
export function paperDollPoseToLandmarks(
  pose: PaperDollMotionPose,
): readonly PaperDollMotionLandmark[] {
  const scale = clamp(pose.scale, 0.72, 1.3);
  const rotation = clamp(pose.rotation, -0.34, 0.34);
  const centerX = 0.5 + clamp(pose.x, -0.14, 0.14);
  const shoulderCenter = {
    x: centerX,
    y: 0.35 + clamp(pose.y, -0.09, 0.09),
  };
  const hipCenter = {
    x: centerX,
    y: 0.56 + clamp(pose.y, -0.09, 0.09),
  };

  const [leftShoulder, rightShoulder] = lineEndpoints(
    shoulderCenter,
    0.27 * scale,
    rotation,
  );
  const [leftHip, rightHip] = lineEndpoints(
    hipCenter,
    0.145 * scale,
    rotation,
  );

  const boneAngle = (bone: PaperDollMotionBone) =>
    rotation + REST_BONE_ANGLES[bone] + pose.boneRotations[bone];

  const leftElbow = extend(
    leftShoulder,
    boneAngle("leftUpperArm"),
    0.15 * scale,
  );
  const leftWrist = extend(
    leftElbow,
    boneAngle("leftLowerArm"),
    0.13 * scale,
  );
  const rightElbow = extend(
    rightShoulder,
    boneAngle("rightUpperArm"),
    0.15 * scale,
  );
  const rightWrist = extend(
    rightElbow,
    boneAngle("rightLowerArm"),
    0.13 * scale,
  );
  const leftKnee = extend(
    leftHip,
    boneAngle("leftUpperLeg"),
    0.15 * scale,
  );
  const leftAnkle = extend(
    leftKnee,
    boneAngle("leftLowerLeg"),
    0.18 * scale,
  );
  const rightKnee = extend(
    rightHip,
    boneAngle("rightUpperLeg"),
    0.15 * scale,
  );
  const rightAnkle = extend(
    rightKnee,
    boneAngle("rightLowerLeg"),
    0.18 * scale,
  );

  const earCenter = {
    x: shoulderCenter.x,
    y: shoulderCenter.y - 0.19 * scale,
  };
  const [leftEar, rightEar] = lineEndpoints(
    earCenter,
    0.1 * scale,
    rotation + clamp(pose.headRotation, -0.45, 0.45),
  );

  const landmarks: PaperDollMotionLandmark[] = Array.from(
    { length: 33 },
    () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0 }),
  );
  const set = (index: number, point: SkeletonPoint) => {
    // PaperDollStage mirrors camera x before solving the skeleton.
    landmarks[index] = { x: 1 - point.x, y: point.y, z: 0, visibility: 1 };
  };

  set(7, leftEar);
  set(8, rightEar);
  set(11, leftShoulder);
  set(12, rightShoulder);
  set(13, leftElbow);
  set(14, rightElbow);
  set(15, leftWrist);
  set(16, rightWrist);
  set(23, leftHip);
  set(24, rightHip);
  set(25, leftKnee);
  set(26, rightKnee);
  set(27, leftAnkle);
  set(28, rightAnkle);

  return landmarks;
}

export interface SamplePaperDollMotionOptions {
  loop?: boolean;
}

export function samplePaperDollMotion(
  clip: PaperDollMotionClip,
  requestedTimeMs: number,
  options: SamplePaperDollMotionOptions = {},
): PaperDollMotionSample {
  validatePaperDollMotionClip(clip);
  const shouldLoop = options.loop ?? clip.loop;
  const timeMs = shouldLoop
    ? wrap(requestedTimeMs, clip.durationMs)
    : clamp(requestedTimeMs, 0, clip.durationMs);

  let left = clip.keyframes[0];
  let right = clip.keyframes[clip.keyframes.length - 1];
  for (let index = 0; index < clip.keyframes.length - 1; index += 1) {
    const candidate = clip.keyframes[index + 1];
    if (timeMs <= candidate.timeMs) {
      left = clip.keyframes[index];
      right = candidate;
      break;
    }
    left = candidate;
  }

  let pose: PaperDollMotionPose;
  if (timeMs <= left.timeMs || left === right) {
    pose = resolvePose(left.pose);
  } else {
    const segmentLength = right.timeMs - left.timeMs;
    const amount = segmentLength <= 0 ? 0 : (timeMs - left.timeMs) / segmentLength;
    pose = interpolatePose(
      resolvePose(left.pose),
      resolvePose(right.pose),
      ease(clamp(amount, 0, 1), left.easing ?? "linear"),
    );
  }

  return {
    clipId: clip.id,
    timeMs,
    progress: clip.durationMs > 0 ? timeMs / clip.durationMs : 0,
    pose,
    landmarks: paperDollPoseToLandmarks(pose),
  };
}

const neutral = (): PaperDollPosePatch => ({
  boneRotations: {},
  expression: {},
});

export const PAPER_DOLL_MOTION_PRESETS = {
  idle: {
    id: "idle",
    name: "숨쉬기",
    durationMs: 2800,
    loop: true,
    keyframes: [
      { timeMs: 0, pose: neutral(), easing: "ease-in-out" },
      {
        timeMs: 1200,
        pose: {
          y: -0.012,
          scale: 1.012,
          rotation: 0.018,
          headRotation: -0.025,
          expression: { blinkLeft: 0.08, blinkRight: 0.08 },
        },
        easing: "ease-in-out",
      },
      { timeMs: 2200, pose: neutral(), easing: "ease-in-out" },
      {
        timeMs: 2320,
        pose: { expression: { blinkLeft: 0, blinkRight: 0 } },
        easing: "ease-in-out",
      },
      {
        timeMs: 2400,
        pose: { expression: { blinkLeft: 1, blinkRight: 1 } },
        easing: "ease-out",
      },
      {
        timeMs: 2490,
        pose: { expression: { blinkLeft: 0, blinkRight: 0 } },
        easing: "ease-in-out",
      },
      { timeMs: 2800, pose: neutral() },
    ],
  },
  walk: {
    id: "walk",
    name: "제자리 걷기",
    durationMs: 1200,
    loop: true,
    keyframes: [
      {
        timeMs: 0,
        pose: {
          y: 0,
          rotation: -0.025,
          boneRotations: {
            leftUpperArm: 0.42,
            leftLowerArm: 0.1,
            rightUpperArm: -0.42,
            rightLowerArm: -0.08,
            leftUpperLeg: -0.4,
            leftLowerLeg: 0.18,
            rightUpperLeg: 0.38,
            rightLowerLeg: -0.34,
          },
        },
        easing: "ease-in-out",
      },
      {
        timeMs: 300,
        pose: {
          y: -0.022,
          boneRotations: {
            leftUpperArm: 0,
            rightUpperArm: 0,
            leftUpperLeg: 0,
            leftLowerLeg: -0.2,
            rightUpperLeg: 0,
            rightLowerLeg: 0.2,
          },
        },
        easing: "ease-in-out",
      },
      {
        timeMs: 600,
        pose: {
          y: 0,
          rotation: 0.025,
          boneRotations: {
            leftUpperArm: -0.42,
            leftLowerArm: -0.08,
            rightUpperArm: 0.42,
            rightLowerArm: 0.1,
            leftUpperLeg: 0.38,
            leftLowerLeg: -0.34,
            rightUpperLeg: -0.4,
            rightLowerLeg: 0.18,
          },
        },
        easing: "ease-in-out",
      },
      {
        timeMs: 900,
        pose: {
          y: -0.022,
          boneRotations: {
            leftUpperArm: 0,
            rightUpperArm: 0,
            leftUpperLeg: 0,
            leftLowerLeg: 0.2,
            rightUpperLeg: 0,
            rightLowerLeg: -0.2,
          },
        },
        easing: "ease-in-out",
      },
      {
        timeMs: 1200,
        pose: {
          y: 0,
          rotation: -0.025,
          boneRotations: {
            leftUpperArm: 0.42,
            leftLowerArm: 0.1,
            rightUpperArm: -0.42,
            rightLowerArm: -0.08,
            leftUpperLeg: -0.4,
            leftLowerLeg: 0.18,
            rightUpperLeg: 0.38,
            rightLowerLeg: -0.34,
          },
        },
      },
    ],
  },
  dance: {
    id: "dance",
    name: "신나는 춤",
    durationMs: 2000,
    loop: true,
    keyframes: [
      {
        timeMs: 0,
        pose: {
          x: -0.025,
          y: 0,
          rotation: -0.12,
          headRotation: 0.08,
          boneRotations: {
            leftUpperArm: -1.35,
            leftLowerArm: -1.1,
            rightUpperArm: 0.75,
            rightLowerArm: 0.45,
            leftUpperLeg: -0.22,
            rightUpperLeg: 0.22,
          },
          expression: { smile: 0.9, mouthOpen: 0.18 },
        },
        easing: "ease-in-out",
      },
      {
        timeMs: 500,
        pose: {
          x: 0.025,
          y: -0.035,
          rotation: 0.12,
          headRotation: -0.08,
          boneRotations: {
            leftUpperArm: 0.75,
            leftLowerArm: 0.45,
            rightUpperArm: -1.35,
            rightLowerArm: -1.1,
            leftUpperLeg: 0.22,
            leftLowerLeg: -0.32,
            rightUpperLeg: -0.22,
          },
          expression: { smile: 1, mouthOpen: 0.28, browUp: 0.35 },
        },
        easing: "ease-in-out",
      },
      {
        timeMs: 1000,
        pose: {
          x: -0.025,
          y: 0,
          rotation: -0.12,
          headRotation: 0.08,
          boneRotations: {
            leftUpperArm: -1.35,
            leftLowerArm: -1.1,
            rightUpperArm: 0.75,
            rightLowerArm: 0.45,
            leftUpperLeg: -0.22,
            rightUpperLeg: 0.22,
            rightLowerLeg: -0.32,
          },
          expression: { smile: 0.9, mouthOpen: 0.18 },
        },
        easing: "ease-in-out",
      },
      {
        timeMs: 1500,
        pose: {
          x: 0.025,
          y: -0.035,
          rotation: 0.12,
          headRotation: -0.08,
          boneRotations: {
            leftUpperArm: 0.75,
            leftLowerArm: 0.45,
            rightUpperArm: -1.35,
            rightLowerArm: -1.1,
            leftUpperLeg: 0.22,
            rightUpperLeg: -0.22,
            rightLowerLeg: -0.32,
          },
          expression: {
            blinkLeft: 0.8,
            blinkRight: 0.8,
            smile: 1,
            mouthOpen: 0.28,
          },
        },
        easing: "ease-in-out",
      },
      {
        timeMs: 2000,
        pose: {
          x: -0.025,
          rotation: -0.12,
          headRotation: 0.08,
          boneRotations: {
            leftUpperArm: -1.35,
            leftLowerArm: -1.1,
            rightUpperArm: 0.75,
            rightLowerArm: 0.45,
            leftUpperLeg: -0.22,
            rightUpperLeg: 0.22,
          },
          expression: { smile: 0.9, mouthOpen: 0.18 },
        },
      },
    ],
  },
  greeting: {
    id: "greeting",
    name: "손 흔들어 인사",
    durationMs: 2800,
    loop: false,
    keyframes: [
      { timeMs: 0, pose: neutral(), easing: "ease-in-out" },
      {
        timeMs: 500,
        pose: {
          rotation: -0.035,
          headRotation: 0.08,
          boneRotations: {
            rightUpperArm: -1.65,
            rightLowerArm: -1.9,
          },
          expression: { smile: 0.75, browUp: 0.18 },
        },
        easing: "ease-in-out",
      },
      {
        timeMs: 900,
        pose: {
          rotation: -0.035,
          headRotation: 0.08,
          boneRotations: {
            rightUpperArm: -1.55,
            rightLowerArm: -2.35,
          },
          expression: { smile: 0.85, browUp: 0.22 },
        },
        easing: "ease-in-out",
      },
      {
        timeMs: 1300,
        pose: {
          rotation: -0.035,
          headRotation: 0.08,
          boneRotations: {
            rightUpperArm: -1.75,
            rightLowerArm: -1.65,
          },
          expression: { smile: 0.85, browUp: 0.22 },
        },
        easing: "ease-in-out",
      },
      {
        timeMs: 1700,
        pose: {
          rotation: -0.035,
          headRotation: 0.08,
          boneRotations: {
            rightUpperArm: -1.55,
            rightLowerArm: -2.35,
          },
          expression: {
            blinkLeft: 0.9,
            blinkRight: 0.9,
            smile: 0.9,
          },
        },
        easing: "ease-in-out",
      },
      {
        timeMs: 2100,
        pose: {
          rotation: -0.035,
          headRotation: 0.08,
          boneRotations: {
            rightUpperArm: -1.75,
            rightLowerArm: -1.65,
          },
          expression: { smile: 0.85 },
        },
        easing: "ease-in-out",
      },
      {
        timeMs: 2800,
        pose: neutral(),
      },
    ],
  },
} as const satisfies Record<string, PaperDollMotionClip>;

export type PaperDollMotionPresetId = keyof typeof PAPER_DOLL_MOTION_PRESETS;

export function getPaperDollMotionPreset(id: PaperDollMotionPresetId) {
  return PAPER_DOLL_MOTION_PRESETS[id] as PaperDollMotionClip;
}

function defaultRequestFrame(callback: FrameRequestCallback) {
  if (typeof globalThis.requestAnimationFrame !== "function") {
    throw new Error("사전 모션 재생은 브라우저 환경에서만 사용할 수 있습니다.");
  }
  return globalThis.requestAnimationFrame(callback);
}

function defaultCancelFrame(handle: number) {
  if (typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(handle);
  }
}

export class PaperDollMotionPlayer {
  private clip: PaperDollMotionClip | null;
  private state: PaperDollMotionPlayerState = "idle";
  private positionMs = 0;
  private playbackRate: number;
  private loopOverride: boolean | null;
  private requestHandle: number | null = null;
  private lastTimestamp: number | null = null;
  private lastOutputTimestamp: number | null = null;
  private readonly frameListeners = new Set<
    (sample: PaperDollMotionSample) => void
  >();
  private readonly stateListeners = new Set<
    (snapshot: PaperDollMotionPlayerSnapshot) => void
  >();
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;

  constructor(options: PaperDollMotionPlayerOptions = {}) {
    this.clip = options.clip ?? null;
    this.playbackRate = options.playbackRate ?? 1;
    this.loopOverride = options.loop ?? null;
    this.requestFrame = options.requestFrame ?? defaultRequestFrame;
    this.cancelFrame = options.cancelFrame ?? defaultCancelFrame;
    this.setPlaybackRate(this.playbackRate);
    if (this.clip) validatePaperDollMotionClip(this.clip);
    if (options.onFrame) this.frameListeners.add(options.onFrame);
    if (options.onStateChange) this.stateListeners.add(options.onStateChange);
  }

  getSnapshot(): PaperDollMotionPlayerSnapshot {
    return {
      clipId: this.clip?.id ?? null,
      state: this.state,
      positionMs: this.positionMs,
      durationMs: this.clip?.durationMs ?? 0,
      playbackRate: this.playbackRate,
      loop: this.shouldLoop(),
    };
  }

  subscribe(listener: (sample: PaperDollMotionSample) => void) {
    this.assertUsable();
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  subscribeState(
    listener: (snapshot: PaperDollMotionPlayerSnapshot) => void,
  ) {
    this.assertUsable();
    this.stateListeners.add(listener);
    listener(this.getSnapshot());
    return () => this.stateListeners.delete(listener);
  }

  load(
    clip: PaperDollMotionClip,
    options: LoadPaperDollMotionOptions = {},
  ) {
    this.assertUsable();
    validatePaperDollMotionClip(clip);
    this.cancelScheduledFrame();
    this.clip = clip;
    this.loopOverride = options.loop ?? null;
    this.positionMs = clamp(options.startAtMs ?? 0, 0, clip.durationMs);
    this.lastTimestamp = null;
    this.lastOutputTimestamp = null;
    this.setState("idle");
    this.emitCurrentFrame();
    if (options.autoplay) this.play();
  }

  play() {
    this.assertUsable();
    if (!this.clip) throw new Error("재생할 사전 모션을 먼저 선택해 주세요.");
    if (this.state === "playing") return;
    if (this.state === "ended" || this.positionMs >= this.clip.durationMs) {
      this.positionMs = 0;
    }
    this.lastTimestamp = null;
    this.lastOutputTimestamp = null;
    this.setState("playing");
    this.emitCurrentFrame();
    this.scheduleNextFrame();
  }

  pause() {
    this.assertUsable();
    if (this.state !== "playing") return;
    this.cancelScheduledFrame();
    this.lastTimestamp = null;
    this.lastOutputTimestamp = null;
    this.setState("paused");
  }

  stop() {
    this.assertUsable();
    this.cancelScheduledFrame();
    this.positionMs = 0;
    this.lastTimestamp = null;
    this.lastOutputTimestamp = null;
    this.setState("idle");
    this.emitCurrentFrame();
  }

  seek(positionMs: number) {
    this.assertUsable();
    assertFiniteNumber(positionMs, "재생 위치");
    if (!this.clip) throw new Error("재생할 사전 모션을 먼저 선택해 주세요.");
    this.positionMs = clamp(positionMs, 0, this.clip.durationMs);
    if (this.state === "ended" && this.positionMs < this.clip.durationMs) {
      this.setState("paused");
    }
    this.lastTimestamp = null;
    this.lastOutputTimestamp = null;
    this.emitCurrentFrame();
  }

  setPlaybackRate(playbackRate: number) {
    this.assertUsable();
    assertFiniteNumber(playbackRate, "재생 속도");
    if (playbackRate < 0.1 || playbackRate > 4) {
      throw new Error("재생 속도는 0.1배에서 4배 사이여야 합니다.");
    }
    this.playbackRate = playbackRate;
    this.lastTimestamp = null;
    this.notifyState();
  }

  setLoop(loop: boolean) {
    this.assertUsable();
    this.loopOverride = loop;
    this.notifyState();
  }

  useClipLoopSetting() {
    this.assertUsable();
    this.loopOverride = null;
    this.notifyState();
  }

  sample(positionMs = this.positionMs) {
    this.assertUsable();
    if (!this.clip) throw new Error("샘플링할 사전 모션을 먼저 선택해 주세요.");
    return samplePaperDollMotion(this.clip, positionMs, {
      loop: this.shouldLoop(),
    });
  }

  dispose() {
    if (this.state === "disposed") return;
    this.cancelScheduledFrame();
    this.state = "disposed";
    this.frameListeners.clear();
    this.stateListeners.clear();
    this.clip = null;
  }

  private readonly tick = (timestamp: number) => {
    if (this.state !== "playing" || !this.clip) return;
    if (this.lastTimestamp !== null) {
      const delta = Math.max(0, timestamp - this.lastTimestamp);
      this.positionMs += delta * this.playbackRate;
    }
    this.lastTimestamp = timestamp;

    if (this.positionMs >= this.clip.durationMs) {
      if (this.shouldLoop()) {
        this.positionMs = wrap(this.positionMs, this.clip.durationMs);
      } else {
        this.positionMs = this.clip.durationMs;
        this.emitCurrentFrame();
        this.requestHandle = null;
        this.setState("ended");
        return;
      }
    }

    if (
      this.lastOutputTimestamp !== null &&
      timestamp - this.lastOutputTimestamp < 32
    ) {
      this.scheduleNextFrame();
      return;
    }
    this.lastOutputTimestamp = timestamp;
    this.emitCurrentFrame();
    this.scheduleNextFrame();
  };

  private emitCurrentFrame() {
    if (!this.clip) return;
    const sample = samplePaperDollMotion(this.clip, this.positionMs, {
      loop: this.shouldLoop(),
    });
    for (const listener of this.frameListeners) listener(sample);
  }

  private scheduleNextFrame() {
    if (this.state !== "playing" || this.requestHandle !== null) return;
    this.requestHandle = this.requestFrame((timestamp) => {
      this.requestHandle = null;
      this.tick(timestamp);
    });
  }

  private cancelScheduledFrame() {
    if (this.requestHandle === null) return;
    this.cancelFrame(this.requestHandle);
    this.requestHandle = null;
  }

  private shouldLoop() {
    return this.loopOverride ?? this.clip?.loop ?? false;
  }

  private setState(state: PaperDollMotionPlayerState) {
    this.state = state;
    this.notifyState();
  }

  private notifyState() {
    const snapshot = this.getSnapshot();
    for (const listener of this.stateListeners) listener(snapshot);
  }

  private assertUsable() {
    if (this.state === "disposed") {
      throw new Error("이미 정리된 사전 모션 플레이어입니다.");
    }
  }
}
