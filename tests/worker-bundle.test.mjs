import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const clientRoot = path.join(projectRoot, "dist", "client");

async function listJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listJavaScriptFiles(absolutePath);
      return entry.isFile() && entry.name.endsWith(".js") ? [absolutePath] : [];
    }),
  );

  return nested.flat();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("bundles the holistic tracker as a deploy-safe Vite worker asset", async () => {
  const [wrapperSource, studioSource, clientFiles] = await Promise.all([
    readFile(path.join(projectRoot, "app", "lib", "holisticWorker.ts"), "utf8"),
    readFile(path.join(projectRoot, "app", "components", "VrmStudio.tsx"), "utf8"),
    listJavaScriptFiles(clientRoot),
  ]);

  assert.match(
    wrapperSource,
    /holistic\.worker\.ts\?worker/,
    "the wrapper must keep Vite's ?worker constructor import",
  );
  assert.match(studioSource, /createHolisticTrackingWorker\s*\(/);
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

  for (const { file, source } of workerAssets) {
    const fileInfo = await stat(file);
    assert.ok(fileInfo.size > 1_000, `${path.basename(file)} should contain the tracker worker`);
    assert.match(source, /HolisticLandmarker|holistic_landmarker\.task/);

    const assetName = path.basename(file);
    const referencingChunk = clientSources.find(
      (candidate) => candidate.file !== file && candidate.source.includes(assetName),
    );
    assert.ok(referencingChunk, `${assetName} must be referenced by a client chunk`);
    assert.match(
      referencingChunk.source,
      new RegExp(`new\\s+Worker[\\s\\S]{0,600}${escapeRegExp(assetName)}`),
      `${assetName} must be constructed as a browser Worker`,
    );
  }
});
