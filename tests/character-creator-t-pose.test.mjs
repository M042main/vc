import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const creatorUrl = new URL(
  "../app/components/CharacterCreator.tsx",
  import.meta.url,
);
const stageUrl = new URL(
  "../app/components/PaperDollStage.tsx",
  import.meta.url,
);

function blockFrom(source, marker, length = 3_500) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing source marker: ${marker}`);
  return source.slice(start, start + length);
}

function pointFrom(source, name) {
  const match = source.match(
    new RegExp(`${name}:\\s*\\{\\s*x:\\s*(\\d+),\\s*y:\\s*(\\d+)\\s*\\}`),
  );
  assert.ok(match, `missing joint: ${name}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

function armMaskFrom(source, bone) {
  const part = source.match(
    new RegExp(
      `bone: "${bone}"[\\s\\S]*?mask:\\s*\\[([\\s\\S]*?)\\n\\s*\\],`,
    ),
  );
  assert.ok(part, `missing owner mask: ${bone}`);
  return [...part[1].matchAll(/\{\s*x:\s*(\d+),\s*y:\s*(\d+)\s*\}/g)].map(
    ([, x, y]) => ({ x: Number(x), y: Number(y) }),
  );
}

function assertHorizontalTPose(source, marker) {
  const joints = blockFrom(source, marker, 1_500);
  const leftShoulder = pointFrom(joints, "leftShoulder");
  const leftElbow = pointFrom(joints, "leftElbow");
  const leftWrist = pointFrom(joints, "leftWrist");
  const rightShoulder = pointFrom(joints, "rightShoulder");
  const rightElbow = pointFrom(joints, "rightElbow");
  const rightWrist = pointFrom(joints, "rightWrist");

  assert.equal(leftShoulder.y, leftElbow.y);
  assert.equal(leftElbow.y, leftWrist.y);
  assert.equal(rightShoulder.y, rightElbow.y);
  assert.equal(rightElbow.y, rightWrist.y);
  assert.ok(leftShoulder.x > leftElbow.x && leftElbow.x > leftWrist.x);
  assert.ok(rightShoulder.x < rightElbow.x && rightElbow.x < rightWrist.x);
  assert.ok(leftWrist.x >= 20 && rightWrist.x <= 580, "wrists need canvas margin");
}

test("uses one clear horizontal T-pose in the authoring guide and live rig", async () => {
  const [creator, stage] = await Promise.all([
    readFile(creatorUrl, "utf8"),
    readFile(stageUrl, "utf8"),
  ]);

  assertHorizontalTPose(creator, "const joints = {");
  assertHorizontalTPose(stage, "const REST_JOINTS");

  const creatorJoints = blockFrom(creator, "const joints = {", 1_500);
  const stageJoints = blockFrom(stage, "const REST_JOINTS", 1_500);
  for (const joint of [
    "leftShoulder",
    "leftElbow",
    "leftWrist",
    "rightShoulder",
    "rightElbow",
    "rightWrist",
  ]) {
    assert.deepEqual(pointFrom(creatorJoints, joint), pointFrom(stageJoints, joint));
  }

  const silhouette = blockFrom(creator, "function createSilhouettePath", 2_700);
  assert.match(silhouette, /lineTo\(552, 214\)/);
  assert.match(silhouette, /bezierCurveTo\(22, 223, 32, 214, 48, 214\)/);
  assert.match(creator, /T-포즈 · \{side === "front"/);
  assert.match(creator, /T-포즈 관절·표정 가이드는 저장되지 않아요/);
  assert.match(creator, /팔을 수평으로 펼친 T-포즈 실루엣 위에 그리세요/);
});

test("keeps T-pose arm artwork wide, joint-aware, and driven by rest joints", async () => {
  const source = await readFile(stageUrl, "utf8");

  for (const bone of [
    "leftUpperArm",
    "leftLowerArm",
    "rightUpperArm",
    "rightLowerArm",
  ]) {
    const mask = armMaskFrom(source, bone);
    assert.equal(mask.length, 4, `${bone} should retain a four-point owner mask`);
    const xs = mask.map(({ x }) => x);
    const ys = mask.map(({ y }) => y);
    assert.ok(Math.max(...xs) - Math.min(...xs) > Math.max(...ys) - Math.min(...ys));
  }

  const restAngles = blockFrom(source, "const REST_BONE_ANGLES", 500);
  assert.match(restAngles, /angleBetween\(REST_JOINTS\[part\.start\], REST_JOINTS\[part\.end\]\)/);
  const targets = blockFrom(source, "function targetJointsForPose", 2_600);
  assert.match(
    targets,
    /distance\(REST_JOINTS\.leftShoulder, REST_JOINTS\.leftElbow\)/,
  );
  assert.match(
    targets,
    /distance\(REST_JOINTS\.rightElbow, REST_JOINTS\.rightWrist\)/,
  );
  assert.match(source, /ARTWORK_OWNER_POLYGONS[\s\S]{0,450}getRigPart\("leftUpperArm"\)/);
  assert.match(source, /createMeshVertex[\s\S]{0,650}distanceToSegment/);
});
