/**
 * Original VRM loading and rigging utilities for this project.
 *
 * The live-avatar workflow is inspired by Kalidoface 3D
 * (https://github.com/yeemachine/kalidoface-3d). No source code from that
 * project is reproduced here; pose solving is delegated to the Kalidokit API.
 */

import {
  Euler,
  LoadingManager,
  MathUtils,
  Quaternion,
  Vector3,
  type EulerOrder,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  VRMExpressionPresetName,
  VRMHumanBoneName,
  VRMLoaderPlugin,
  VRMUtils,
  type VRM,
  type VRMHumanBoneName as VRMHumanBoneNameValue,
} from "@pixiv/three-vrm";
import { Face, Hand, Pose, type TFace, type TPose } from "kalidokit";

export const DEFAULT_MAX_VRM_BYTES = 100 * 1024 * 1024;

const GLB_HEADER_LENGTH = 12;
const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;

export type VrmLoadInput = File | ArrayBuffer;

export type VrmValidationErrorCode =
  | "empty-file"
  | "file-too-large"
  | "invalid-extension"
  | "invalid-glb-header"
  | "unsupported-glb-version"
  | "invalid-glb-length";

export class VrmValidationError extends Error {
  readonly code: VrmValidationErrorCode;

  constructor(code: VrmValidationErrorCode, message: string) {
    super(message);
    this.name = "VrmValidationError";
    this.code = code;
  }
}

export interface VrmValidationOptions {
  /** Maximum accepted upload size. Defaults to 100 MiB. */
  maxBytes?: number;
  /** Require uploaded File names to end in `.vrm`. Defaults to true. */
  requireVrmExtension?: boolean;
}

export interface ValidatedVrmSource {
  buffer: ArrayBuffer;
  byteLength: number;
  sourceName?: string;
}

export interface LoadVrmOptions extends VrmValidationOptions {
  loadingManager?: LoadingManager;
  /** Base URL used only if the GLB refers to an external resource. */
  resourcePath?: string;
  signal?: AbortSignal;
  /** A currently mounted model that should be released after the new one loads. */
  previousVrm?: VRM | null;
  /** Defaults to true when `previousVrm` is supplied. */
  disposePrevious?: boolean;
}

export interface LoadedVrm {
  vrm: VRM;
  /** The GLTFLoader result. Kept as unknown so consumers do not need loader-private types. */
  gltf: unknown;
  byteLength: number;
  sourceName?: string;
}

export interface DisposeVrmOptions {
  removeFromParent?: boolean;
}

export interface MediaPipeLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
  presence?: number;
}

export type MediaPipeLandmarkList = readonly MediaPipeLandmark[];

/** A renderer-independent tracking frame suitable for a React component/ref. */
export interface VrmTrackingFrame {
  faceLandmarks?: MediaPipeLandmarkList | null;
  poseLandmarks?: MediaPipeLandmarkList | null;
  poseWorldLandmarks?: MediaPipeLandmarkList | null;
  leftHandLandmarks?: MediaPipeLandmarkList | null;
  rightHandLandmarks?: MediaPipeLandmarkList | null;
  leftHandWorldLandmarks?: MediaPipeLandmarkList | null;
  rightHandWorldLandmarks?: MediaPipeLandmarkList | null;
  /** Exact bitmap dimensions used to infer `faceLandmarks`. */
  imageSize?: { width: number; height: number } | null;
}

/** Minimal structural types matching MediaPipe Tasks Vision result objects. */
export interface MediaPipeFaceTaskResultLike {
  faceLandmarks?: readonly MediaPipeLandmarkList[];
}

export interface MediaPipePoseTaskResultLike {
  landmarks?: readonly MediaPipeLandmarkList[];
  worldLandmarks?: readonly MediaPipeLandmarkList[];
}

export interface MediaPipeHandednessLike {
  categoryName?: string;
  displayName?: string;
}

export interface MediaPipeHandTaskResultLike {
  landmarks?: readonly MediaPipeLandmarkList[];
  worldLandmarks?: readonly MediaPipeLandmarkList[];
  handedness?: readonly (readonly MediaPipeHandednessLike[])[];
}

export interface MediaPipeTaskResultsLike {
  face?: MediaPipeFaceTaskResultLike | null;
  pose?: MediaPipePoseTaskResultLike | null;
  hands?: MediaPipeHandTaskResultLike | null;
  /** Select a non-zero detected person/face when using multi-result task options. */
  personIndex?: number;
}

export interface EulerLike {
  x: number;
  y: number;
  z: number;
  rotationOrder?: EulerOrder;
}

export interface BoneRotationOptions {
  dampener?: number;
  slerp?: number;
}

export interface VrmRigOptions {
  /** Response at 30 Hz; adjusted by deltaSeconds. Defaults to 0.5. */
  rotationSlerp?: number;
  /** Faster response for individual finger joints. Defaults to 0.7. */
  fingerSlerp?: number;
  /** Time since the previous tracking result, in seconds. Defaults to 1/30. */
  deltaSeconds?: number;
  /** Hips-position interpolation amount at 30 Hz. Defaults to 0.4. */
  positionLerp?: number;
  /** Expression interpolation amount at 30 Hz. Defaults to 0.65. */
  expressionLerp?: number;
  /** Scale applied to Kalidokit's normalized hips translation. Defaults to 1. */
  hipsPositionScale?: number;
  /** Apply hips translation as well as rotation. Defaults to true. */
  applyHipsPosition?: boolean;
  /** Apply tracking-driven hips rotation. Disable this while planting the legs. */
  applyHipsRotation?: boolean;
  /** Solve and apply leg bones. Defaults to true. */
  enableLegs?: boolean;
  /** Look-at input yaw, before the model's range map. Defaults to 60 degrees. */
  maxLookYawDegrees?: number;
  /** Look-at input pitch, before the model's range map. Defaults to 45 degrees. */
  maxLookPitchDegrees?: number;
}

export interface VrmRigResult {
  faceApplied: boolean;
  poseApplied: boolean;
  leftHandApplied: boolean;
  rightHandApplied: boolean;
  /** Optional bones that were requested by the solved frame but absent in the VRM. */
  missingBones: VRMHumanBoneNameValue[];
}

interface FileLike {
  readonly name: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

type KalidokitHandSolution = Record<string, EulerLike>;

const rigRestPositions = new WeakMap<VRM, Map<VRMHumanBoneNameValue, Vector3>>();
const targetQuaternion = new Quaternion();
const targetEuler = new Euler();
const targetPosition = new Vector3();
const hipsOffset = new Vector3();
// Kalidokit's Euler solutions were authored against VRM 0.x's -Z-forward
// humanoid space. `rotateVRM0()` turns that model 180 degrees for rendering,
// while a VRM 1.x avatar is +Z-forward already. Conjugating the solved local
// rotation by the same Y half-turn makes both versions produce the same
// camera-facing motion without changing the known-good VRM 0.x path.
const VRM0_TO_VRM1_BASIS = new Quaternion().setFromAxisAngle(
  new Vector3(0, 1, 0),
  Math.PI,
);
const VRM1_TO_VRM0_BASIS = VRM0_TO_VRM1_BASIS.clone().invert();

/** Mutate a VRM-0-space tracking vector into the loaded avatar's local basis. */
export function transformVrmTrackingVector(vrm: VRM, vector: Vector3): Vector3 {
  if (vrm.meta?.metaVersion === "1") {
    vector.applyQuaternion(VRM0_TO_VRM1_BASIS);
  }
  return vector;
}

function isFileLike(input: VrmLoadInput): input is File {
  const candidate = input as Partial<FileLike>;
  return (
    !(input instanceof ArrayBuffer) &&
    typeof candidate.name === "string" &&
    typeof candidate.size === "number" &&
    typeof candidate.arrayBuffer === "function"
  );
}

function validatedMaxBytes(maxBytes: number | undefined): number {
  const value = maxBytes ?? DEFAULT_MAX_VRM_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer.");
  }
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("The VRM load was aborted.", "AbortError");
}

/** Validate a complete GLB/VRM buffer and return it unchanged. */
export function validateVrmBuffer(
  buffer: ArrayBuffer,
  options: Pick<VrmValidationOptions, "maxBytes"> = {},
): ArrayBuffer {
  const maxBytes = validatedMaxBytes(options.maxBytes);
  const byteLength = buffer.byteLength;

  if (byteLength === 0) {
    throw new VrmValidationError("empty-file", "The selected VRM file is empty.");
  }
  if (byteLength > maxBytes) {
    throw new VrmValidationError(
      "file-too-large",
      `The VRM is ${(byteLength / 1024 / 1024).toFixed(1)} MiB; the limit is ${(
        maxBytes /
        1024 /
        1024
      ).toFixed(1)} MiB.`,
    );
  }
  if (byteLength < GLB_HEADER_LENGTH) {
    throw new VrmValidationError("invalid-glb-header", "The file is too short to be a GLB/VRM.");
  }

  const header = new DataView(buffer, 0, GLB_HEADER_LENGTH);
  if (header.getUint32(0, true) !== GLB_MAGIC) {
    throw new VrmValidationError(
      "invalid-glb-header",
      "This file does not contain a valid binary glTF header.",
    );
  }
  if (header.getUint32(4, true) !== GLB_VERSION) {
    throw new VrmValidationError(
      "unsupported-glb-version",
      "Only glTF/GLB version 2 VRM files are supported.",
    );
  }
  if (header.getUint32(8, true) !== byteLength) {
    throw new VrmValidationError(
      "invalid-glb-length",
      "The GLB header length does not match the uploaded file.",
    );
  }

  return buffer;
}

/** Read and validate an uploaded `.vrm` File. */
export async function validateVrmFile(
  file: File,
  options: VrmValidationOptions = {},
): Promise<ValidatedVrmSource> {
  const maxBytes = validatedMaxBytes(options.maxBytes);
  if ((options.requireVrmExtension ?? true) && !/\.vrm$/i.test(file.name)) {
    throw new VrmValidationError(
      "invalid-extension",
      "Please choose a file whose name ends in .vrm.",
    );
  }
  if (file.size === 0) {
    throw new VrmValidationError("empty-file", "The selected VRM file is empty.");
  }
  if (file.size > maxBytes) {
    throw new VrmValidationError(
      "file-too-large",
      `The VRM is ${(file.size / 1024 / 1024).toFixed(1)} MiB; the limit is ${(
        maxBytes /
        1024 /
        1024
      ).toFixed(1)} MiB.`,
    );
  }

  const buffer = await file.arrayBuffer();
  validateVrmBuffer(buffer, { maxBytes });
  return { buffer, byteLength: buffer.byteLength, sourceName: file.name };
}

/**
 * Load either a File or an already-read ArrayBuffer using GLTFLoader and the
 * current three-vrm loader plugin. VRM 0 avatars are normalized to VRM 1's
 * forward direction by `rotateVRM0`.
 */
export async function loadVrm(
  input: VrmLoadInput,
  options: LoadVrmOptions = {},
): Promise<LoadedVrm> {
  throwIfAborted(options.signal);

  const source = isFileLike(input)
    ? await validateVrmFile(input, options)
    : {
        buffer: validateVrmBuffer(input, options),
        byteLength: input.byteLength,
        sourceName: undefined,
      };

  throwIfAborted(options.signal);

  const loader = new GLTFLoader(options.loadingManager);
  loader.register(
    (parser: ConstructorParameters<typeof VRMLoaderPlugin>[0]) => new VRMLoaderPlugin(parser),
  );
  const gltf = await loader.parseAsync(source.buffer, options.resourcePath ?? "");
  const vrm = gltf.userData.vrm as VRM | undefined;

  if (!vrm) {
    // The data was a GLB, but not one carrying a supported VRM extension.
    VRMUtils.deepDispose(gltf.scene);
    throw new Error("The uploaded GLB does not contain a supported VRM 0.x or VRM 1.x avatar.");
  }

  try {
    throwIfAborted(options.signal);
  } catch (error) {
    disposeVrm(vrm);
    throw error;
  }

  // Reduce duplicate skinning work before the avatar enters the live render
  // loop. These utilities preserve the humanoid rig and expressions.
  VRMUtils.removeUnnecessaryVertices(vrm.scene);
  VRMUtils.combineSkeletons(vrm.scene);
  VRMUtils.rotateVRM0(vrm);
  vrm.scene.updateMatrixWorld(true);

  if (
    options.previousVrm &&
    options.previousVrm !== vrm &&
    (options.disposePrevious ?? true)
  ) {
    disposeVrm(options.previousVrm);
  }

  return {
    vrm,
    gltf,
    byteLength: source.byteLength,
    sourceName: source.sourceName,
  };
}

/** Remove a VRM from its parent and dispose GPU-backed geometry/material data. */
export function disposeVrm(vrm: VRM | null | undefined, options: DisposeVrmOptions = {}): void {
  if (!vrm) return;
  if (options.removeFromParent ?? true) vrm.scene.removeFromParent();
  rigRestPositions.delete(vrm);
  VRMUtils.deepDispose(vrm.scene);
}

function selectResult<T>(sets: readonly T[] | undefined, index: number): T | undefined {
  return sets?.[Math.max(0, Math.trunc(index))];
}

/** Convert the nested output of MediaPipe Tasks landmarker instances into one rig frame. */
export function trackingFrameFromTasks(results: MediaPipeTaskResultsLike): VrmTrackingFrame {
  const personIndex = results.personIndex ?? 0;
  const frame: VrmTrackingFrame = {
    faceLandmarks: selectResult(results.face?.faceLandmarks, personIndex),
    poseLandmarks: selectResult(results.pose?.landmarks, personIndex),
    poseWorldLandmarks: selectResult(results.pose?.worldLandmarks, personIndex),
  };

  results.hands?.landmarks?.forEach((landmarks, index) => {
    const label = results.hands?.handedness?.[index]?.[0]?.categoryName?.toLowerCase();
    const displayName = results.hands?.handedness?.[index]?.[0]?.displayName?.toLowerCase();
    const handedness = label || displayName;
    const preferred = results.hands?.worldLandmarks?.[index] ?? landmarks;

    if (handedness === "left" && !frame.leftHandLandmarks) frame.leftHandLandmarks = preferred;
    if (handedness === "right" && !frame.rightHandLandmarks) frame.rightHandLandmarks = preferred;
  });

  return frame;
}

/**
 * Validate and clone a landmark list. Kalidokit rescales face landmarks in
 * place when `imageSize` is supplied, so the worker/result-owned objects must
 * never be passed through directly.
 */
function finiteLandmarks(
  landmarks: MediaPipeLandmarkList | null | undefined,
  minimumLength: number,
): { x: number; y: number; z: number; visibility?: number }[] | null {
  if (!landmarks || landmarks.length < minimumLength) return null;
  const converted: { x: number; y: number; z: number; visibility?: number }[] = [];

  for (const landmark of landmarks) {
    if (![landmark.x, landmark.y, landmark.z].every(Number.isFinite)) return null;
    converted.push({
      x: landmark.x,
      y: landmark.y,
      z: landmark.z,
      ...(Number.isFinite(landmark.visibility) ? { visibility: landmark.visibility } : {}),
    });
  }

  return converted;
}

function finiteImageSize(
  imageSize: VrmTrackingFrame["imageSize"],
): { width: number; height: number } | undefined {
  if (
    !imageSize ||
    !Number.isFinite(imageSize.width) ||
    !Number.isFinite(imageSize.height) ||
    imageSize.width <= 0 ||
    imageSize.height <= 0
  ) {
    return undefined;
  }

  return { width: imageSize.width, height: imageSize.height };
}

/** Quaternion-slerp an Euler solution into a modern normalized VRM bone. */
export function slerpVrmBoneRotation(
  vrm: VRM,
  boneName: VRMHumanBoneNameValue,
  rotation: EulerLike | null | undefined,
  options: BoneRotationOptions = {},
): boolean {
  if (!rotation) return false;
  const node = vrm.humanoid.getNormalizedBoneNode(boneName);
  if (!node) return false;

  const dampener = Number.isFinite(options.dampener) ? (options.dampener ?? 1) : 1;
  const amount = MathUtils.clamp(options.slerp ?? 0.35, 0, 1);
  targetEuler.set(
    rotation.x * dampener,
    rotation.y * dampener,
    rotation.z * dampener,
    rotation.rotationOrder ?? "XYZ",
  );
  targetQuaternion.setFromEuler(targetEuler);
  if (vrm.meta?.metaVersion === "1") {
    targetQuaternion
      .premultiply(VRM0_TO_VRM1_BASIS)
      .multiply(VRM1_TO_VRM0_BASIS);
  }
  node.quaternion.slerp(targetQuaternion, amount);
  return true;
}

function lerpVrmBonePosition(
  vrm: VRM,
  boneName: VRMHumanBoneNameValue,
  offset: Vector3,
  amount: number,
): boolean {
  const node = vrm.humanoid.getNormalizedBoneNode(boneName);
  if (!node) return false;

  let restMap = rigRestPositions.get(vrm);
  if (!restMap) {
    restMap = new Map();
    rigRestPositions.set(vrm, restMap);
  }
  let rest = restMap.get(boneName);
  if (!rest) {
    rest = node.position.clone();
    restMap.set(boneName, rest);
  }

  targetPosition.copy(rest).add(offset);
  node.position.lerp(targetPosition, MathUtils.clamp(amount, 0, 1));
  return true;
}

function setExpression(
  vrm: VRM,
  preset: string,
  weight: number,
  amount: number,
): boolean {
  const manager = vrm.expressionManager;
  if (!manager?.getExpression(preset)) return false;
  const current = manager.getValue(preset) ?? 0;
  manager.setValue(
    preset,
    MathUtils.lerp(current, MathUtils.clamp(weight, 0, 1), MathUtils.clamp(amount, 0, 1)),
  );
  return true;
}

function applyFace(vrm: VRM, face: TFace, options: Required<VrmRigOptions>, missing: Set<VRMHumanBoneNameValue>, hasIris: boolean): void {
  if (
    !slerpVrmBoneRotation(vrm, VRMHumanBoneName.Head, face.head, {
      dampener: 0.7,
      slerp: options.rotationSlerp,
    })
  ) {
    missing.add(VRMHumanBoneName.Head);
  }
  // Distribute a little motion into the neck when the model provides one.
  slerpVrmBoneRotation(vrm, VRMHumanBoneName.Neck, face.head, {
    dampener: 0.25,
    slerp: options.rotationSlerp,
  });

  const expressionAmount = options.expressionLerp;
  const leftBlink = 1 - face.eye.l;
  const rightBlink = 1 - face.eye.r;
  const hasLeftBlink = setExpression(
    vrm,
    VRMExpressionPresetName.BlinkLeft,
    leftBlink,
    expressionAmount,
  );
  const hasRightBlink = setExpression(
    vrm,
    VRMExpressionPresetName.BlinkRight,
    rightBlink,
    expressionAmount,
  );
  if (!hasLeftBlink && !hasRightBlink) {
    setExpression(
      vrm,
      VRMExpressionPresetName.Blink,
      (leftBlink + rightBlink) / 2,
      expressionAmount,
    );
  }
  setExpression(vrm, VRMExpressionPresetName.Aa, face.mouth.shape.A, expressionAmount);
  setExpression(vrm, VRMExpressionPresetName.Ih, face.mouth.shape.I, expressionAmount);
  setExpression(vrm, VRMExpressionPresetName.Ou, face.mouth.shape.U, expressionAmount);
  setExpression(vrm, VRMExpressionPresetName.Ee, face.mouth.shape.E, expressionAmount);
  setExpression(vrm, VRMExpressionPresetName.Oh, face.mouth.shape.O, expressionAmount);

  // Closed eyelids obscure the iris: hold the previous gaze during blinks.
  // VRM range maps already limit the actual eyeball rotation; their input is
  // not the final rotation in degrees (18 degrees used to barely move it).
  if (vrm.lookAt && hasIris && face.eye.l > 0.5 && face.eye.r > 0.5) {
    vrm.lookAt.autoUpdate = false;
    const targetYaw = MathUtils.clamp(-face.pupil.x, -1, 1) * options.maxLookYawDegrees;
    const targetPitch = MathUtils.clamp(face.pupil.y, -1, 1) * options.maxLookPitchDegrees;
    vrm.lookAt.yaw = MathUtils.lerp(vrm.lookAt.yaw, targetYaw, expressionAmount);
    vrm.lookAt.pitch = MathUtils.lerp(vrm.lookAt.pitch, targetPitch, expressionAmount);
  }
}

const POSE_BONES: readonly [VRMHumanBoneNameValue, keyof TPose, number][] = [
  [VRMHumanBoneName.Hips, "Hips", 0.7],
  [VRMHumanBoneName.Spine, "Spine", 0.45],
  [VRMHumanBoneName.Chest, "Spine", 0.25],
  [VRMHumanBoneName.LeftUpperArm, "LeftUpperArm", 1],
  [VRMHumanBoneName.LeftLowerArm, "LeftLowerArm", 1],
  [VRMHumanBoneName.LeftHand, "LeftHand", 0.9],
  [VRMHumanBoneName.RightUpperArm, "RightUpperArm", 1],
  [VRMHumanBoneName.RightLowerArm, "RightLowerArm", 1],
  [VRMHumanBoneName.RightHand, "RightHand", 0.9],
  [VRMHumanBoneName.LeftUpperLeg, "LeftUpperLeg", 1],
  [VRMHumanBoneName.LeftLowerLeg, "LeftLowerLeg", 1],
  [VRMHumanBoneName.RightUpperLeg, "RightUpperLeg", 1],
  [VRMHumanBoneName.RightLowerLeg, "RightLowerLeg", 1],
] as const;

function isEulerLike(value: unknown): value is EulerLike {
  if (!value || typeof value !== "object") return false;
  const rotation = value as Partial<EulerLike>;
  return [rotation.x, rotation.y, rotation.z].every(Number.isFinite);
}

function applyPose(vrm: VRM, pose: TPose, options: Required<VrmRigOptions>, missing: Set<VRMHumanBoneNameValue>, trackedHands: { left: boolean; right: boolean }): void {
  for (const [bone, solutionKey, dampener] of POSE_BONES) {
    if (!options.enableLegs && (solutionKey.includes("Leg") || solutionKey.includes("Foot"))) continue;
    if (!options.applyHipsRotation && bone === VRMHumanBoneName.Hips) continue;
    // A tracked wrist is merged with the pose in applyHand. Do not blend it
    // twice toward competing targets in the same frame.
    if (bone === VRMHumanBoneName.LeftHand && trackedHands.left) continue;
    if (bone === VRMHumanBoneName.RightHand && trackedHands.right) continue;
    const solution = solutionKey === "Hips" ? pose.Hips.rotation : pose[solutionKey];
    if (!isEulerLike(solution)) continue;
    if (
      !slerpVrmBoneRotation(vrm, bone, solution, {
        dampener,
        slerp: options.rotationSlerp,
      })
    ) {
      missing.add(bone);
    }
  }

  if (options.applyHipsPosition) {
    const hips = pose.Hips.position;
    transformVrmTrackingVector(
      vrm,
      hipsOffset
        .set(-hips.x, hips.y, -hips.z)
        .multiplyScalar(options.hipsPositionScale),
    );
    if (!lerpVrmBonePosition(vrm, VRMHumanBoneName.Hips, hipsOffset, options.positionLerp)) {
      missing.add(VRMHumanBoneName.Hips);
    }
  }
}

const LEFT_FINGER_BONES: readonly [string, VRMHumanBoneNameValue][] = [
  ["LeftThumbProximal", VRMHumanBoneName.LeftThumbMetacarpal],
  ["LeftThumbIntermediate", VRMHumanBoneName.LeftThumbProximal],
  ["LeftThumbDistal", VRMHumanBoneName.LeftThumbDistal],
  ["LeftIndexProximal", VRMHumanBoneName.LeftIndexProximal],
  ["LeftIndexIntermediate", VRMHumanBoneName.LeftIndexIntermediate],
  ["LeftIndexDistal", VRMHumanBoneName.LeftIndexDistal],
  ["LeftMiddleProximal", VRMHumanBoneName.LeftMiddleProximal],
  ["LeftMiddleIntermediate", VRMHumanBoneName.LeftMiddleIntermediate],
  ["LeftMiddleDistal", VRMHumanBoneName.LeftMiddleDistal],
  ["LeftRingProximal", VRMHumanBoneName.LeftRingProximal],
  ["LeftRingIntermediate", VRMHumanBoneName.LeftRingIntermediate],
  ["LeftRingDistal", VRMHumanBoneName.LeftRingDistal],
  ["LeftLittleProximal", VRMHumanBoneName.LeftLittleProximal],
  ["LeftLittleIntermediate", VRMHumanBoneName.LeftLittleIntermediate],
  ["LeftLittleDistal", VRMHumanBoneName.LeftLittleDistal],
] as const;

const RIGHT_FINGER_BONES: readonly [string, VRMHumanBoneNameValue][] = [
  ["RightThumbProximal", VRMHumanBoneName.RightThumbMetacarpal],
  ["RightThumbIntermediate", VRMHumanBoneName.RightThumbProximal],
  ["RightThumbDistal", VRMHumanBoneName.RightThumbDistal],
  ["RightIndexProximal", VRMHumanBoneName.RightIndexProximal],
  ["RightIndexIntermediate", VRMHumanBoneName.RightIndexIntermediate],
  ["RightIndexDistal", VRMHumanBoneName.RightIndexDistal],
  ["RightMiddleProximal", VRMHumanBoneName.RightMiddleProximal],
  ["RightMiddleIntermediate", VRMHumanBoneName.RightMiddleIntermediate],
  ["RightMiddleDistal", VRMHumanBoneName.RightMiddleDistal],
  ["RightRingProximal", VRMHumanBoneName.RightRingProximal],
  ["RightRingIntermediate", VRMHumanBoneName.RightRingIntermediate],
  ["RightRingDistal", VRMHumanBoneName.RightRingDistal],
  ["RightLittleProximal", VRMHumanBoneName.RightLittleProximal],
  ["RightLittleIntermediate", VRMHumanBoneName.RightLittleIntermediate],
  ["RightLittleDistal", VRMHumanBoneName.RightLittleDistal],
] as const;

function applyHand(
  vrm: VRM,
  side: "Left" | "Right",
  hand: KalidokitHandSolution,
  pose: TPose | undefined,
  options: Required<VrmRigOptions>,
  missing: Set<VRMHumanBoneNameValue>,
): void {
  const wrist = hand[`${side}Wrist`];
  const poseHand = pose?.[`${side}Hand` as "LeftHand" | "RightHand"];
  const handBone = side === "Left" ? VRMHumanBoneName.LeftHand : VRMHumanBoneName.RightHand;

  if (wrist) {
    const mergedWrist: EulerLike = {
      x: wrist.x,
      y: wrist.y,
      z: poseHand?.z ?? wrist.z,
    };
    if (!slerpVrmBoneRotation(vrm, handBone, mergedWrist, { slerp: options.rotationSlerp })) {
      missing.add(handBone);
    }
  }

  const fingerMap = side === "Left" ? LEFT_FINGER_BONES : RIGHT_FINGER_BONES;
  for (const [solutionKey, bone] of fingerMap) {
    const rotation = hand[solutionKey];
    if (!rotation) continue;
    if (!slerpVrmBoneRotation(vrm, bone, rotation, { slerp: options.fingerSlerp })) {
      missing.add(bone);
    }
  }
}

function resolveRigOptions(options: VrmRigOptions): Required<VrmRigOptions> {
  const deltaSeconds = Number.isFinite(options.deltaSeconds)
    ? MathUtils.clamp(options.deltaSeconds!, 1 / 120, 0.1)
    : 1 / 30;
  const response = (value: number) => 1 - Math.pow(1 - MathUtils.clamp(value, 0, 1), deltaSeconds * 30);
  return {
    deltaSeconds,
    rotationSlerp: response(options.rotationSlerp ?? 0.5),
    fingerSlerp: response(options.fingerSlerp ?? 0.7),
    positionLerp: response(options.positionLerp ?? 0.4),
    expressionLerp: response(options.expressionLerp ?? 0.65),
    hipsPositionScale: options.hipsPositionScale ?? 1,
    applyHipsPosition: options.applyHipsPosition ?? true,
    applyHipsRotation: options.applyHipsRotation ?? true,
    enableLegs: options.enableLegs ?? true,
    maxLookYawDegrees: Math.max(0, options.maxLookYawDegrees ?? 60),
    maxLookPitchDegrees: Math.max(0, options.maxLookPitchDegrees ?? 45),
  };
}

function solveHand(
  landmarks: ReturnType<typeof finiteLandmarks>,
  worldLandmarks: MediaPipeLandmarkList | null | undefined,
  side: "Left" | "Right",
): KalidokitHandSolution | undefined {
  if (!landmarks) return undefined;
  const solved = Hand.solve(landmarks as Parameters<typeof Hand.solve>[0], side) as KalidokitHandSolution | undefined;
  const world = finiteLandmarks(worldLandmarks, 21);
  if (!solved || !world) return solved;
  // Keep Kalidoface's image-space wrist convention, but solve finger curls
  // in metric 3D space so widescreen video does not distort joint angles.
  const fingers = Hand.solve(world as Parameters<typeof Hand.solve>[0], side) as KalidokitHandSolution | undefined;
  return fingers ? { ...fingers, [`${side}Wrist`]: solved[`${side}Wrist`] } : solved;
}

function restoreVisibleArms(pose: TPose, world: NonNullable<ReturnType<typeof finiteLandmarks>>, image: NonNullable<ReturnType<typeof finiteLandmarks>>) {
  // Kalidokit's legacy offscreen heuristic drops wrists below world y=0.1,
  // even while an entire arm is visible. Use actual image bounds/confidence.
  const visible = (indices: number[]) => indices.every((index) => {
    const point = image[index];
    return point.x > 0.01 && point.x < 0.99 && point.y > 0.01 && point.y < 0.99 &&
      (point.visibility ?? world[index].visibility ?? 1) >= 0.5;
  });
  const arms = Pose.calcArms(world as Parameters<typeof Pose.calcArms>[0]);
  if (visible([11, 13, 15])) {
    pose.RightUpperArm = arms.UpperArm.r;
    pose.RightLowerArm = arms.LowerArm.r;
    pose.RightHand = arms.Hand.r;
  }
  if (visible([12, 14, 16])) {
    pose.LeftUpperArm = arms.UpperArm.l;
    pose.LeftLowerArm = arms.LowerArm.l;
    pose.LeftHand = arms.Hand.l;
  }
}

function fallbackEyeOpenness(points: NonNullable<ReturnType<typeof finiteLandmarks>>, edge: [number, number], lids: [number, number][]) {
  // Face.solve rescales this private clone to pixels. Blink landmarks exist
  // even in a 468-point face, although Kalidokit disables its eye solver.
  const distance = (a: number, b: number) => Math.hypot(points[a].x - points[b].x, points[a].y - points[b].y);
  const width = distance(...edge);
  if (width < 1e-6) return 1;
  const opening = lids.reduce((sum, pair) => sum + distance(...pair), 0) / lids.length / width;
  return MathUtils.clamp((opening / 0.285 - 0.35) / 0.15, 0, 1);
}

/** Solve a MediaPipe Tasks-style landmark frame with Kalidokit and apply it to a VRM. */
export function applyVrmTracking(
  vrm: VRM,
  frame: VrmTrackingFrame,
  rigOptions: VrmRigOptions = {},
): VrmRigResult {
  const options = resolveRigOptions(rigOptions);
  const missing = new Set<VRMHumanBoneNameValue>();

  const faceLandmarks = finiteLandmarks(frame.faceLandmarks, 468);
  const poseLandmarks = finiteLandmarks(frame.poseLandmarks, 33);
  const poseWorldLandmarks = finiteLandmarks(frame.poseWorldLandmarks, 33);
  const leftHandLandmarks = finiteLandmarks(frame.leftHandLandmarks, 21);
  const rightHandLandmarks = finiteLandmarks(frame.rightHandLandmarks, 21);
  const faceImageSize = finiteImageSize(frame.imageSize);

  const solvedFace = faceLandmarks
    ? Face.solve(faceLandmarks as Parameters<typeof Face.solve>[0], {
        runtime: "mediapipe",
        smoothBlink: false,
        ...(faceImageSize ? { imageSize: faceImageSize } : {}),
      })
    : undefined;
  const solvedPose =
    poseLandmarks && poseWorldLandmarks
      ? Pose.solve(
          poseWorldLandmarks as Parameters<typeof Pose.solve>[0],
          poseLandmarks as Parameters<typeof Pose.solve>[1],
          { runtime: "mediapipe", enableLegs: options.enableLegs },
        )
      : undefined;
  const solvedLeftHand = solveHand(leftHandLandmarks, frame.leftHandWorldLandmarks, "Left");
  const solvedRightHand = solveHand(rightHandLandmarks, frame.rightHandWorldLandmarks, "Right");

  if (solvedPose && poseWorldLandmarks && poseLandmarks) restoreVisibleArms(solvedPose, poseWorldLandmarks, poseLandmarks);
  if (solvedFace && faceLandmarks && faceLandmarks.length < 478) {
    solvedFace.eye = {
      l: fallbackEyeOpenness(faceLandmarks, [33, 133], [[160, 144], [159, 145], [158, 153]]),
      r: fallbackEyeOpenness(faceLandmarks, [263, 362], [[387, 373], [386, 374], [385, 380]]),
    };
  }

  if (solvedPose) applyPose(vrm, solvedPose, options, missing, { left: Boolean(solvedLeftHand), right: Boolean(solvedRightHand) });
  if (solvedFace) applyFace(vrm, solvedFace, options, missing, (faceLandmarks?.length ?? 0) >= 478);
  if (solvedLeftHand) applyHand(vrm, "Left", solvedLeftHand, solvedPose, options, missing);
  if (solvedRightHand) applyHand(vrm, "Right", solvedRightHand, solvedPose, options, missing);

  return {
    faceApplied: Boolean(solvedFace),
    poseApplied: Boolean(solvedPose),
    leftHandApplied: Boolean(solvedLeftHand),
    rightHandApplied: Boolean(solvedRightHand),
    missingBones: [...missing],
  };
}
