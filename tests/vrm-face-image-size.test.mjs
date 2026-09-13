import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { Object3D } from "three";

const rigUrl = new URL("../app/lib/vrmRig.ts", import.meta.url);
const HARNESS_KEY = "__virtualCreatorVrmFaceHarness";
let importSequence = 0;

function solvedFace() {
  return {
    head: { x: 0, y: 0, z: 0 },
    eye: { l: 1, r: 1 },
    brow: 0,
    pupil: { x: 0, y: 0 },
    mouth: {
      x: 0,
      y: 0,
      shape: { A: 0, E: 0, I: 0, O: 0, U: 0 },
    },
  };
}

async function loadRigModule(faceCalls, overrides = {}) {
  globalThis[HARNESS_KEY] = {
    Face: {
      solve(landmarks, options) {
        faceCalls.push({ landmarks, options });
        // Kalidokit performs this kind of in-place rescale for MediaPipe input.
        // Mutating here proves that applyVrmTracking owns a defensive clone.
        if (options.imageSize) landmarks[0].x *= options.imageSize.width;
        return solvedFace();
      },
    },
    Hand: { solve: () => undefined },
    Pose: { solve: () => undefined },
    ...overrides,
  };

  const source = await readFile(rigUrl, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "vrmRig.ts",
  }).outputText;
  const runnable = output
    .replace(/from\s+["']three["']/gu, `from ${JSON.stringify(import.meta.resolve("three"))}`)
    .replace(
      /from\s+["']three\/examples\/jsm\/loaders\/GLTFLoader\.js["']/gu,
      `from ${JSON.stringify(import.meta.resolve("three/examples/jsm/loaders/GLTFLoader.js"))}`,
    )
    .replace(
      /from\s+["']@pixiv\/three-vrm["']/gu,
      `from ${JSON.stringify(import.meta.resolve("@pixiv/three-vrm"))}`,
    )
    .replace(
      /import\s*\{\s*Face\s*,\s*Hand\s*,\s*Pose\s*\}\s*from\s*["']kalidokit["'];?/u,
      `const { Face, Hand, Pose } = globalThis[${JSON.stringify(HARNESS_KEY)}];`,
    );

  const moduleUrl = `data:text/javascript;base64,${Buffer.from(runnable).toString("base64")}`;
  return import(`${moduleUrl}#face-harness-${(importSequence += 1)}`);
}

function mockVrm() {
  return {
    meta: { metaVersion: "1" },
    humanoid: { getNormalizedBoneNode: () => null },
  };
}

function faceLandmarks() {
  return Array.from({ length: 478 }, (_, index) => ({
    x: 0.1 + index / 10_000,
    y: 0.2 + index / 20_000,
    z: -0.01,
    visibility: 0.9,
  }));
}

test("passes exact inference dimensions to Kalidokit without mutating caller landmarks", async () => {
  const faceCalls = [];
  const { applyVrmTracking } = await loadRigModule(faceCalls);
  const landmarks = faceLandmarks();
  const imageSize = { width: 640, height: 360 };
  const originalFirst = { ...landmarks[0] };

  const result = applyVrmTracking(mockVrm(), {
    faceLandmarks: landmarks,
    imageSize,
  });

  assert.equal(result.faceApplied, true);
  assert.equal(faceCalls.length, 1);
  assert.deepEqual(faceCalls[0].options.imageSize, imageSize);
  assert.notEqual(faceCalls[0].options.imageSize, imageSize, "image dimensions are copied");
  assert.notEqual(faceCalls[0].landmarks, landmarks, "landmark array is copied");
  assert.notEqual(faceCalls[0].landmarks[0], landmarks[0], "landmark objects are copied");
  assert.notDeepEqual(
    faceCalls[0].landmarks[0],
    originalFirst,
    "the solver stub exercised its in-place MediaPipe rescale",
  );
  assert.deepEqual(landmarks[0], originalFirst, "worker-owned landmarks remain unchanged");
});

function expressiveVrm() {
  const values = new Map();
  const nodes = new Map();
  return {
    meta: { metaVersion: "0" },
    humanoid: { getNormalizedBoneNode(name) {
      if (!nodes.has(name)) nodes.set(name, new Object3D());
      return nodes.get(name);
    } },
    expressionManager: {
      getExpression: () => ({}),
      getValue: (name) => values.get(name) ?? 0,
      setValue: (name, value) => values.set(name, value),
    },
    lookAt: { autoUpdate: true, yaw: 0, pitch: 0 },
    values, nodes,
  };
}

test("preserves independent winks and freezes iris motion while blinking", async () => {
  const face = solvedFace();
  face.pupil = { x: 1, y: 1 };
  const { applyVrmTracking } = await loadRigModule([], { Face: { solve: () => structuredClone(face) } });
  const vrm = expressiveVrm();
  const frame = { faceLandmarks: faceLandmarks() };
  applyVrmTracking(vrm, frame, { expressionLerp: 1 });
  assert.equal(vrm.lookAt.yaw, -60, "look-at input must reach the model range map");
  assert.equal(vrm.lookAt.pitch, 45);
  face.eye = { l: 0, r: 1 };
  face.pupil = { x: -1, y: -1 };
  applyVrmTracking(vrm, frame, { expressionLerp: 1 });
  assert.equal(vrm.values.get("blinkLeft"), 1);
  assert.equal(vrm.values.get("blinkRight"), 0);
  assert.equal(vrm.lookAt.yaw, -60, "a hidden iris must not cause a gaze jump");
});

test("eyelid tracking still works with a 468-point face and does not fabricate gaze", async () => {
  const { applyVrmTracking } = await loadRigModule([]);
  const vrm = expressiveVrm();
  vrm.lookAt.yaw = 12;
  const points = Array.from({ length: 468 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  points[33].x = 0.4;
  points[133].x = 0.6;
  points[263].x = 0.4;
  points[362].x = 0.6;
  applyVrmTracking(vrm, { faceLandmarks: points }, { expressionLerp: 1 });
  assert.equal(vrm.values.get("blinkLeft"), 1);
  assert.equal(vrm.values.get("blinkRight"), 1);
  assert.equal(vrm.lookAt.yaw, 12);
});

test("response is stable across 15/30 Hz inference and fingers use metric 3D curl", async () => {
  const calls = [];
  const { applyVrmTracking } = await loadRigModule([], { Hand: { solve(points, side) {
    calls.push({ x: points[0].x, side });
    return {
      [`${side}Wrist`]: { x: points[0].x, y: 0, z: 0 },
      [`${side}IndexProximal`]: { x: 0, y: 0, z: points[0].x },
    };
  } } });
  const points = Array.from({ length: 21 }, () => ({ x: 0.2, y: 0.3, z: 0 }));
  const world = points.map((point) => ({ ...point, x: 1 }));
  const frame = { leftHandLandmarks: points, leftHandWorldLandmarks: world };
  const at30 = expressiveVrm();
  const at15 = expressiveVrm();
  for (let i = 0; i < 2; i++) applyVrmTracking(at30, frame, { deltaSeconds: 1 / 30 });
  applyVrmTracking(at15, frame, { deltaSeconds: 1 / 15 });
  const finger30 = at30.nodes.get("leftIndexProximal").quaternion;
  const finger15 = at15.nodes.get("leftIndexProximal").quaternion;
  assert.ok(finger30.angleTo(finger15) < 1e-7);
  assert.ok(Math.abs(2 * Math.asin(finger30.z) - 0.91) < 1e-7, "finger target uses world landmarks");
  assert.ok(Math.abs(2 * Math.asin(at30.nodes.get("leftHand").quaternion.x) - 0.15) < 1e-7, "wrist retains image-space convention");
  assert.deepEqual(calls.slice(0, 2), [{ x: 0.2, side: "Left" }, { x: 1, side: "Left" }]);
});

test("restores visible lowered arms and blends tracked wrists only once", async () => {
  const rotation = (x, y = 0, z = 0) => ({ x, y, z });
  const arms = { UpperArm: { l: rotation(0.8), r: rotation(0.6) }, LowerArm: { l: rotation(0.4), r: rotation(0.3) }, Hand: { l: rotation(0, 0, 0.1), r: rotation(0, 0, 0.2) } };
  const { applyVrmTracking } = await loadRigModule([], {
    Pose: {
      solve: () => ({ Hips: { rotation: rotation(0), position: rotation(0) }, LeftUpperArm: rotation(0), RightUpperArm: rotation(0) }),
      calcArms: () => arms,
    },
    Hand: { solve: () => ({ LeftWrist: rotation(1, 0, 0.9) }) },
  });
  const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.7, z: 0, visibility: 1 }));
  const vrm = expressiveVrm();
  applyVrmTracking(vrm, { poseLandmarks: points, poseWorldLandmarks: points, leftHandLandmarks: points.slice(0, 21) }, { rotationSlerp: 0.5, applyHipsPosition: false });
  assert.ok(Math.abs(2 * Math.asin(vrm.nodes.get("leftUpperArm").quaternion.x) - 0.4) < 1e-7);
  const expected = new Object3D();
  expected.rotation.set(1, 0, 0.1);
  const halfway = new Object3D().quaternion.slerp(expected.quaternion, 0.5);
  assert.ok(halfway.angleTo(vrm.nodes.get("leftHand").quaternion) < 1e-7);
  points[16].visibility = 0.1;
  const hidden = expressiveVrm();
  applyVrmTracking(hidden, { poseLandmarks: points, poseWorldLandmarks: points }, { applyHipsPosition: false });
  assert.equal(hidden.nodes.get("leftUpperArm").quaternion.x, 0, "an occluded arm must keep the solver's fallback");
});

test("omits invalid image dimensions instead of feeding them to Kalidokit", async () => {
  const faceCalls = [];
  const { applyVrmTracking } = await loadRigModule(faceCalls);
  const invalidSizes = [
    null,
    { width: 0, height: 360 },
    { width: -640, height: 360 },
    { width: Number.NaN, height: 360 },
    { width: 640, height: Number.POSITIVE_INFINITY },
  ];

  for (const imageSize of invalidSizes) {
    applyVrmTracking(mockVrm(), { faceLandmarks: faceLandmarks(), imageSize });
  }

  assert.equal(faceCalls.length, invalidSizes.length);
  for (const call of faceCalls) {
    assert.equal(
      Object.hasOwn(call.options, "imageSize"),
      false,
      "invalid dimensions must fall back to Kalidokit's unscaled input path",
    );
  }
});
