import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

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

async function loadRigModule(faceCalls) {
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
