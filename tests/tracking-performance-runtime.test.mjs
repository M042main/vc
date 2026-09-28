import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../app/lib/trackingPerformance.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { TrackingInputBudget, fitTrackingInput, trackingResponse, TrackingRenderClock, TrackingCadence } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

test("60fps rendering retains fractional time on 60/75/90/120/144Hz displays", () => {
  for (const refresh of [60, 75, 90, 120, 144]) {
    const clock = new TrackingRenderClock();
    let draws = 0;
    let elapsed = 0;
    for (let i = 0; i < refresh * 10; i++) {
      const delta = clock.step(i * 1000 / refresh);
      if (delta !== null) { draws++; elapsed += delta; }
    }
    assert.ok(draws >= 599 && draws <= 601, `${refresh}Hz: ${draws} draws`);
    assert.ok(Math.abs(elapsed - 10) < 0.04);
  }
});

test("cadence smoothing distributes slower inference without queueing or changing blink response", () => {
  const cadence = new TrackingCadence();
  const normal = cadence.response();
  for (let i = 1; i < 100; i++) cadence.observe(i * 70);
  assert.ok(cadence.response() < normal);
  assert.ok(cadence.response() > 0.35, "never introduce long smoothing lag");
  const beforeStall = cadence.intervalMs;
  cadence.observe(20000);
  assert.equal(cadence.intervalMs, beforeStall);
  cadence.reset();
  assert.equal(cadence.response(), normal);
});

test("input size preserves 4:3, widescreen and portrait geometry without upscaling", () => {
  assert.deepEqual(fitTrackingInput(1280, 720, 640, 480), { width: 640, height: 360 });
  assert.deepEqual(fitTrackingInput(640, 480, 640, 480), { width: 640, height: 480 });
  assert.deepEqual(fitTrackingInput(720, 1280, 640, 480), { width: 270, height: 480 });
  assert.deepEqual(fitTrackingInput(320, 240, 640, 480), { width: 320, height: 240 });
  assert.deepEqual(fitTrackingInput(640, 480, 480, 360), { width: 480, height: 360 });
  assert.deepEqual(fitTrackingInput(NaN, 0, 640, 480), { width: 640, height: 480 });
});

test("adaptive input ignores startup stalls, reduces sustained overload and recovers without oscillating", () => {
  const budget = new TrackingInputBudget();
  for (const sample of [NaN, Infinity, -1, 0, 5000]) budget.observe(sample);
  assert.equal(budget.reduced, false);
  for (let i = 0; i < 7; i++) budget.observe(65);
  assert.equal(budget.reduced, false);
  budget.observe(65);
  assert.equal(budget.reduced, true);
  for (let i = 0; i < 89; i++) budget.observe(18);
  assert.equal(budget.reduced, true);
  budget.observe(18);
  assert.equal(budget.reduced, false);
  for (let i = 0; i < 100; i++) budget.observe(i % 2 ? 25 : 55);
  assert.equal(budget.reduced, false);
  budget.reset();
  assert.equal(budget.reduced, false);
});

async function frameLoopHarness({ videoCallback = true, deferred = false, sendThrows = false, onSend } = {}) {
  const studio = await readFile(new URL("../app/components/VrmStudio.tsx", import.meta.url), "utf8");
  const body = studio.match(/const runTrackingFrames = useCallback\(\(\) => \{([\s\S]*?)\n {2}\}, \[\]\);/u)?.[1];
  assert.ok(body, "exercise the actual component frame loop");
  const callbacks = [];
  const sent = [];
  const video = { currentTime: 1, videoWidth: 640, videoHeight: 480, readyState: 2 };
  let now = 100;
  const enqueue = (callback) => { callbacks.push(async (time) => {
    now = time;
    callback(time, { mediaTime: video.currentTime });
    await new Promise((resolve) => setImmediate(resolve));
  }); return callbacks.length; };
  if (videoCallback) video.requestVideoFrameCallback = enqueue;
  let creates = 0;
  let closes = 0;
  let resolveBitmap;
  let rejectBitmap;
  const bitmap = { close() { closes++; } };
  const ref = (current) => ({ current });
  const context = {
    videoRef: ref(video),
    workerRef: ref({ postMessage(message, transfer) {
      if (sendThrows) throw new Error("worker stopped");
      sent.push({ message, transfer });
      onSend?.(now, message);
    } }),
    trackingSessionRef: ref(1), trackingRunningRef: ref(true),
    pumpTrackingFrameRef: ref(() => {}),
    trackingVideoCallbackRef: ref(null), trackingRafRef: ref(null),
    stageVisibleRef: ref(true), pipActiveRef: ref(false), frameInFlightRef: ref(false),
    lastVideoTimeRef: ref(-1), lastFrameRef: ref(-Infinity),
    trackingInputBudgetRef: ref(new TrackingInputBudget()),
    HTMLMediaElement: { HAVE_CURRENT_DATA: 2 }, TRACKING_FRAME_INTERVAL_MS: 1000 / 30,
    trackingInputDimensions: () => ({ width: 640, height: 480 }),
    requestAnimationFrame: enqueue,
    performance: { now: () => now },
    createImageBitmap() {
      creates++;
      return deferred ? new Promise((resolve, reject) => { resolveBitmap = resolve; rejectBitmap = reject; }) : Promise.resolve(bitmap);
    },
  };
  vm.runInNewContext(ts.transpileModule(`(function () {${body}\n})()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, context);
  return { context, video, callbacks, sent, bitmap, get creates() { return creates; }, get closes() { return closes; },
    set now(value) { now = value; },
    resolve: () => resolveBitmap(bitmap), reject: () => rejectBitmap(new Error("capture cancelled")) };
}

for (const videoCallback of [true, false]) {
  test(`frame loop drops duplicate/busy frames and transfers ownership (${videoCallback ? "video callback" : "RAF fallback"})`, async () => {
    const harness = await frameLoopHarness({ videoCallback });
    await harness.callbacks.shift()(100);
    assert.equal(harness.creates, 1);
    assert.equal(harness.sent[0].transfer[0], harness.bitmap);
    harness.video.currentTime = 2;
    await harness.callbacks.shift()(140);
    assert.equal(harness.creates, 1, "one inference in flight, never a backlog");
    harness.context.frameInFlightRef.current = false;
    await harness.callbacks.shift()(180);
    assert.equal(harness.creates, 2);
    harness.context.frameInFlightRef.current = false;
    await harness.callbacks.shift()(220);
    assert.equal(harness.creates, 2, "same webcam frame must not be inferred twice");
    harness.context.trackingSessionRef.current++;
    await harness.callbacks.shift()(260);
    assert.equal(harness.callbacks.length, 0, "a stopped session must not create a new loop");
  });
}

test("an old bitmap completion cannot send a frame to a restarted worker", async () => {
  const harness = await frameLoopHarness({ deferred: true });
  const pending = harness.callbacks.shift()(100);
  harness.context.workerRef.current = { postMessage() { assert.fail("stale frame"); } };
  harness.context.trackingSessionRef.current++;
  harness.resolve();
  await pending;
  assert.equal(harness.closes, 1);
  assert.equal(harness.sent.length, 0);
  assert.equal(harness.context.frameInFlightRef.current, true, "old work must not release the new session's backpressure");
});

for (const [latency, minFps] of [[34, 28], [45, 21], [70, 14]]) {
  test(`completion-driven pump avoids camera-frame quantization at ${latency} ms`, async (t) => {
    let completionAt = Infinity;
    const harness = await frameLoopHarness({ onSend(now) { completionAt = now + latency; } });
    let cameraFrame = 0;
    while (Math.min(cameraFrame * 1000 / 30, completionAt) < 10000) {
      const cameraAt = cameraFrame * 1000 / 30;
      if (cameraAt <= completionAt) {
        harness.video.currentTime = cameraFrame++ / 30;
        await harness.callbacks.shift()(cameraAt);
      } else {
        harness.now = completionAt;
        completionAt = Infinity;
        harness.context.frameInFlightRef.current = false;
        harness.context.pumpTrackingFrameRef.current();
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    assert.ok(harness.sent.length / 10 >= minFps, `${harness.sent.length / 10} fps must exceed the old quantized rate`);
    assert.ok(harness.sent.length <= 300, "never invent additional camera frames");
    t.diagnostic(`Synthetic 30 fps camera, ${latency} ms processing: ${(harness.sent.length / 10).toFixed(1)} results/s`);
    assert.equal(new Set(harness.sent.map(({ message }) => message.timestamp)).size, harness.sent.length);
  });
}

test("display response is equivalent at 30/60/120 Hz and keeps fast blinks", () => {
  for (const fps of [30, 60, 120]) {
    let position = 0;
    for (let frame = 0; frame < fps / 10; frame++) position += (1 - position) * trackingResponse(0.7, 1 / fps);
    assert.ok(Math.abs(position - 0.973) < 1e-9);
  }
  assert.ok(trackingResponse(0.95, 1 / 60) > 0.77);
  assert.equal(trackingResponse(0.7, 0), 0);
});

test("a failed frame transfer closes its bitmap and releases backpressure", async () => {
  const harness = await frameLoopHarness({ sendThrows: true });
  await harness.callbacks.shift()(100);
  assert.equal(harness.closes, 1);
  assert.equal(harness.context.frameInFlightRef.current, false);
});
