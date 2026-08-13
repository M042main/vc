import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Euler, Object3D, Quaternion, Vector3 } from "three";
import ts from "typescript";

const rigUrl = new URL("../app/lib/vrmRig.ts", import.meta.url);

async function loadRigModule() {
  const source = await readFile(rigUrl, "utf8");
  const kalidokitBundleUrl = new URL(
    "../node_modules/kalidokit/dist/kalidokit.umd.js",
    import.meta.url,
  ).href;
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
      `import Kalidokit from ${JSON.stringify(kalidokitBundleUrl)}; const { Face, Hand, Pose } = Kalidokit;`,
    );
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(runnable).toString("base64")}`;
  return import(moduleUrl);
}

const rigModule = loadRigModule();
const EPSILON = 1e-7;

function mockVrm(metaVersion, node) {
  return {
    meta: { metaVersion },
    humanoid: {
      getNormalizedBoneNode: () => node,
    },
  };
}

function assertQuaternionEquivalent(actual, expected, label) {
  // q and -q encode the same rotation, so compare their absolute dot product.
  const alignment = Math.abs(actual.dot(expected));
  assert.ok(1 - alignment < EPSILON, `${label}: quaternion alignment ${alignment}`);
}

function assertVectorClose(actual, expected, label) {
  assert.ok(
    actual.distanceTo(expected) < EPSILON,
    `${label}: ${actual.toArray()} != ${expected.toArray()}`,
  );
}

test("VRM 0.x tracking keeps the established Kalidokit quaternion unchanged", async () => {
  const { slerpVrmBoneRotation } = await rigModule;
  const node = new Object3D();
  const rotation = { x: 0.31, y: -0.42, z: 0.57, rotationOrder: "XYZ" };
  const expected = new Quaternion().setFromEuler(
    new Euler(rotation.x, rotation.y, rotation.z, rotation.rotationOrder),
  );

  assert.equal(
    slerpVrmBoneRotation(mockVrm("0", node), "leftUpperArm", rotation, {
      slerp: 1,
    }),
    true,
  );
  assertQuaternionEquivalent(node.quaternion, expected, "VRM 0.x regression");
});

test("VRM 1.x tracking conjugates neck and arm rotations into its +Z-forward basis", async () => {
  const { slerpVrmBoneRotation } = await rigModule;
  const basis = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
  const inverseBasis = basis.clone().invert();

  for (const [bone, rotation] of [
    ["neck", { x: -0.28, y: 0.36, z: 0.17 }],
    ["leftUpperArm", { x: 0.31, y: -0.42, z: 0.57 }],
    ["rightUpperArm", { x: -0.22, y: 0.19, z: -0.63 }],
  ]) {
    const node = new Object3D();
    const solved = new Quaternion().setFromEuler(
      new Euler(rotation.x, rotation.y, rotation.z, "XYZ"),
    );
    const expected = solved.clone().premultiply(basis).multiply(inverseBasis);

    slerpVrmBoneRotation(mockVrm("1", node), bone, rotation, { slerp: 1 });
    assertQuaternionEquivalent(node.quaternion, expected, `VRM 1.x ${bone}`);
  }
});

test("matching VRM 0.x and 1.x rest axes move neck and arms in the same world direction", async () => {
  const { slerpVrmBoneRotation } = await rigModule;
  const basis = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);

  for (const [label, vrm0RestDirection, rotation] of [
    ["neck forward", new Vector3(0, 0, -1), { x: 0.34, y: -0.27, z: 0.19 }],
    ["left arm", new Vector3(-1, 0, 0), { x: -0.18, y: 0.29, z: 0.61 }],
    ["right arm", new Vector3(1, 0, 0), { x: 0.24, y: -0.33, z: -0.54 }],
  ]) {
    const vrm0Bone = new Object3D();
    const vrm1Bone = new Object3D();
    slerpVrmBoneRotation(mockVrm("0", vrm0Bone), label, rotation, { slerp: 1 });
    slerpVrmBoneRotation(mockVrm("1", vrm1Bone), label, rotation, { slerp: 1 });

    const vrm1RestDirection = vrm0RestDirection.clone().applyQuaternion(basis);
    const vrm0WorldDirection = vrm0RestDirection
      .clone()
      .applyQuaternion(vrm0Bone.quaternion)
      .applyQuaternion(basis);
    const vrm1WorldDirection = vrm1RestDirection
      .clone()
      .applyQuaternion(vrm1Bone.quaternion);

    assertVectorClose(vrm1WorldDirection, vrm0WorldDirection, label);
  }
});

test("VRM 1.x hips translation reaches the same world vector as rotated VRM 0.x", async () => {
  const { transformVrmTrackingVector } = await rigModule;
  const basis = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
  const solvedVrm0Offset = new Vector3(-0.26, 0.18, -0.41);

  const vrm0Local = transformVrmTrackingVector(
    mockVrm("0", new Object3D()),
    solvedVrm0Offset.clone(),
  );
  const vrm1Local = transformVrmTrackingVector(
    mockVrm("1", new Object3D()),
    solvedVrm0Offset.clone(),
  );
  const vrm0World = vrm0Local.clone().applyQuaternion(basis);

  assertVectorClose(vrm0Local, solvedVrm0Offset, "VRM 0.x hips regression");
  assertVectorClose(vrm1Local, vrm0World, "VRM 1.x hips basis");
});
