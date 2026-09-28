import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../app/components/PaperDollStage.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("PaperDollStage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const body = parsed.statements.filter((node) => !ts.isImportDeclaration(node)).map((node) => node.getText(parsed)).join("\n");
const performanceSource = await readFile(new URL("../app/lib/trackingPerformance.ts", import.meta.url), "utf8");
const performanceJs = ts.transpileModule(performanceSource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { trackingResponse, TrackingRenderClock, TrackingCadence } = await import(`data:text/javascript;base64,${Buffer.from(performanceJs).toString("base64")}`);
const zoomSource = await readFile(new URL("../app/lib/stageZoom.ts", import.meta.url), "utf8");
const zoomJs = ts.transpileModule(zoomSource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { stepStageZoom } = await import(`data:text/javascript;base64,${Buffer.from(zoomJs).toString("base64")}`);

function harness() {
  const refs = [];
  const frames = new Map();
  const effects = [];
  const callbacks = [];
  let frameId = 0;
  let now = 100;
  const context = { exports: {}, trackingResponse, TrackingRenderClock, TrackingCadence, stepStageZoom, React: { createElement: () => null },
    forwardRef: (component) => component,
    useRef(current) { const ref = { current }; refs.push(ref); return ref; },
    useCallback: (callback) => { callbacks.push(callback); return callback; },
    useEffect(effect) { effects.push(effect); },
    useImperativeHandle(ref, create) { ref.current = create(); },
    performance: { now: () => now },
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  vm.runInNewContext(ts.transpileModule(`${body}\nexports.helpers = { expressionFromFaceLandmarks, blendPose, blendExpression, createRestPose, NEUTRAL_EXPRESSION, faceMeshFor };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText, context);
  const handle = { current: null };
  context.exports.PaperDollStage({ artwork: "test-artwork" }, handle);
  return {
    handle: handle.current, helpers: context.exports.helpers, frames, refs, context, callbacks,
    get target() { return refs.find((ref) => ref.current?.receivedAt !== undefined)?.current; },
    get expression() { return refs.find((ref) => ref.current?.blinkLeft !== undefined)?.current; },
    set now(value) { now = value; },
    step(time) { now = time; const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(time)); },
  };
}

function face({ count = 478, closed = false } = {}) {
  const points = Array.from({ length: count }, () => ({ x: 0.5, y: 0.5 }));
  for (const [outer, inner, upper, lower, iris, x] of [[33, 133, 159, 145, 468, 0.35], [362, 263, 386, 374, 473, 0.65]]) {
    points[outer] = { x: x - 0.05, y: 0.4 };
    points[inner] = { x: x + 0.05, y: 0.4 };
    points[upper] = { x, y: closed ? 0.4 : 0.385 };
    points[lower] = { x, y: closed ? 0.4 : 0.415 };
    if (count > iris) points[iris] = { x: x + 0.02, y: 0.4 };
  }
  points[234] = { x: 0.25, y: 0.5 };
  points[454] = { x: 0.75, y: 0.5 };
  points[78] = { x: 0.44, y: 0.6 };
  points[308] = { x: 0.56, y: 0.6 };
  points[13] = { x: 0.5, y: 0.59 };
  points[14] = { x: 0.5, y: 0.62 };
  return points;
}

test("2D face ratios are consistent across webcam aspect ratios without mutating landmarks", () => {
  const { helpers } = harness();
  const square = face();
  const wide = square.map((point) => ({ ...point, y: point.y * 4 / 3 }));
  const before = structuredClone(wide);
  const a = helpers.expressionFromFaceLandmarks(square, { width: 480, height: 480 });
  const b = helpers.expressionFromFaceLandmarks(wide, { width: 640, height: 480 });
  for (const key of Object.keys(a)) assert.ok(Math.abs(a[key] - b[key]) < 1e-10, key);
  assert.deepEqual(wide, before);
});

test("2D portrait drawing ignores live rotation, expression, pan, zoom and upper-body framing", () => {
  const h = harness();
  const calls = [];
  const ctx = new Proxy({}, { get: (_, key) => (...args) => calls.push([key, ...args]), set: () => true });
  h.refs[2].current = { complete: true, naturalWidth: 640 };
  h.refs[3].current = { limbs: [], torso: {}, headBase: {}, face: {} };
  h.context.recordExpression = (expression) => calls.push(["expression", expression]);
  vm.runInNewContext("drawTorso = () => {}; drawHead = (c, b, f, r, expression) => recordExpression(expression);", h.context);
  h.refs[4].current = { ...h.helpers.createRestPose(), rotation: 0.8, x: 0.5, y: -0.4, scale: 9 };
  h.expression.blinkLeft = 1;
  h.handle.rotate(1);
  h.handle.zoom(1);
  const live = JSON.stringify(h.refs[4].current);
  const draw = h.callbacks.find((fn) => fn.toString().includes("captureSafe"));
  draw({ width: 1600, height: 2000, getContext: () => ctx }, 1600, 2000, "high", true);
  assert.deepEqual(calls.find(([key]) => key === "rotate"), ["rotate", 0]);
  assert.deepEqual(calls.find(([key]) => key === "translate"), ["translate", 800, 1000]);
  assert.equal(calls.find(([key]) => key === "expression")[1].blinkLeft, 0);
  assert.equal(JSON.stringify(h.refs[4].current), live, "live pose is untouched");
  assert.equal(h.expression.blinkLeft, 1, "live expression is untouched");
});

test("2D moves between inference results, closes short blinks, and cancels on camera stop", () => {
  const h = harness();
  h.handle.applyTracking(undefined, face({ closed: true }), { width: 640, height: 640 });
  assert.equal(h.frames.size, 1);
  assert.equal(h.expression.blinkLeft, 0, "result handler only updates targets");
  h.step(116);
  const first = h.expression.blinkLeft;
  assert.ok(first > 0.77, "a short blink must be visible on the first draw");
  h.step(133);
  assert.ok(h.expression.blinkLeft > first, "continue converging without another camera result");
  h.handle.stopTracking();
  assert.equal(h.frames.size, 0);
  assert.equal(h.target, undefined);
});

test("468-point frames keep recent gaze but update eyelids, then expire old gaze", () => {
  const h = harness();
  h.handle.applyTracking(undefined, face());
  const look = h.target.expression.lookX;
  assert.ok(look > 0.5);
  h.now = 133;
  h.handle.applyTracking(undefined, face({ count: 468, closed: true }));
  assert.equal(h.target.expression.lookX, look);
  assert.equal(h.target.expression.blinkLeft, 1);
  h.now = 350;
  h.handle.applyTracking(undefined, face({ count: 468 }));
  assert.equal(h.target.expression.lookX, 0, "stale gaze is not retained indefinitely");
  h.step(550);
  assert.equal(h.frames.size, 0, "a stalled camera stops the render loop");
});

test("reset and preset playback discard the old tracking target", () => {
  const h = harness();
  h.handle.applyTracking(undefined, face());
  h.handle.resetPose();
  assert.equal(h.frames.size, 0);
  h.handle.applyTracking(undefined, face());
  h.handle.playPreset("idle");
  assert.equal(h.frames.size, 0);
});

test("facial topology is cached, warps shared vertices once, and omits only empty cells", () => {
  const { helpers } = harness();
  let reads = 0;
  const pixels = new Uint8ClampedArray(128 * 140 * 4).fill(255);
  const sprite = { x: 236, y: 60, canvas: { width: 128, height: 140, getContext: () => ({ getImageData() { reads++; return { data: pixels }; } }) } };
  const full = helpers.faceMeshFor(sprite);
  assert.equal(full.triangles.length, 18 * 16 * 2, "keep all original detailed face cells");
  assert.equal(full.vertices.length, 19 * 17);
  assert.equal(helpers.faceMeshFor(sprite), full);
  assert.equal(reads, 1, "no pixel readback during subsequent animation frames");
  const emptyPixels = new Uint8ClampedArray(pixels.length);
  const empty = helpers.faceMeshFor({ ...sprite, canvas: { ...sprite.canvas, getContext: () => ({ getImageData: () => ({ data: emptyPixels }) }) } });
  assert.equal(empty.triangles.length, 0);
  assert.equal(empty.vertices.length, 0);
});
