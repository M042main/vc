import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Euler, Object3D, Vector3 } from "three";
import ts from "typescript";

const motionUrl = new URL("../app/lib/vrmMotion.ts", import.meta.url);

async function loadMotionModule() {
  const source = await readFile(motionUrl, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "vrmMotion.ts",
  }).outputText;
  const runnable = output
    .replace(
      /from\s+["']three["']/g,
      `from ${JSON.stringify(import.meta.resolve("three"))}`,
    )
    .replace(
      /from\s+["']@pixiv\/three-vrm["']/g,
      `from ${JSON.stringify(import.meta.resolve("@pixiv/three-vrm"))}`,
    );
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(runnable).toString("base64")}`;
  return import(moduleUrl);
}

const motionModule = loadMotionModule();
const point = new Vector3();

function applyRotation(node, rotation) {
  node.quaternion.setFromEuler(
    new Euler(rotation[0], rotation[1], rotation[2], "XYZ"),
  );
}

/**
 * Recreates the normalized VRM upper-body hierarchy. Joint positions are read
 * with getWorldPosition so a test covers every parent quaternion, rather than
 * treating upper/lower arm Euler values as independent angles.
 */
function armWorldPositions(rotations, side) {
  const isLeft = side === "left";
  const direction = isLeft ? -1 : 1;
  const root = new Object3D();
  const hips = new Object3D();
  const spine = new Object3D();
  const chest = new Object3D();
  const upperChest = new Object3D();
  const neck = new Object3D();
  const head = new Object3D();
  const headTop = new Object3D();
  const shoulder = new Object3D();
  const upperArm = new Object3D();
  const lowerArm = new Object3D();
  const hand = new Object3D();

  root.add(hips);
  hips.add(spine);
  spine.add(chest);
  chest.add(upperChest);
  upperChest.add(neck, shoulder);
  neck.add(head);
  head.add(headTop);
  shoulder.add(upperArm);
  upperArm.add(lowerArm);
  lowerArm.add(hand);

  hips.position.set(0, 1, 0);
  spine.position.set(0, 0.35, 0);
  chest.position.set(0, 0.35, 0);
  upperChest.position.set(0, 0.3, 0);
  neck.position.set(0, 0.2, 0);
  head.position.set(0, 0.28, 0);
  headTop.position.set(0, 0.34, 0);
  shoulder.position.set(direction * 0.18, 0.12, 0);
  upperArm.position.set(direction * 0.16, 0, 0);
  lowerArm.position.set(direction * 0.55, 0, 0);
  hand.position.set(direction * 0.48, 0, 0);

  applyRotation(hips, rotations.hips);
  applyRotation(spine, rotations.spine);
  applyRotation(chest, rotations.chest);
  applyRotation(upperChest, rotations.upperChest);
  applyRotation(neck, rotations.neck);
  applyRotation(head, rotations.head);
  applyRotation(shoulder, rotations[`${side}Shoulder`]);
  applyRotation(upperArm, rotations[`${side}UpperArm`]);
  applyRotation(lowerArm, rotations[`${side}LowerArm`]);
  applyRotation(hand, rotations[`${side}Hand`]);

  root.updateMatrixWorld(true);
  const world = (node) => node.getWorldPosition(point.clone());
  return {
    shoulder: world(upperArm),
    elbow: world(lowerArm),
    wrist: world(hand),
    headTop: world(headTop),
  };
}

function relative(from, to) {
  return to.clone().sub(from);
}

function samplePhases(sampleVrmMotion, getVrmMotionPreset, preset, count = 32) {
  const duration = getVrmMotionPreset(preset).durationMs;
  return Array.from({ length: count + 1 }, (_, step) => ({
    progress: step / count,
    rotations: sampleVrmMotion(preset, (duration * step) / count, false).pose
      .rotations,
  }));
}

function assertArmDown(positions, label) {
  const elbow = relative(positions.shoulder, positions.elbow);
  const wrist = relative(positions.shoulder, positions.wrist);
  assert.ok(elbow.y < -0.42, `${label}: elbow is not down (${elbow.y})`);
  assert.ok(wrist.y < -0.8, `${label}: wrist is not down (${wrist.y})`);
}

test("idle keeps both normalized VRM arms down through the breathing cycle", async () => {
  const { getVrmMotionPreset, sampleVrmMotion } = await motionModule;
  const samples = samplePhases(sampleVrmMotion, getVrmMotionPreset, "idle");

  for (const { progress, rotations } of samples) {
    assertArmDown(
      armWorldPositions(rotations, "left"),
      `idle left at ${progress}`,
    );
    assertArmDown(
      armWorldPositions(rotations, "right"),
      `idle right at ${progress}`,
    );
  }
});

test("walk keeps both arms down while preserving a visible counter-swing", async () => {
  const { getVrmMotionPreset, sampleVrmMotion } = await motionModule;
  const samples = samplePhases(sampleVrmMotion, getVrmMotionPreset, "walk");
  let largestCounterSwing = 0;

  for (const { progress, rotations } of samples) {
    const left = armWorldPositions(rotations, "left");
    const right = armWorldPositions(rotations, "right");
    assertArmDown(left, `walk left at ${progress}`);
    assertArmDown(right, `walk right at ${progress}`);

    const leftElbow = relative(left.shoulder, left.elbow);
    const rightElbow = relative(right.shoulder, right.elbow);
    assert.ok(
      Math.abs(leftElbow.z + rightElbow.z) < 0.035,
      `walk counter-swing lost symmetry at ${progress}`,
    );
    largestCounterSwing = Math.max(
      largestCounterSwing,
      Math.abs(leftElbow.z - rightElbow.z),
    );
  }

  assert.ok(largestCounterSwing > 0.2, "walk arms must still visibly counter-swing");
});

test("dance stays energetic without pinning either hand above the head", async () => {
  const { getVrmMotionPreset, sampleVrmMotion } = await motionModule;
  const samples = samplePhases(sampleVrmMotion, getVrmMotionPreset, "dance", 48);
  const wristHeights = { left: [], right: [] };
  const wristDepths = { left: [], right: [] };

  for (const { progress, rotations } of samples) {
    for (const side of ["left", "right"]) {
      const arm = armWorldPositions(rotations, side);
      assert.ok(
        arm.elbow.y < arm.shoulder.y + 0.08,
        `dance ${side} elbow rose unnaturally at ${progress}`,
      );
      assert.ok(
        arm.wrist.y < arm.headTop.y - 0.12,
        `dance ${side} wrist became fixed above the head at ${progress}`,
      );
      wristHeights[side].push(arm.wrist.y);
      wristDepths[side].push(arm.wrist.z);
    }
  }

  for (const side of ["left", "right"]) {
    const verticalRange = Math.max(...wristHeights[side]) - Math.min(...wristHeights[side]);
    const depthRange = Math.max(...wristDepths[side]) - Math.min(...wristDepths[side]);
    assert.ok(
      verticalRange > 0.12 && depthRange > 0.12,
      `dance ${side} arm must keep an energetic moving range`,
    );
  }
});

test("greeting starts and ends down, waves only the right hand, and keeps the left down", async () => {
  const { getVrmMotionPreset, sampleVrmMotion } = await motionModule;
  const samples = samplePhases(
    sampleVrmMotion,
    getVrmMotionPreset,
    "greeting",
    80,
  );
  const greetingWristX = [];
  const greetingWristY = [];

  for (const { progress, rotations } of samples) {
    const left = armWorldPositions(rotations, "left");
    const right = armWorldPositions(rotations, "right");
    assertArmDown(left, `greeting left at ${progress}`);

    if (progress === 0 || progress === 1) {
      assertArmDown(right, `greeting right endpoint at ${progress}`);
    }
    if (progress >= 0.25 && progress <= 0.75) {
      greetingWristX.push(right.wrist.x);
      greetingWristY.push(right.wrist.y - right.shoulder.y);
      assert.ok(
        right.wrist.y > right.shoulder.y + 0.18,
        `greeting right hand did not reach waving height at ${progress}`,
      );
      assert.ok(
        right.wrist.y < right.headTop.y + 0.2,
        `greeting right hand exceeded a natural waving range at ${progress}`,
      );
    }
  }

  assert.ok(
    Math.min(...greetingWristY) > 0.18,
    "greeting must hold the right hand beside the head",
  );
  assert.ok(
    Math.max(...greetingWristX) - Math.min(...greetingWristX) > 0.08,
    "greeting must visibly wave the raised right hand",
  );
});
