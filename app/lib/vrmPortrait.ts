import { Euler, type Object3D, type Mesh } from "three";
import { VRMHumanBoneName, type VRM } from "@pixiv/three-vrm";
import { captureVrmFullBodyPng, type CaptureVrmPngOptions } from "./vrmCapture";

function snapshotPose(vrm: VRM) {
  const nodes = new Set<Object3D>();
  vrm.scene.traverse((node) => nodes.add(node));
  vrm.humanoid.normalizedHumanBonesRoot.traverse((node) => nodes.add(node));
  return [...nodes].map((node) => ({
    node,
    position: node.position.clone(),
    quaternion: node.quaternion.clone(),
    scale: node.scale.clone(),
    morphs: (node as Mesh).morphTargetInfluences?.slice(),
  }));
}

function restorePose(snapshot: ReturnType<typeof snapshotPose>) {
  for (const { node, position, quaternion, scale, morphs } of snapshot) {
    node.position.copy(position);
    node.quaternion.copy(quaternion);
    node.scale.copy(scale);
    const influences = (node as Mesh).morphTargetInfluences;
    if (morphs && influences) for (let i = 0; i < morphs.length; i++) influences[i] = morphs[i];
    node.updateMatrix();
  }
}

const portraits = new WeakMap<VRM, ReturnType<typeof snapshotPose>>();

/** Remember a front-facing, relaxed standing portrait before any user manipulation. */
export function prepareVrmPortrait(vrm: VRM) {
  vrm.humanoid.resetNormalizedPose();
  for (const [bone, z] of [
    [VRMHumanBoneName.LeftUpperArm, 1.08],
    [VRMHumanBoneName.LeftLowerArm, 0.12],
    [VRMHumanBoneName.RightUpperArm, -1.08],
    [VRMHumanBoneName.RightLowerArm, -0.12],
  ] as const) {
    vrm.humanoid.getNormalizedBoneNode(bone)?.quaternion.setFromEuler(new Euler(0, 0, z));
  }
  vrm.humanoid.update();
  vrm.scene.updateWorldMatrix(true, true);
  portraits.set(vrm, snapshotPose(vrm));
}

/** Only the synchronous offscreen render sees the portrait; the live pose never changes on screen. */
export function captureVrmPortraitPng(options: CaptureVrmPngOptions) {
  const { vrm } = options;
  const portrait = portraits.get(vrm);
  if (!portrait) throw new Error("캐릭터의 기본 촬영 자세를 아직 준비하지 못했습니다.");
  const live = snapshotPose(vrm);
  try {
    restorePose(portrait);
    // captureVrmFullBodyPng reads pixels before its first await (PNG encoding).
    return captureVrmFullBodyPng(options);
  } finally {
    restorePose(live);
    vrm.scene.updateWorldMatrix(true, true);
  }
}
