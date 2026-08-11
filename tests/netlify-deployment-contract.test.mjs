import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const netlifyServerRoot = path.join(
  projectRoot,
  ".netlify",
  "functions-internal",
  "server",
);
const netlifyFunctionEntry = path.join(netlifyServerRoot, "server.mjs");
const netlifyFunctionMain = path.join(netlifyServerRoot, "main.mjs");
const netlifyPublicRoot = path.join(projectRoot, "dist");
const netlifyRedirects = path.join(netlifyPublicRoot, "_redirects");
const hasNetlifyOutput =
  existsSync(netlifyFunctionEntry) &&
  existsSync(netlifyFunctionMain) &&
  existsSync(netlifyRedirects);

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

async function readProjectFile(relativePath) {
  return readFile(path.join(projectRoot, relativePath), "utf8");
}

test("keeps Netlify on Nitro without replacing the existing Sites build", async () => {
  const [packageSource, netlifyConfig, viteConfig, gitignore, readme] =
    await Promise.all([
      readProjectFile("package.json"),
      readProjectFile("netlify.toml"),
      readProjectFile("vite.config.ts"),
      readProjectFile(".gitignore"),
      readProjectFile("README.md"),
    ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(packageJson.scripts.build, "vinext build");
  assert.equal(packageJson.scripts["build:netlify"], "vite build --mode netlify");
  assert.equal(
    packageJson.scripts["test:netlify"],
    "npm run build:netlify && node --test tests/netlify-deployment-contract.test.mjs",
  );
  assert.match(packageJson.dependencies.nitro, /^\^3\./u);

  assert.match(netlifyConfig, /\[build\][\s\S]*command\s*=\s*["']npm run build:netlify["']/u);
  assert.match(netlifyConfig, /\[build\][\s\S]*publish\s*=\s*["']dist["']/u);
  assert.match(netlifyConfig, /NODE_VERSION\s*=\s*["']22(?:\.\d+){0,2}["']/u);
  assert.match(netlifyConfig, /NITRO_PRESET\s*=\s*["']netlify["']/u);
  assert.doesNotMatch(netlifyConfig, /GEMINI_API_KEY\s*=/u);
  assert.doesNotMatch(netlifyConfig, /AIzaSy[0-9A-Za-z_-]+/u);
  assert.doesNotMatch(
    netlifyConfig,
    /from\s*=\s*["']\/\*["'][\s\S]{0,240}to\s*=\s*["']\/index\.html["']/u,
    "an SPA fallback would hide Nitro SSR and API routes",
  );

  assert.match(viteConfig, /mode\s*===\s*["']netlify["']/u);
  assert.match(viteConfig, /await import\(["']nitro\/vite["']\)/u);
  assert.match(
    viteConfig,
    /if\s*\(isNetlifyBuild\)[\s\S]{0,700}plugins\s*:\s*\[vinext\(\),\s*nitro\(\{\s*preset\s*:\s*["']netlify["']\s*\}\)\]/u,
  );
  assert.match(viteConfig, /plugins\s*:\s*\[[\s\S]*sites\(\)[\s\S]*cloudflare\(/u);
  assert.match(viteConfig, /worker\s*:\s*\{\s*format\s*:\s*["']es["']/u);

  assert.match(gitignore, /^\/dist\/$/mu);
  assert.match(gitignore, /^\/\.netlify\/$/mu);
  assert.match(readme, /GEMINI_API_KEY[\s\S]{0,220}(secret|비밀|Do not|넣지)/iu);
  assert.match(readme, /oai-authenticated-user-email/u);
});

test("preserves all browser API paths for the Netlify server function", async () => {
  const [aiClient, galleryClient] = await Promise.all([
    readProjectFile("app/components/AiImageGenerator.tsx"),
    readProjectFile("app/lib/firebaseGallery.ts"),
  ]);
  const routes = [
    ["app/api/ai/generate/route.ts", "/api/ai/generate"],
    ["app/api/gallery/classes/route.ts", "/api/gallery/classes"],
    ["app/api/gallery/delete/route.ts", "/api/gallery/delete"],
  ];

  for (const [routeFile] of routes) {
    await access(path.join(projectRoot, routeFile));
  }
  assert.match(aiClient, /fetch\(["']\/api\/ai\/generate["']/u);
  assert.match(galleryClient, /GALLERY_CLASSES_API_PATH\s*=\s*["']\/api\/gallery\/classes["']/u);
  assert.match(galleryClient, /GALLERY_DELETE_API_PATH\s*=\s*["']\/api\/gallery\/delete["']/u);

  assert.equal(
    existsSync(path.join(projectRoot, "netlify", "functions")),
    false,
    "Nitro owns the generated function; hand-written duplicate API functions drift",
  );
});

test(
  "emits Netlify routing, server function, and self-hosted tracking assets",
  { skip: !hasNetlifyOutput && "run npm run test:netlify to validate generated output" },
  async () => {
    const [wrapperSource, publicFiles, serverFiles] = await Promise.all([
      readFile(netlifyFunctionEntry, "utf8"),
      listFiles(netlifyPublicRoot),
      listFiles(netlifyServerRoot),
    ]);

    assert.match(wrapperSource, /export\s*\{\s*default\s*\}\s*from\s*["']\.\/main\.mjs["']/u);
    assert.match(wrapperSource, /path\s*:\s*["']\/\*["']/u);
    assert.match(wrapperSource, /nodeBundler\s*:\s*["']none["']/u);
    assert.match(wrapperSource, /preferStatic\s*:\s*true/u);
    assert.match(wrapperSource, /excludedPath\s*:[\s\S]{0,240}\/\.netlify\/\*/u);

    await access(path.join(netlifyPublicRoot, "_headers"));
    const mainInfo = await stat(netlifyFunctionMain);
    assert.ok(mainInfo.size > 2_000, "the generated server entry must contain Nitro");
    const serverStats = await Promise.all(serverFiles.map((file) => stat(file)));
    assert.ok(
      serverStats.reduce((total, fileInfo) => total + fileInfo.size, 0) > 1_000_000,
      "the generated function and its bundled chunks must contain the complete app",
    );

    const publicNames = publicFiles.map((file) => path.basename(file));
    const workerFile = publicFiles.find((file) =>
      /^holistic\.worker-[\w-]+\.js$/iu.test(path.basename(file)),
    );
    const wasmFile = publicFiles.find((file) =>
      /^vision_wasm_module_internal-[\w-]+\.wasm$/iu.test(path.basename(file)),
    );
    const wasmLoaderFile = publicFiles.find((file) =>
      /^vision_wasm_module_internal-[\w-]+\.js$/iu.test(path.basename(file)),
    );
    assert.ok(workerFile, "the MediaPipe module worker must be published by Netlify");
    assert.ok(wasmFile, "the MediaPipe WASM binary must be published by Netlify");
    assert.ok(wasmLoaderFile, "the MediaPipe WASM loader must be published by Netlify");
    assert.ok((await stat(wasmFile)).size > 10_000_000);
    assert.ok((await stat(wasmLoaderFile)).size > 300_000);
    assert.ok(publicNames.includes("favicon.svg"));

    const serverJavaScript = serverFiles.filter((file) => /\.(?:mjs|js)$/u.test(file));
    const compiledServer = (
      await Promise.all(serverJavaScript.map((file) => readFile(file, "utf8")))
    ).join("\n");
    for (const route of [
      "/api/ai/generate",
      "/api/gallery/classes",
      "/api/gallery/delete",
    ]) {
      assert.match(
        compiledServer,
        new RegExp(route.replaceAll("/", "\\/"), "u"),
        `${route} must be bundled into the Netlify server function`,
      );
    }
  },
);

test(
  "serves SSR and dispatches every API route through the generated function",
  { skip: !hasNetlifyOutput && "run npm run test:netlify to validate generated output" },
  async () => {
    const functionUrl = pathToFileURL(netlifyFunctionEntry);
    functionUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
    const netlifyFunction = await import(functionUrl.href);

    assert.equal(netlifyFunction.config.path, "/*");
    assert.equal(netlifyFunction.config.preferStatic, true);
    assert.equal(netlifyFunction.config.nodeBundler, "none");

    const home = await netlifyFunction.default(
      new Request("https://virtual-creator.netlify.app/", {
        headers: { Accept: "text/html" },
      }),
    );
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type") ?? "", /^text\/html\b/iu);
    const html = await home.text();
    assert.match(html, /VIRTUAL CREATOR/u);
    assert.match(html, /트래킹 스튜디오/u);

    const apiCases = [
      {
        path: "/api/ai/generate",
        headers: { "Content-Type": "text/plain" },
        status: 415,
      },
      {
        path: "/api/gallery/classes",
        headers: {
          "Content-Type": "application/json",
          "oai-authenticated-user-email": "m042@m042.kr",
        },
        status: 403,
      },
      {
        path: "/api/gallery/delete",
        headers: {
          "Content-Type": "application/json",
          "oai-authenticated-user-email": "m042@m042.kr",
        },
        status: 403,
      },
    ];
    for (const apiCase of apiCases) {
      const response = await netlifyFunction.default(
        new Request(`https://virtual-creator.netlify.app${apiCase.path}`, {
          method: "POST",
          headers: apiCase.headers,
          body: "{}",
        }),
      );
      assert.equal(
        response.status,
        apiCase.status,
        `${apiCase.path} must reach its existing route handler`,
      );
      assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/iu);
    }
  },
);
