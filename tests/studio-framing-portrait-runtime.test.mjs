import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as THREE from "three";
import { VRMHumanBoneName } from "@pixiv/three-vrm";
import { FaceLandmarker } from "@mediapipe/tasks-vision";

async function moduleBody(path) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return parsed.statements.filter((n) => !ts.isImportDeclaration(n)).map((n) => n.getText(parsed)).join("\n");
}
function evaluate(body, context) {
  vm.runInNewContext(ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText, context);
  return context.exports;
}

test("portrait capture uses relaxed full-body pose and restores live state before encoding completes", async () => {
  const scene = new THREE.Group();
  scene.rotation.y = Math.PI; // VRM 0 orientation must survive both paths.
  const front = scene.quaternion.clone();
  const root = new THREE.Group();
  const arm = new THREE.Bone();
  root.add(arm);
  scene.add(root);
  const mesh = new THREE.Mesh();
  mesh.morphTargetInfluences = [0];
  scene.add(mesh);
  const vrm = { scene, humanoid: { normalizedHumanBonesRoot: root,
    resetNormalizedPose() { arm.quaternion.identity(); },
    getNormalizedBoneNode(name) { return name === VRMHumanBoneName.LeftUpperArm ? arm : null; },
    update() {},
  } };
  let finish;
  let fail = false;
  const context = { exports: {}, Euler: THREE.Euler, VRMHumanBoneName,
    captureVrmFullBodyPng(options) {
      assert.equal(options.vrm, vrm);
      assert.ok(scene.quaternion.angleTo(front) < 1e-7);
      assert.ok(Math.abs(arm.rotation.z - 1.08) < 1e-6);
      assert.equal(mesh.morphTargetInfluences[0], 0);
      if (fail) throw new Error("render failed");
      return new Promise((resolve) => { finish = resolve; });
    },
  };
  const { prepareVrmPortrait, captureVrmPortraitPng } = evaluate(await moduleBody("../app/lib/vrmPortrait.ts"), context);
  prepareVrmPortrait(vrm);
  scene.position.set(5, 6, 7);
  scene.rotation.y = 0.5;
  arm.rotation.set(0.2, 0.4, 0.6);
  mesh.morphTargetInfluences[0] = 0.9;
  const before = arm.quaternion.clone();
  const pending = captureVrmPortraitPng({ vrm });
  assert.deepEqual(scene.position.toArray(), [5, 6, 7]);
  assert.equal(scene.rotation.y, 0.5);
  assert.ok(arm.quaternion.angleTo(before) < 1e-7);
  assert.equal(mesh.morphTargetInfluences[0], 0.9);
  finish("encoded");
  assert.equal(await pending, "encoded");
  fail = true;
  assert.throws(() => captureVrmPortraitPng({ vrm }), /render failed/);
  assert.equal(scene.rotation.y, 0.5);
  assert.ok(arm.quaternion.angleTo(before) < 1e-7);
});

test("overlay contains the full wide/portrait camera frame and mirrors all hand joints", async () => {
  const context = { exports: {}, forwardRef: () => null, FACE_MESH_CONNECTIONS: [] };
  const { helpers } = evaluate((await moduleBody("../app/components/TrackingLandmarkOverlay.tsx")) +
    "\nexports.helpers = { projectionFor, projectLandmark, drawFrame };", context);
  for (const aspect of [16 / 9, 4 / 3, 9 / 16]) {
    const p = helpers.projectionFor({ width: 320, height: 240 }, aspect, "contain");
    for (const x of [0, 1]) for (const y of [0, 1]) {
      const point = helpers.projectLandmark({ x, y }, p, true);
      assert.ok(point.x >= 0 && point.x <= 320 && point.y >= 0 && point.y <= 240);
    }
  }
  const points = [];
  const strokes = [];
  const ctx = { setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    stroke() { strokes.push(this.strokeStyle); }, fill() {}, arc(x, y) { points.push({ x, y }); } };
  const canvas = { width: 320, height: 240, getContext: () => ctx };
  const hand = Array.from({ length: 21 }, (_, i) => ({ x: i / 20, y: 0.5 }));
  helpers.drawFrame(canvas, { width: 320, height: 240, dpr: 1 }, {
    mirror: true, sourceAspectRatio: 4 / 3, fit: "contain", leftHandLandmarks: hand, rightHandLandmarks: hand,
  });
  assert.equal(points.length, 42);
  assert.equal(points[0].x, 320);
  assert.equal(points[20].x, 0);
  assert.ok(strokes.includes("#00dbed"));
  assert.equal(ctx.fillStyle, "#ff2585");
});

test("static face mesh matches MediaPipe topology exactly without duplicate edges", async () => {
  const { FACE_MESH_CONNECTIONS } = evaluate(await moduleBody("../app/lib/faceMeshConnections.ts"), { exports: {} });
  const key = (a, b) => [a, b].sort((x, y) => x - y).join(",");
  const expected = new Set(FaceLandmarker.FACE_LANDMARKS_TESSELATION.map(({ start, end }) => key(start, end)));
  const actual = new Set(FACE_MESH_CONNECTIONS.map(([a, b]) => key(a, b)));
  assert.equal(FACE_MESH_CONNECTIONS.length, actual.size);
  assert.deepEqual(actual, expected);
});

test("upper-body default fits the upper box while full mode fits the complete character", async () => {
  const source = await readFile(new URL("../app/components/VrmStudio.tsx", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("function fitObject("), source.indexOf("function cleanFilename("));
  const context = { exports: {}, THREE, STAGE_CAMERA_NEAR_PLANE: 0.001, STAGE_CAMERA_FAR_PLANE: 100 };
  const { fitObject } = evaluate(body + "\nexports.fitObject = fitObject;", context);
  const model = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2, 0.3));
  const camera = new THREE.PerspectiveCamera(30, 16 / 9);
  const controls = { target: new THREE.Vector3(), update() {} };
  fitObject(model, camera, controls);
  const upperDistance = camera.position.z;
  assert.ok(controls.target.y > 0.3);
  fitObject(model, camera, controls, "full");
  assert.equal(controls.target.y, 0);
  assert.ok(camera.position.z > upperDistance);
  model.geometry.dispose();
  model.material.dispose();
});
