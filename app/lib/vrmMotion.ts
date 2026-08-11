/**
 * Browser-only procedural motion and lower-body locking for three-vrm.
 *
 * Motions are written to normalized humanoid bones, the same rig used by
 * `applyVrmTracking`. Every touched transform is snapshotted before playback
 * or locking and restored exactly on stop/unlock/dispose.
 */

import { Euler, Quaternion, Vector3, type Object3D } from "three";
import {
  VRMHumanBoneName,
  type VRM,
  type VRMHumanBoneName as VRMHumanBoneNameValue,
} from "@pixiv/three-vrm";

export type VrmMotionPresetId = "idle" | "walk" | "dance" | "greeting";
export type VrmMotionPlayerState =
  | "idle"
  | "playing"
  | "paused"
  | "ended"
  | "disposed";

export type VrmMotionEuler = readonly [x: number, y: number, z: number];

export interface VrmMotionPose {
  rotations: Readonly<
    Partial<Record<VRMHumanBoneNameValue, VrmMotionEuler>>
  >;
  /** Additive offset from the hips position captured at playback start. */
  hipsOffset: readonly [x: number, y: number, z: number];
}

export interface VrmMotionPreset {
  id: VrmMotionPresetId;
  label: string;
  durationMs: number;
  loop: boolean;
}

export interface VrmMotionSample {
  preset: VrmMotionPresetId;
  timeMs: number;
  progress: number;
  pose: VrmMotionPose;
}

export interface VrmMotionPlayerSnapshot {
  state: VrmMotionPlayerState;
  preset: VrmMotionPresetId | null;
  positionMs: number;
  durationMs: number;
  playbackRate: number;
  loop: boolean;
  missingBones: readonly VRMHumanBoneNameValue[];
}

export interface VrmMotionPlayerOptions {
  /** Maximum application rate. Values above 30 are capped at 30. */
  fps?: number;
  /** Quaternion smoothing applied on each motion frame. Defaults to 0.5. */
  rotationBlend?: number;
  /** Position smoothing applied to hips bobbing. Defaults to 0.55. */
  positionBlend?: number;
  /** Copy normalized bones to the raw rig after each update. Defaults to true. */
  updateHumanoid?: boolean;
  onFrame?: (sample: VrmMotionSample) => void;
  onStateChange?: (snapshot: VrmMotionPlayerSnapshot) => void;
  /** Test hook. Regular callers should use the browser default. */
  requestFrame?: (callback: FrameRequestCallback) => number;
  /** Test hook. Regular callers should use the browser default. */
  cancelFrame?: (handle: number) => void;
}

export interface PlayVrmMotionOptions {
  playbackRate?: number;
  loop?: boolean;
}

type MutablePose = {
  rotations: Partial<Record<VRMHumanBoneNameValue, VrmMotionEuler>>;
  hipsOffset: [number, number, number];
};

type BoneSnapshot = {
  node: Object3D;
  quaternion: Quaternion;
  position: Vector3;
};

const PI = Math.PI;
const TWO_PI = Math.PI * 2;
// Normalized VRM arms use a T-pose: left points toward -X and right toward
// +X. Their resting Z rotations therefore need opposite signs to point both
// arms toward -Y. Keep these values paired whenever a preset returns to rest.
const REST_ARM_DROP_RADIANS = 1.08;
const REST_FOREARM_DROP_RADIANS = 0.12;
const SHOULDER_DROP_RADIANS = 0.08;
// Normalized VRM arms start in a T-pose: left points toward -X and right
// toward +X. Rotating left around +Z and right around -Z therefore lowers
// both arms toward -Y. A small X rotation then produces the walking swing.
const WALK_ARM_DROP_RADIANS = 1.22;
const WALK_ARM_SWING_RADIANS = 0.26;

export const VRM_MOTION_PRESETS: Readonly<
  Record<VrmMotionPresetId, VrmMotionPreset>
> = {
  idle: {
    id: "idle",
    label: "숨쉬기",
    durationMs: 2600,
    loop: true,
  },
  walk: {
    id: "walk",
    label: "제자리 걷기",
    durationMs: 1100,
    loop: true,
  },
  dance: {
    id: "dance",
    label: "신나는 춤",
    durationMs: 1900,
    loop: true,
  },
  greeting: {
    id: "greeting",
    label: "손 흔들기",
    durationMs: 2900,
    loop: false,
  },
};

const MOTION_BONES: readonly VRMHumanBoneNameValue[] = [
  VRMHumanBoneName.Hips,
  VRMHumanBoneName.Spine,
  VRMHumanBoneName.Chest,
  VRMHumanBoneName.UpperChest,
  VRMHumanBoneName.Neck,
  VRMHumanBoneName.Head,
  VRMHumanBoneName.LeftShoulder,
  VRMHumanBoneName.LeftUpperArm,
  VRMHumanBoneName.LeftLowerArm,
  VRMHumanBoneName.LeftHand,
  VRMHumanBoneName.RightShoulder,
  VRMHumanBoneName.RightUpperArm,
  VRMHumanBoneName.RightLowerArm,
  VRMHumanBoneName.RightHand,
  VRMHumanBoneName.LeftUpperLeg,
  VRMHumanBoneName.LeftLowerLeg,
  VRMHumanBoneName.LeftFoot,
  VRMHumanBoneName.LeftToes,
  VRMHumanBoneName.RightUpperLeg,
  VRMHumanBoneName.RightLowerLeg,
  VRMHumanBoneName.RightFoot,
  VRMHumanBoneName.RightToes,
];

const BASE_STANDING_ROTATIONS: Readonly<
  Partial<Record<VRMHumanBoneNameValue, VrmMotionEuler>>
> = {
  [VRMHumanBoneName.Hips]: [0, 0, 0],
  [VRMHumanBoneName.Spine]: [0, 0, 0],
  [VRMHumanBoneName.Chest]: [0, 0, 0],
  [VRMHumanBoneName.UpperChest]: [0, 0, 0],
  [VRMHumanBoneName.Neck]: [0, 0, 0],
  [VRMHumanBoneName.Head]: [0, 0, 0],
  [VRMHumanBoneName.LeftShoulder]: [0, 0, SHOULDER_DROP_RADIANS],
  [VRMHumanBoneName.LeftUpperArm]: [0, 0, REST_ARM_DROP_RADIANS],
  [VRMHumanBoneName.LeftLowerArm]: [0.06, 0, REST_FOREARM_DROP_RADIANS],
  [VRMHumanBoneName.LeftHand]: [0, 0, 0],
  [VRMHumanBoneName.RightShoulder]: [0, 0, -SHOULDER_DROP_RADIANS],
  [VRMHumanBoneName.RightUpperArm]: [0, 0, -REST_ARM_DROP_RADIANS],
  [VRMHumanBoneName.RightLowerArm]: [0.06, 0, -REST_FOREARM_DROP_RADIANS],
  [VRMHumanBoneName.RightHand]: [0, 0, 0],
  [VRMHumanBoneName.LeftUpperLeg]: [0, 0, 0],
  [VRMHumanBoneName.LeftLowerLeg]: [0, 0, 0],
  [VRMHumanBoneName.LeftFoot]: [0, 0, 0],
  [VRMHumanBoneName.LeftToes]: [0, 0, 0],
  [VRMHumanBoneName.RightUpperLeg]: [0, 0, 0],
  [VRMHumanBoneName.RightLowerLeg]: [0, 0, 0],
  [VRMHumanBoneName.RightFoot]: [0, 0, 0],
  [VRMHumanBoneName.RightToes]: [0, 0, 0],
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function wrap(value: number, length: number) {
  return ((value % length) + length) % length;
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const amount = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return amount * amount * (3 - 2 * amount);
}

function mix(from: number, to: number, amount: number) {
  return from + (to - from) * amount;
}

function withStandingPose(
  rotations: Partial<Record<VRMHumanBoneNameValue, VrmMotionEuler>>,
  hipsOffset: readonly [number, number, number] = [0, 0, 0],
): MutablePose {
  return {
    rotations: { ...BASE_STANDING_ROTATIONS, ...rotations },
    hipsOffset: [hipsOffset[0], hipsOffset[1], hipsOffset[2]],
  };
}

function sampleIdle(progress: number): VrmMotionPose {
  const phase = progress * TWO_PI;
  const sway = Math.sin(phase);
  const breath = (1 - Math.cos(phase)) * 0.5;
  return withStandingPose(
    {
      [VRMHumanBoneName.Hips]: [0, sway * 0.012, sway * 0.018],
      [VRMHumanBoneName.Spine]: [-breath * 0.018, 0, -sway * 0.018],
      [VRMHumanBoneName.Chest]: [breath * 0.025, 0, sway * 0.012],
      [VRMHumanBoneName.Neck]: [0, -sway * 0.015, sway * 0.008],
      [VRMHumanBoneName.Head]: [breath * 0.012, -sway * 0.018, sway * 0.012],
      [VRMHumanBoneName.LeftUpperArm]: [
        sway * 0.018,
        0,
        REST_ARM_DROP_RADIANS,
      ],
      [VRMHumanBoneName.RightUpperArm]: [
        -sway * 0.018,
        0,
        -REST_ARM_DROP_RADIANS,
      ],
    },
    [0, breath * 0.008, 0],
  );
}

function sampleWalk(progress: number): VrmMotionPose {
  const phase = progress * TWO_PI;
  const swing = Math.sin(phase);
  const leftLift = Math.max(0, Math.sin(phase + PI * 0.32));
  const rightLift = Math.max(0, Math.sin(phase + PI * 1.32));
  const bounce = Math.abs(Math.cos(phase));
  return withStandingPose(
    {
      [VRMHumanBoneName.Hips]: [0, -swing * 0.045, -swing * 0.03],
      [VRMHumanBoneName.Spine]: [0.035, swing * 0.025, swing * 0.035],
      [VRMHumanBoneName.Chest]: [-0.025, -swing * 0.035, -swing * 0.03],
      [VRMHumanBoneName.Head]: [0, swing * 0.025, -swing * 0.018],
      [VRMHumanBoneName.LeftUpperArm]: [
        -swing * WALK_ARM_SWING_RADIANS,
        0,
        WALK_ARM_DROP_RADIANS,
      ],
      [VRMHumanBoneName.LeftLowerArm]: [-0.08 - rightLift * 0.24, 0, -0.12],
      [VRMHumanBoneName.RightUpperArm]: [
        swing * WALK_ARM_SWING_RADIANS,
        0,
        -WALK_ARM_DROP_RADIANS,
      ],
      [VRMHumanBoneName.RightLowerArm]: [-0.08 - leftLift * 0.24, 0, 0.12],
      [VRMHumanBoneName.LeftUpperLeg]: [swing * 0.5, 0, 0],
      [VRMHumanBoneName.LeftLowerLeg]: [leftLift * 0.62, 0, 0],
      [VRMHumanBoneName.LeftFoot]: [-leftLift * 0.28, 0, 0],
      [VRMHumanBoneName.RightUpperLeg]: [-swing * 0.5, 0, 0],
      [VRMHumanBoneName.RightLowerLeg]: [rightLift * 0.62, 0, 0],
      [VRMHumanBoneName.RightFoot]: [-rightLift * 0.28, 0, 0],
    },
    [0, bounce * 0.022, 0],
  );
}

function sampleDance(progress: number): VrmMotionPose {
  const phase = progress * TWO_PI;
  const sway = Math.sin(phase);
  const counter = Math.sin(phase * 2);
  const bounce = Math.max(0, Math.sin(phase * 2));
  return withStandingPose(
    {
      [VRMHumanBoneName.Hips]: [0, sway * 0.16, sway * 0.15],
      [VRMHumanBoneName.Spine]: [-0.04 - bounce * 0.08, -sway * 0.09, -sway * 0.11],
      [VRMHumanBoneName.Chest]: [0.05, sway * 0.12, sway * 0.14],
      [VRMHumanBoneName.UpperChest]: [0, -sway * 0.08, sway * 0.08],
      [VRMHumanBoneName.Neck]: [0, -sway * 0.1, -sway * 0.06],
      [VRMHumanBoneName.Head]: [-bounce * 0.05, -sway * 0.12, -sway * 0.12],
      [VRMHumanBoneName.LeftUpperArm]: [counter * 0.32, 0, 0.85 + sway * 0.38],
      [VRMHumanBoneName.LeftLowerArm]: [-0.38 + sway * 0.22, 0, 0.3],
      [VRMHumanBoneName.LeftHand]: [0, sway * 0.25, counter * 0.25],
      [VRMHumanBoneName.RightUpperArm]: [-counter * 0.32, 0, -0.85 + sway * 0.38],
      [VRMHumanBoneName.RightLowerArm]: [-0.38 - sway * 0.22, 0, -0.3],
      [VRMHumanBoneName.RightHand]: [0, -sway * 0.25, -counter * 0.25],
      [VRMHumanBoneName.LeftUpperLeg]: [-sway * 0.24, 0, -0.08 - counter * 0.08],
      [VRMHumanBoneName.LeftLowerLeg]: [Math.max(0, sway) * 0.36, 0, 0],
      [VRMHumanBoneName.RightUpperLeg]: [sway * 0.24, 0, 0.08 + counter * 0.08],
      [VRMHumanBoneName.RightLowerLeg]: [Math.max(0, -sway) * 0.36, 0, 0],
    },
    [sway * 0.025, bounce * 0.045, 0],
  );
}

function sampleGreeting(progress: number): VrmMotionPose {
  const enter = smoothstep(0, 0.18, progress);
  const leave = 1 - smoothstep(0.8, 1, progress);
  const amount = Math.min(enter, leave);
  const wave = Math.sin(progress * PI * 9) * amount;
  return withStandingPose({
    [VRMHumanBoneName.Hips]: [0, 0, -amount * 0.025],
    [VRMHumanBoneName.Spine]: [0, 0, amount * 0.03],
    [VRMHumanBoneName.Chest]: [0, -amount * 0.035, amount * 0.035],
    [VRMHumanBoneName.Head]: [0, amount * 0.08, -amount * 0.045],
    [VRMHumanBoneName.LeftUpperArm]: [0, 0, REST_ARM_DROP_RADIANS],
    [VRMHumanBoneName.RightUpperArm]: [
      amount * 0.1,
      -amount * 0.08,
      mix(-REST_ARM_DROP_RADIANS, -0.28, amount),
    ],
    [VRMHumanBoneName.RightLowerArm]: [
      -amount * 0.14,
      0,
      mix(-REST_FOREARM_DROP_RADIANS, 1.65, amount) + wave * 0.22,
    ],
    [VRMHumanBoneName.RightHand]: [0, wave * 0.22, wave * 0.38],
  });
}

const MOTION_SAMPLERS: Readonly<
  Record<VrmMotionPresetId, (progress: number) => VrmMotionPose>
> = {
  idle: sampleIdle,
  walk: sampleWalk,
  dance: sampleDance,
  greeting: sampleGreeting,
};

export function getVrmMotionPreset(id: VrmMotionPresetId): VrmMotionPreset {
  return VRM_MOTION_PRESETS[id];
}

export function sampleVrmMotion(
  id: VrmMotionPresetId,
  requestedTimeMs: number,
  loop = VRM_MOTION_PRESETS[id].loop,
): VrmMotionSample {
  if (!Number.isFinite(requestedTimeMs)) {
    throw new Error("VRM 모션 시간이 올바르지 않습니다.");
  }
  const preset = VRM_MOTION_PRESETS[id];
  const timeMs = loop
    ? wrap(requestedTimeMs, preset.durationMs)
    : clamp(requestedTimeMs, 0, preset.durationMs);
  const progress = timeMs / preset.durationMs;
  return {
    preset: id,
    timeMs,
    progress,
    pose: MOTION_SAMPLERS[id](progress),
  };
}

function defaultRequestFrame(callback: FrameRequestCallback) {
  if (typeof globalThis.requestAnimationFrame !== "function") {
    throw new Error("VRM 모션 재생은 브라우저 환경에서만 사용할 수 있습니다.");
  }
  return globalThis.requestAnimationFrame(callback);
}

function defaultCancelFrame(handle: number) {
  if (typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(handle);
  }
}

const motionOwners = new WeakMap<VRM, VrmMotionPlayer>();

export class VrmMotionPlayer {
  private state: VrmMotionPlayerState = "idle";
  private preset: VrmMotionPresetId | null = null;
  private positionMs = 0;
  private playbackRate = 1;
  private loopOverride: boolean | null = null;
  private requestHandle: number | null = null;
  private previousTimestamp: number | null = null;
  private previousAppliedTimestamp: number | null = null;
  private readonly frameIntervalMs: number;
  private readonly rotationBlend: number;
  private readonly positionBlend: number;
  private readonly updateHumanoid: boolean;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly originalBones = new Map<VRMHumanBoneNameValue, BoneSnapshot>();
  private readonly missingBones = new Set<VRMHumanBoneNameValue>();
  private readonly frameListeners = new Set<(sample: VrmMotionSample) => void>();
  private readonly stateListeners = new Set<
    (snapshot: VrmMotionPlayerSnapshot) => void
  >();
  private readonly targetEuler = new Euler();
  private readonly targetQuaternion = new Quaternion();
  private readonly targetPosition = new Vector3();

  constructor(
    private readonly vrm: VRM,
    options: VrmMotionPlayerOptions = {},
  ) {
    const fps = clamp(options.fps ?? 30, 1, 30);
    this.frameIntervalMs = 1000 / fps;
    this.rotationBlend = clamp(options.rotationBlend ?? 0.5, 0, 1);
    this.positionBlend = clamp(options.positionBlend ?? 0.55, 0, 1);
    this.updateHumanoid = options.updateHumanoid ?? true;
    this.requestFrame = options.requestFrame ?? defaultRequestFrame;
    this.cancelFrame = options.cancelFrame ?? defaultCancelFrame;
    if (options.onFrame) this.frameListeners.add(options.onFrame);
    if (options.onStateChange) this.stateListeners.add(options.onStateChange);
  }

  getSnapshot(): VrmMotionPlayerSnapshot {
    const metadata = this.preset ? VRM_MOTION_PRESETS[this.preset] : null;
    return {
      state: this.state,
      preset: this.preset,
      positionMs: this.positionMs,
      durationMs: metadata?.durationMs ?? 0,
      playbackRate: this.playbackRate,
      loop: this.shouldLoop(),
      missingBones: [...this.missingBones],
    };
  }

  subscribeFrame(listener: (sample: VrmMotionSample) => void) {
    this.assertUsable();
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  subscribeState(listener: (snapshot: VrmMotionPlayerSnapshot) => void) {
    this.assertUsable();
    this.stateListeners.add(listener);
    listener(this.getSnapshot());
    return () => this.stateListeners.delete(listener);
  }

  play(id: VrmMotionPresetId, options: PlayVrmMotionOptions = {}) {
    this.assertUsable();
    this.releaseMotion(true);
    const owner = motionOwners.get(this.vrm);
    if (owner && owner !== this) {
      throw new Error("이 VRM은 이미 다른 모션 플레이어가 제어하고 있습니다.");
    }
    motionOwners.set(this.vrm, this);
    this.captureOriginalPose();
    this.preset = id;
    this.positionMs = 0;
    this.loopOverride = options.loop ?? null;
    if (options.playbackRate !== undefined) {
      this.setPlaybackRate(options.playbackRate);
    }
    this.previousTimestamp = null;
    this.previousAppliedTimestamp = null;
    this.state = "playing";
    this.applyCurrentPose();
    this.notifyState();
    this.scheduleFrame();
  }

  pause() {
    this.assertUsable();
    if (this.state !== "playing") return;
    this.cancelScheduledFrame();
    this.previousTimestamp = null;
    this.state = "paused";
    this.notifyState();
  }

  resume() {
    this.assertUsable();
    if (this.state !== "paused" || !this.preset || this.originalBones.size === 0) return;
    this.previousTimestamp = null;
    this.previousAppliedTimestamp = null;
    this.state = "playing";
    this.notifyState();
    this.scheduleFrame();
  }

  stop() {
    this.assertUsable();
    this.releaseMotion(true);
    this.positionMs = 0;
    this.state = "idle";
    this.notifyState();
  }

  seek(positionMs: number) {
    this.assertUsable();
    if (!this.preset || this.originalBones.size === 0) {
      throw new Error("먼저 VRM 모션을 재생해 주세요.");
    }
    if (!Number.isFinite(positionMs)) throw new Error("VRM 모션 시간이 올바르지 않습니다.");
    const duration = VRM_MOTION_PRESETS[this.preset].durationMs;
    this.positionMs = clamp(positionMs, 0, duration);
    this.previousTimestamp = null;
    this.applyCurrentPose();
    this.notifyState();
  }

  setPlaybackRate(rate: number) {
    this.assertUsable();
    if (!Number.isFinite(rate) || rate < 0.1 || rate > 4) {
      throw new Error("VRM 모션 속도는 0.1배에서 4배 사이여야 합니다.");
    }
    this.playbackRate = rate;
    this.previousTimestamp = null;
    this.notifyState();
  }

  setLoop(loop: boolean) {
    this.assertUsable();
    this.loopOverride = loop;
    this.notifyState();
  }

  usePresetLoopSetting() {
    this.assertUsable();
    this.loopOverride = null;
    this.notifyState();
  }

  dispose() {
    if (this.state === "disposed") return;
    this.releaseMotion(true);
    this.state = "disposed";
    this.frameListeners.clear();
    this.stateListeners.clear();
    this.preset = null;
  }

  private readonly tick = (timestamp: number) => {
    if (this.state !== "playing" || !this.preset) return;
    if (this.previousTimestamp !== null) {
      // Avoid jumping an entire animation when a background tab resumes.
      const delta = clamp(timestamp - this.previousTimestamp, 0, 100);
      this.positionMs += delta * this.playbackRate;
    }
    this.previousTimestamp = timestamp;

    const metadata = VRM_MOTION_PRESETS[this.preset];
    if (this.positionMs >= metadata.durationMs) {
      if (this.shouldLoop()) {
        this.positionMs = wrap(this.positionMs, metadata.durationMs);
      } else {
        this.positionMs = metadata.durationMs;
        this.applyCurrentPose();
        this.releaseMotion(true);
        this.state = "ended";
        this.notifyState();
        return;
      }
    }

    if (
      this.previousAppliedTimestamp === null ||
      timestamp - this.previousAppliedTimestamp >= this.frameIntervalMs
    ) {
      this.previousAppliedTimestamp = timestamp;
      this.applyCurrentPose();
    }
    this.scheduleFrame();
  };

  private captureOriginalPose() {
    this.originalBones.clear();
    this.missingBones.clear();
    for (const bone of MOTION_BONES) {
      const node = this.vrm.humanoid.getNormalizedBoneNode(bone);
      if (!node) {
        this.missingBones.add(bone);
        continue;
      }
      this.originalBones.set(bone, {
        node,
        quaternion: node.quaternion.clone(),
        position: node.position.clone(),
      });
    }
  }

  private applyCurrentPose() {
    if (!this.preset) return;
    const sample = sampleVrmMotion(this.preset, this.positionMs, this.shouldLoop());
    for (const [bone, rotation] of Object.entries(sample.pose.rotations) as [
      VRMHumanBoneNameValue,
      VrmMotionEuler,
    ][]) {
      const snapshot = this.originalBones.get(bone);
      if (!snapshot) continue;
      this.targetEuler.set(rotation[0], rotation[1], rotation[2], "XYZ");
      this.targetQuaternion.setFromEuler(this.targetEuler);
      snapshot.node.quaternion.slerp(this.targetQuaternion, this.rotationBlend);
    }

    const hips = this.originalBones.get(VRMHumanBoneName.Hips);
    if (hips) {
      this.targetPosition
        .set(
          sample.pose.hipsOffset[0],
          sample.pose.hipsOffset[1],
          sample.pose.hipsOffset[2],
        )
        .add(hips.position);
      hips.node.position.lerp(this.targetPosition, this.positionBlend);
    }
    if (this.updateHumanoid) this.vrm.humanoid.update();
    for (const listener of this.frameListeners) listener(sample);
  }

  private restoreOriginalPose() {
    for (const snapshot of this.originalBones.values()) {
      snapshot.node.quaternion.copy(snapshot.quaternion);
      snapshot.node.position.copy(snapshot.position);
    }
    if (this.updateHumanoid && this.originalBones.size > 0) {
      this.vrm.humanoid.update();
    }
    this.originalBones.clear();
    this.missingBones.clear();
  }

  private releaseMotion(restore: boolean) {
    this.cancelScheduledFrame();
    if (restore) this.restoreOriginalPose();
    if (motionOwners.get(this.vrm) === this) motionOwners.delete(this.vrm);
    this.previousTimestamp = null;
    this.previousAppliedTimestamp = null;
  }

  private scheduleFrame() {
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
    if (!this.preset) return false;
    return this.loopOverride ?? VRM_MOTION_PRESETS[this.preset].loop;
  }

  private notifyState() {
    const snapshot = this.getSnapshot();
    for (const listener of this.stateListeners) listener(snapshot);
  }

  private assertUsable() {
    if (this.state === "disposed") {
      throw new Error("이미 정리된 VRM 모션 플레이어입니다.");
    }
  }
}

export type VrmLegLockMode = "current" | "rest";

export interface VrmLegRotationLockOptions {
  mode?: VrmLegLockMode;
  includeFeet?: boolean;
  includeToes?: boolean;
  /** Copy normalized bones to the raw rig on enforce/unlock. Defaults to true. */
  updateHumanoid?: boolean;
}

export interface UnlockVrmLegRotationOptions {
  /** Restore rotations captured before the lock was enabled. Defaults to true. */
  restore?: boolean;
}

type LockedLegBone = {
  node: Object3D;
  original: Quaternion;
  target: Quaternion;
};

const legLockOwners = new WeakMap<VRM, VrmLegRotationLock>();

const UPPER_AND_LOWER_LEG_BONES: readonly VRMHumanBoneNameValue[] = [
  VRMHumanBoneName.LeftUpperLeg,
  VRMHumanBoneName.LeftLowerLeg,
  VRMHumanBoneName.RightUpperLeg,
  VRMHumanBoneName.RightLowerLeg,
];

const FOOT_BONES: readonly VRMHumanBoneNameValue[] = [
  VRMHumanBoneName.LeftFoot,
  VRMHumanBoneName.RightFoot,
];

const TOE_BONES: readonly VRMHumanBoneNameValue[] = [
  VRMHumanBoneName.LeftToes,
  VRMHumanBoneName.RightToes,
];

export const VRM_LEG_ROTATION_BONES = [
  ...UPPER_AND_LOWER_LEG_BONES,
  ...FOOT_BONES,
  ...TOE_BONES,
] as const;

/**
 * Freezes normalized leg/foot rotations after each live-tracking update.
 * Call `enforce()` immediately after `applyVrmTracking()`.
 */
export class VrmLegRotationLock {
  private readonly bones = new Map<VRMHumanBoneNameValue, LockedLegBone>();
  private locked = false;
  private disposed = false;
  private updateHumanoid: boolean;

  constructor(
    private readonly vrm: VRM,
    options: VrmLegRotationLockOptions = {},
  ) {
    this.updateHumanoid = options.updateHumanoid ?? true;
    if (options.mode) this.lock(options);
  }

  get isLocked() {
    return this.locked;
  }

  get lockedBones(): readonly VRMHumanBoneNameValue[] {
    return [...this.bones.keys()];
  }

  lock(options: VrmLegRotationLockOptions = {}) {
    this.assertUsable();
    if (this.locked) this.unlock({ restore: true });
    const owner = legLockOwners.get(this.vrm);
    if (owner && owner !== this) {
      throw new Error("이 VRM의 다리는 이미 다른 잠금 컨트롤러가 제어하고 있습니다.");
    }
    legLockOwners.set(this.vrm, this);

    this.updateHumanoid = options.updateHumanoid ?? this.updateHumanoid;
    const mode = options.mode ?? "current";
    const selectedBones = [
      ...UPPER_AND_LOWER_LEG_BONES,
      ...((options.includeFeet ?? true) ? FOOT_BONES : []),
      ...((options.includeToes ?? true) ? TOE_BONES : []),
    ];
    this.bones.clear();
    for (const bone of selectedBones) {
      const node = this.vrm.humanoid.getNormalizedBoneNode(bone);
      if (!node) continue;
      this.bones.set(bone, {
        node,
        original: node.quaternion.clone(),
        target: mode === "rest" ? new Quaternion() : node.quaternion.clone(),
      });
    }
    if (this.bones.size === 0) {
      this.locked = false;
      if (legLockOwners.get(this.vrm) === this) legLockOwners.delete(this.vrm);
      return this.lockedBones;
    }
    this.locked = true;
    this.enforce();
    return this.lockedBones;
  }

  /** Reapply the frozen rotations after another system writes a tracking pose. */
  enforce() {
    this.assertUsable();
    if (!this.locked) return 0;
    for (const bone of this.bones.values()) {
      bone.node.quaternion.copy(bone.target);
    }
    if (this.updateHumanoid && this.bones.size > 0) this.vrm.humanoid.update();
    return this.bones.size;
  }

  unlock(options: UnlockVrmLegRotationOptions = {}) {
    this.assertUsable();
    if (!this.locked) return;
    if (options.restore ?? true) {
      for (const bone of this.bones.values()) {
        bone.node.quaternion.copy(bone.original);
      }
      if (this.updateHumanoid && this.bones.size > 0) this.vrm.humanoid.update();
    }
    this.bones.clear();
    this.locked = false;
    if (legLockOwners.get(this.vrm) === this) legLockOwners.delete(this.vrm);
  }

  dispose() {
    if (this.disposed) return;
    if (this.locked) this.unlock({ restore: true });
    this.disposed = true;
    this.bones.clear();
  }

  private assertUsable() {
    if (this.disposed) throw new Error("이미 정리된 VRM 다리 잠금 컨트롤러입니다.");
  }
}
