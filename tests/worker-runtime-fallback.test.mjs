import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const workerUrl = new URL("../app/workers/holistic.worker.ts", import.meta.url);
const runtimeGpuError =
  "UNIMPLEMENTED: CalculatorGraph::Run() failed: No support of const; WaitUntilIdle failed";

test("keeps the unused face-blendshape WebGL subgraph disabled", async () => {
  const workerSource = await readFile(workerUrl, "utf8");

  assert.match(workerSource, /outputFaceBlendshapes\s*:\s*false/);
  assert.doesNotMatch(workerSource, /outputFaceBlendshapes\s*:\s*true/);
});

async function loadWorkerHarness({ gpuCloseThrows = false } = {}) {
  const workerSource = await readFile(workerUrl, "utf8");
  const harnessSource = workerSource
    .replace(
      /import\s*\{[\s\S]*?\}\s*from\s*["']@mediapipe\/tasks-vision["'];?/,
      "const { HolisticLandmarker } = __deps;",
    )
    .replace(
      /import\s+wasmBinaryPath\s+from\s+["'][^"']*vision_wasm_module_internal\.wasm\?url["'];?/,
      'const wasmBinaryPath = "mock://vision.wasm";',
    )
    .replace(
      /import\s+wasmLoaderPath\s+from\s+["'][^"']*vision_wasm_module_internal\.js\?url["'];?/,
      'const wasmLoaderPath = "mock://vision.js";',
    )
    .replace(
      /import\(\s*\/\*\s*@vite-ignore\s*\*\/\s*wasmLoaderPath\s*\)/g,
      "__deps.importWasmLoader(wasmLoaderPath)",
    )
    .replace(/export\s*\{\s*\};?/g, "");

  assert.doesNotMatch(harnessSource, /^import\s/m, "all static imports must be mocked");
  assert.doesNotMatch(harnessSource, /\bimport\s*\(/, "the WASM loader import must be mocked");

  const javascript = ts.transpileModule(harnessSource, {
    compilerOptions: {
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "holistic.worker.ts",
  }).outputText;

  const messages = [];
  const createDelegates = [];
  const gpuDetectCalls = [];
  const cpuDetectCalls = [];
  let gpuCloseCalls = 0;
  let moduleFactoryLoads = 0;
  let bitmapCloseCalls = 0;

  const gpuLandmarker = {
    detectForVideo(bitmap, timestamp) {
      gpuDetectCalls.push({ bitmap, timestamp });
      throw new Error(runtimeGpuError);
    },
    close() {
      gpuCloseCalls += 1;
      if (gpuCloseThrows) throw new Error("GPU close failed");
    },
  };
  const cpuResult = { poseLandmarks: [[{ x: 0.5, y: 0.5, z: 0 }]] };
  const cpuLandmarker = {
    detectForVideo(bitmap, timestamp) {
      cpuDetectCalls.push({ bitmap, timestamp });
      return cpuResult;
    },
    close() {},
  };

  const HolisticLandmarker = {
    async createFromOptions(_fileset, options) {
      const requestedDelegate = options.baseOptions.delegate;
      createDelegates.push(requestedDelegate);
      return requestedDelegate === "GPU" ? gpuLandmarker : cpuLandmarker;
    },
  };

  const self = {
    Module: undefined,
    ModuleFactory: undefined,
    onmessage: undefined,
    postMessage(message) {
      // Worker messages originate in a separate VM realm. Clone them here so
      // strict structural assertions do not fail only because of prototypes.
      messages.push(structuredClone(message));
    },
    close() {},
  };
  const bitmap = {
    width: 480,
    height: 270,
    close() {
      bitmapCloseCalls += 1;
    },
  };
  let now = 0;
  const context = vm.createContext({
    __deps: {
      HolisticLandmarker,
      async importWasmLoader() {
        moduleFactoryLoads += 1;
        return { default: async () => ({}) };
      },
    },
    self,
    OffscreenCanvas: class OffscreenCanvas {
      constructor(width, height) {
        this.width = width;
        this.height = height;
      }
    },
    performance: {
      now() {
        now += 1;
        return now;
      },
    },
    console,
  });

  new vm.Script(javascript, { filename: "holistic.worker.js" }).runInContext(context);
  assert.equal(typeof self.onmessage, "function", "worker must install its message handler");

  return {
    bitmap,
    cpuDetectCalls,
    cpuResult,
    createDelegates,
    get bitmapCloseCalls() {
      return bitmapCloseCalls;
    },
    get gpuCloseCalls() {
      return gpuCloseCalls;
    },
    gpuDetectCalls,
    messages,
    get moduleFactoryLoads() {
      return moduleFactoryLoads;
    },
    self,
  };
}

for (const gpuCloseThrows of [false, true]) {
  test(
    `falls back from a runtime GPU graph failure to CPU${
      gpuCloseThrows ? " even when GPU close throws" : ""
    }`,
    async () => {
      const harness = await loadWorkerHarness({ gpuCloseThrows });

      await harness.self.onmessage({ data: { type: "INIT" } });
      assert.deepEqual(harness.messages, [{ type: "READY", delegate: "GPU" }]);
      harness.messages.length = 0;

      await harness.self.onmessage({
        data: { type: "FRAME", bitmap: harness.bitmap, timestamp: 42 },
      });

      assert.deepEqual(harness.createDelegates, ["GPU", "CPU"]);
      assert.equal(harness.moduleFactoryLoads, 2, "CPU initialization must restore the WASM factory");
      assert.equal(harness.gpuDetectCalls.length, 1);
      assert.equal(harness.gpuCloseCalls, 1);
      assert.equal(harness.cpuDetectCalls.length, 1, "the same frame must be retried on CPU");
      assert.equal(harness.cpuDetectCalls[0].bitmap, harness.bitmap);
      assert.equal(harness.cpuDetectCalls[0].timestamp, 42);
      assert.equal(harness.bitmapCloseCalls, 1, "the transferred frame must close exactly once");
      assert.deepEqual(
        harness.messages.map(({ type }) => type),
        ["DELEGATE", "RESULT"],
        "runtime fallback must switch the UI delegate without emitting a second READY",
      );
      assert.equal(harness.messages[0].type, "DELEGATE");
      assert.equal(harness.messages[0].delegate, "CPU");
      assert.deepEqual(harness.messages[1].result, harness.cpuResult);
      assert.deepEqual(harness.messages[1].imageSize, {
        width: 480,
        height: 270,
      });
      assert.equal(
        harness.messages.some(({ type }) => type === "ERROR"),
        false,
        "a recoverable GPU graph failure must not stop tracking",
      );
    },
  );
}
