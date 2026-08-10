import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Euler, Quaternion, Vector3 } from "three";
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

function quaternionFrom(rotation) {
  return new Quaternion().setFromEuler(
    new Euler(rotation[0], rotation[1], rotation[2], "XYZ"),
  );
}

function armDirections(rotations, side) {
  const isLeft = side === "left";
  const restDirection = new Vector3(isLeft ? -1 : 1, 0, 0);
  const shoulder = quaternionFrom(rotations[`${side}Shoulder`]);
  const upper = quaternionFrom(rotations[`${side}UpperArm`]);
  const lower = quaternionFrom(rotations[`${side}LowerArm`]);
  const upperWorld = shoulder.clone().multiply(upper);
  const lowerWorld = upperWorld.clone().multiply(lower);
  const upperDirection = restDirection.clone().applyQuaternion(upperWorld);
  const lowerDirection = restDirection.clone().applyQuaternion(lowerWorld);
  return {
    upperDirection,
    wristDirection: upperDirection.clone().add(lowerDirection),
  };
}

function assertTupleClose(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label} tuple length`);
  actual.forEach((value, index) => {
    assert.ok(
      Math.abs(value - expected[index]) < 1e-9,
      `${label}[${index}] expected ${expected[index]}, got ${value}`,
    );
  });
}

test("walk keeps both normalized VRM arms down with a small opposing swing", async () => {
  const { getVrmMotionPreset, sampleVrmMotion } = await motionModule;
  const duration = getVrmMotionPreset("walk").durationMs;
  let largestForwardSwing = 0;

  for (let step = 0; step < 8; step += 1) {
    const pose = sampleVrmMotion("walk", (duration * step) / 8, false).pose;
    const left = armDirections(pose.rotations, "left");
    const right = armDirections(pose.rotations, "right");

    assert.ok(left.upperDirection.y < -0.82, `left elbow rose at step ${step}`);
    assert.ok(right.upperDirection.y < -0.82, `right elbow rose at step ${step}`);
    assert.ok(left.wristDirection.y < -1.62, `left wrist rose at step ${step}`);
    assert.ok(right.wristDirection.y < -1.62, `right wrist rose at step ${step}`);
    assert.ok(
      Math.abs(left.upperDirection.z) < 0.27 &&
        Math.abs(right.upperDirection.z) < 0.27,
      `walk arm swing became too large at step ${step}`,
    );
    assert.ok(
      Math.abs(left.upperDirection.z + right.upperDirection.z) < 1e-9,
      `walk arms stopped counter-swinging at step ${step}`,
    );
    largestForwardSwing = Math.max(
      largestForwardSwing,
      Math.abs(left.upperDirection.z),
      Math.abs(right.upperDirection.z),
    );
  }

  assert.ok(largestForwardSwing > 0.2, "walk arms must still visibly swing");
});

test("walk arm fix leaves idle, dance, and greeting checkpoints unchanged", async () => {
  const { getVrmMotionPreset, sampleVrmMotion } = await motionModule;
  const atProgress = (preset, progress) =>
    sampleVrmMotion(
      preset,
      getVrmMotionPreset(preset).durationMs * progress,
      false,
    ).pose.rotations;

  const idle = atProgress("idle", 0.25);
  assertTupleClose(idle.leftUpperArm, [0.018, 0, -1.08], "idle leftUpperArm");
  assertTupleClose(idle.rightUpperArm, [-0.018, 0, 1.08], "idle rightUpperArm");

  const dance = atProgress("dance", 0.25);
  assertTupleClose(dance.leftUpperArm, [0, 0, -1.15], "dance leftUpperArm");
  assertTupleClose(dance.rightUpperArm, [0, 0, -0.35], "dance rightUpperArm");

  const greeting = atProgress("greeting", 0.5);
  assertTupleClose(greeting.leftUpperArm, [0, 0, -1.08], "greeting leftUpperArm");
  assertTupleClose(greeting.rightUpperArm, [0.12, -0.12, -0.32], "greeting rightUpperArm");
  assertTupleClose(greeting.rightLowerArm, [-0.32, 0, -0.9], "greeting rightLowerArm");
});
