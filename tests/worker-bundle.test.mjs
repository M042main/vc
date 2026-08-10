import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const clientRoot = path.join(projectRoot, "dist", "client");

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listFiles(absolutePath);
      return entry.isFile() ? [absolutePath] : [];
    }),
  );

  return nested.flat();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("bundles the holistic tracker as a deploy-safe Vite worker asset", async () => {
  const [wrapperSource, workerSource, studioSource, viteConfig, clientAssets] = await Promise.all([
    readFile(path.join(projectRoot, "app", "lib", "holisticWorker.ts"), "utf8"),
    readFile(path.join(projectRoot, "app", "workers", "holistic.worker.ts"), "utf8"),
    readFile(path.join(projectRoot, "app", "components", "VrmStudio.tsx"), "utf8"),
    readFile(path.join(projectRoot, "vite.config.ts"), "utf8"),
    listFiles(clientRoot),
  ]);

  const clientFiles = clientAssets.filter((file) => file.endsWith(".js"));

  assert.match(
    wrapperSource,
    /holistic\.worker\.ts\?worker/,
    "the wrapper must keep Vite's ?worker constructor import",
  );
  assert.match(studioSource, /createHolisticTrackingWorker\s*\(/);
  assert.match(viteConfig, /worker\s*:\s*\{\s*format\s*:\s*["']es["']/);
  assert.match(workerSource, /vision_wasm_module_internal\.js\?url/);
  assert.match(workerSource, /vision_wasm_module_internal\.wasm\?url/);
  assert.doesNotMatch(workerSource, /cdn\.jsdelivr\.net/);
  assert.doesNotMatch(
    studioSource,
    /new\s+Worker\s*\(\s*new\s+URL\s*\(\s*["'][^"']*holistic\.worker/,
    "VrmStudio must not recreate the import.meta.url worker path that broke deployment",
  );

  const clientSources = await Promise.all(
    clientFiles.map(async (file) => ({ file, source: await readFile(file, "utf8") })),
  );
  const completeClientBundle = clientSources.map(({ source }) => source).join("\n");

  assert.doesNotMatch(
    completeClientBundle,
    /file:\/{2,3}ROOT(?:\/|\\)/i,
    "the deployed client bundle must never resolve a Worker against file:///ROOT",
  );

  const workerAssets = clientSources.filter(({ file }) =>
    /^holistic\.worker-[\w-]+\.js$/i.test(path.basename(file)),
  );
  assert.ok(workerAssets.length > 0, "the build must emit a hashed holistic worker asset");

  const moduleLoaderAssets = clientAssets.filter((file) =>
    /^vision_wasm_module_internal-[\w-]+\.js$/i.test(path.basename(file)),
  );
  const moduleWasmAssets = clientAssets.filter((file) =>
    /^vision_wasm_module_internal-[\w-]+\.wasm$/i.test(path.basename(file)),
  );
  assert.equal(moduleLoaderAssets.length, 1, "the module WASM loader must be self-hosted");
  assert.equal(moduleWasmAssets.length, 1, "the module WASM binary must be self-hosted");
  assert.ok((await stat(moduleLoaderAssets[0])).size > 300_000);
  assert.ok((await stat(moduleWasmAssets[0])).size > 10_000_000);

  for (const { file, source } of workerAssets) {
    const fileInfo = await stat(file);
    assert.ok(fileInfo.size > 1_000, `${path.basename(file)} should contain the tracker worker`);
    assert.match(source, /HolisticLandmarker|holistic_landmarker\.task/);
    assert.match(source, new RegExp(escapeRegExp(path.basename(moduleLoaderAssets[0]))));
    assert.match(source, new RegExp(escapeRegExp(path.basename(moduleWasmAssets[0]))));
    assert.doesNotMatch(source, /cdn\.jsdelivr\.net/);

    const assetName = path.basename(file);
    const referencingChunk = clientSources.find(
      (candidate) => candidate.file !== file && candidate.source.includes(assetName),
    );
    assert.ok(referencingChunk, `${assetName} must be referenced by a client chunk`);
    assert.match(
      referencingChunk.source,
      new RegExp(
        `new\\s+Worker[\\s\\S]{0,600}${escapeRegExp(assetName)}[\\s\\S]{0,180}type\\s*:\\s*[\u0060"']module[\u0060"']`,
      ),
      `${assetName} must be constructed as an ES module Worker`,
    );
  }
});
