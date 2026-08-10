import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const studioUrl = new URL("../app/components/VrmStudio.tsx", import.meta.url);
const studioCssUrl = new URL(
  "../app/components/VrmStudio.module.css",
  import.meta.url,
);
const rigUrl = new URL("../app/lib/vrmRig.ts", import.meta.url);
const paperDollUrl = new URL(
  "../app/components/PaperDollStage.tsx",
  import.meta.url,
);
const trackingOverlayUrl = new URL(
  "../app/components/TrackingLandmarkOverlay.tsx",
  import.meta.url,
);
const trackingOverlayCssUrl = new URL(
  "../app/components/TrackingLandmarkOverlay.module.css",
  import.meta.url,
);
const optionalVrmMotionUrls = [
  new URL("../app/lib/vrmMotion.ts", import.meta.url),
  new URL("../app/lib/vrmAnimation.ts", import.meta.url),
  new URL("../app/lib/vrmPresetMotion.ts", import.meta.url),
];
const optionalTrackingOverlayUrls = [
  new URL("../app/lib/trackingOverlay.ts", import.meta.url),
  new URL("../app/lib/landmarkOverlay.ts", import.meta.url),
];

async function readOptional(url) {
  try {
    return await readFile(url, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function namedLiteralCount(source, names, filename = "vrm-motion.tsx") {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let count = null;

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      names.test(node.name.text) &&
      node.initializer
    ) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isArrayLiteralExpression(initializer)) {
        count = Math.max(count ?? 0, initializer.elements.length);
      } else if (ts.isObjectLiteralExpression(initializer)) {
        count = Math.max(count ?? 0, initializer.properties.length);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return count;
}

function jsxButtonBlocks(source) {
  const sourceFile = ts.createSourceFile(
    "VrmStudio.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const buttons = [];

  function visit(node) {
    if (
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(sourceFile) === "button"
    ) {
      buttons.push(node.getText(sourceFile));
    } else if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(sourceFile) === "button"
    ) {
      buttons.push(node.getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return buttons;
}

function findButton(source, pattern, label) {
  const button = jsxButtonBlocks(source).find((candidate) => pattern.test(candidate));
  assert.ok(button, `missing ${label} button`);
  return button;
}

function cssDeclarationsForClass(cssSource, className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...cssSource.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => new RegExp(`\\.${escaped}\\b`).test(match[1]))
    .map((match) => match[2]);
}

function largestCssPixels(declarations, properties) {
  const propertyPattern = properties.join("|");
  const values = declarations.flatMap((declaration) =>
    [...declaration.matchAll(new RegExp(`(?:${propertyPattern})\\s*:\\s*(\\d+(?:\\.\\d+)?)px`, "g"))]
      .map((match) => Number(match[1])),
  );
  return values.length > 0 ? Math.max(...values) : 0;
}

function assertButtonTarget(
  button,
  cssSource,
  label,
  { square = false, fallbackClasses = [] } = {},
) {
  const classes = [
    ...[...button.matchAll(/styles\.([A-Za-z0-9_]+)/g)].map(
      (match) => match[1],
    ),
    ...fallbackClasses,
  ];
  assert.ok(classes.length > 0, `${label} must use a CSS module class for its hit target`);

  const declarations = classes.flatMap((className) =>
    cssDeclarationsForClass(cssSource, className),
  );
  const inlineHeight = /(?:minHeight|height)\s*:\s*["']?44(?:px)?["']?/.test(button)
    ? 44
    : 0;
  const inlineWidth = /(?:minWidth|width)\s*:\s*["']?44(?:px)?["']?/.test(button)
    ? 44
    : 0;
  const height = Math.max(
    inlineHeight,
    largestCssPixels(declarations, ["min-height", "height"]),
  );
  assert.ok(height >= 44, `${label} touch target must be at least 44px high; got ${height}px`);

  if (square) {
    const width = Math.max(
      inlineWidth,
      largestCssPixels(declarations, ["min-width", "width"]),
    );
    assert.ok(width >= 44, `${label} touch target must be at least 44px wide; got ${width}px`);
  }
}

function blockFromPattern(source, pattern, length, label) {
  const match = source.match(pattern);
  assert.ok(match, `missing ${label}`);
  return source.slice(match.index, match.index + length);
}

function contextAround(source, pattern, before, after, label) {
  const match = source.match(pattern);
  assert.ok(match, `missing ${label}`);
  return source.slice(
    Math.max(0, match.index - before),
    Math.min(source.length, match.index + match[0].length + after),
  );
}

function balancedBlockFromPattern(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match, `missing ${label}`);
  const openBrace = source.indexOf("{", match.index + match[0].length);
  assert.notEqual(openBrace, -1, `missing opening brace for ${label}`);
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  assert.fail(`missing closing brace for ${label}`);
}

test("offers three or more VRM bone-motion presets with play, stop, and speed controls", async () => {
  const [studioSource, cssSource, rigSource, ...optionalMotionSources] =
    await Promise.all([
      readFile(studioUrl, "utf8"),
      readFile(studioCssUrl, "utf8"),
      readFile(rigUrl, "utf8"),
      ...optionalVrmMotionUrls.map(readOptional),
    ]);
  const candidates = [studioSource, rigSource, ...optionalMotionSources];
  const count = candidates.reduce((largest, source) => {
    const candidateCount = namedLiteralCount(
      source,
      /^(?:VRM_MOTION_PRESETS|VRM_ANIMATION_PRESETS)$/,
    );
    return Math.max(largest, candidateCount ?? 0);
  }, 0);

  assert.ok(
    count >= 3,
    `VRM_MOTION_PRESETS or VRM_ANIMATION_PRESETS needs at least 3 entries; got ${count}`,
  );

  const motionImplementation = [studioSource, ...optionalMotionSources].join("\n");
  assert.match(
    motionImplementation,
    /(?:getNormalizedBoneNode|getRawBoneNode)\s*\(/,
    "VRM presets must resolve humanoid bones instead of only changing UI state",
  );
  assert.match(
    motionImplementation,
    /(?:quaternion|rotation)\.(?:copy|set|setFromEuler|slerp|slerpQuaternions)\s*\(/,
    "VRM preset playback must apply a rotation to resolved bones",
  );
  assert.match(
    studioSource,
    /const\s+vrmMotionPlayerRef\s*=\s*useRef<VrmMotionPlayer\s*\|\s*null>/,
    "studio must retain the active VRM motion player across renders",
  );
  const selectMotion = blockFromPattern(
    studioSource,
    /const\s+(?:selectMotionPreset|playVrmPreset|playVrmAnimation|playVrmMotion)\s*=/,
    2_600,
    "VRM preset selection handler",
  );
  assert.match(
    selectMotion,
    /(?:vrmMotionPlayerRef\.current\?\.play|player\.play|playVrmMotion)\s*\(/,
    "selecting a preset must start the VRM motion player",
  );
  const toggleMotion = blockFromPattern(
    studioSource,
    /const\s+(?:toggleAnimation|toggleVrmAnimation)\s*=/,
    2_800,
    "VRM playback toggle",
  );
  assert.match(
    toggleMotion,
    /vrmMotionPlayerRef\.current\?\.pause\s*\(|player\?\.pause\s*\(/,
    "VRM playback needs a pause/stop path",
  );
  assert.ok(
    /vrmMotionPlayerRef\.current\?\.play\s*\(|player\?\.play\s*\(|player\.resume\s*\(/.test(
      toggleMotion,
    ),
    "VRM playback toggle must resume or play the selected motion",
  );
  const speedMotion = blockFromPattern(
    studioSource,
    /const\s+(?:changeAnimationSpeed|setVrmAnimationSpeed|setVrmPlaybackSpeed|changeVrmAnimationSpeed)\s*=/,
    900,
    "VRM speed handler",
  );
  assert.match(
    speedMotion,
    /vrmMotionPlayerRef\.current\?\.setPlaybackRate\s*\(/,
    "the selected speed must reach the VRM motion player",
  );

  const presetUi = contextAround(
    studioSource,
    /(?:VRM_MOTION_PRESETS|VRM_ANIMATION_PRESETS|DOLL_MOTION_PRESETS)\s*\.map\s*\(/,
    1_500,
    2_500,
    "VRM preset selector",
  );
  assert.match(
    presetUi,
    /\b(?:modelReady|vrmReady|activeCharacterType\s*===\s*["']vrm["'])\b/,
    "VRM controls must be rendered for an active VRM, not only inside the paper-doll lab",
  );
  assert.match(
    presetUi,
    /aria-pressed=\{[^}]*(?:selectedMotion|selected[A-Za-z]*Vrm[A-Za-z]*(?:Motion|Preset|Animation))[^}]*\}/i,
    "VRM preset buttons must expose their selected state",
  );
  assert.match(presetUi, /(?:재생|Play)/i, "VRM controls need a play label");
  assert.match(presetUi, /(?:정지|일시정지|Stop|Pause)/i, "VRM controls need a stop label");
  assert.match(presetUi, /(?:속도|Speed)/i, "VRM controls need a speed label");

  const presetButton = findButton(
    studioSource,
    /(?:selectMotionPreset|selectVrm(?:Motion|Preset|Animation)|selectedMotion|selected[A-Za-z]*Vrm[A-Za-z]*(?:Motion|Preset|Animation))/i,
    "VRM preset",
  );
  const playButton = findButton(
    studioSource,
    /(?:toggleAnimation|toggleVrmAnimation|playVrmPreset|stopVrmAnimation|VRM[^<]{0,24}(?:재생|정지))/i,
    "VRM playback",
  );
  assertButtonTarget(presetButton, cssSource, "VRM preset", {
    fallbackClasses: ["motionGrid"],
  });
  assertButtonTarget(playButton, cssSource, "VRM playback");
  assert.ok(
    /\.speedControl\b[\s\S]{0,300}min-height\s*:\s*(?:4[4-9]|[5-9]\d|\d{3,})px/.test(
      cssSource,
    ) ||
      /\.vrm[A-Za-z]*(?:Speed|Controls?)\b[\s\S]{0,400}min-height\s*:\s*(?:4[4-9]|[5-9]\d|\d{3,})px/i.test(
        cssSource,
      ),
    "VRM speed control must have a 44px minimum touch target",
  );
});

test("lets live VRM tracking lock the legs and suppresses lower-body bone updates", async () => {
  const [studioSource, cssSource, rigSource] = await Promise.all([
    readFile(studioUrl, "utf8"),
    readFile(studioCssUrl, "utf8"),
    readFile(rigUrl, "utf8"),
  ]);

  assert.match(
    studioSource,
    /const\s*\[\s*(?:legsLocked|lockLegs|lowerBodyLocked)\s*,\s*set(?:LegsLocked|LockLegs|LowerBodyLocked)\s*\]\s*=\s*useState/,
    "studio must own a live-tracking leg-lock toggle",
  );
  assert.match(
    studioSource,
    /const\s+(?:legsLockedRef|lockLegsRef|lowerBodyLockedRef)\s*=\s*useRef\(\s*(?:false|legsLocked|lockLegs|lowerBodyLocked)\s*\)/,
    "an active worker callback needs a ref-backed leg-lock value",
  );
  assert.match(
    studioSource,
    /(?:legsLockedRef|lockLegsRef|lowerBodyLockedRef)\.current\s*=\s*(?:legsLocked|lockLegs|lowerBodyLocked|nextLocked)[\s\S]{0,160}set(?:LegsLocked|LockLegs|LowerBodyLocked)\s*\(\s*(?:legsLocked|lockLegs|lowerBodyLocked|nextLocked)\s*\)/,
    "the live leg-lock ref must stay synchronized with UI state",
  );

  const applyTracking = blockFromPattern(
    studioSource,
    /applyVrmTracking\s*\(\s*vrm\s*,/,
    1_600,
    "VRM tracking application",
  );
  assert.match(
    applyTracking,
    /enableLegs\s*:\s*!\s*(?:legsLockedRef|lockLegsRef|lowerBodyLockedRef)\.current/,
    "the leg-lock state must disable MediaPipe/Kalidokit leg solving",
  );
  assert.match(
    applyTracking,
    /applyHipsPosition\s*:\s*!\s*(?:legsLockedRef|lockLegsRef|lowerBodyLockedRef)\.current/,
    "locking the lower body must also stop tracking-driven hips translation",
  );

  assert.match(
    rigSource,
    /Pose\.solve\([\s\S]{0,500}enableLegs\s*:\s*options\.enableLegs/,
    "enableLegs must reach Kalidokit's pose solver",
  );
  assert.match(
    rigSource,
    /if\s*\(\s*!options\.enableLegs\s*&&[\s\S]{0,160}(?:Leg|Foot)[\s\S]{0,80}\)\s*continue/,
    "the rig must skip lower-body bone writes while legs are locked",
  );
  assert.match(
    applyTracking,
    /if\s*\(\s*(?:legsLockedRef|lockLegsRef|lowerBodyLockedRef)\.current\s*\)[^;]{0,160}(?:vrmLegLockRef|lowerBodyLockRef)\.current\?\.enforce\s*\(/,
    "a locked VRM must re-enforce its captured leg rotations after each tracking frame",
  );

  const lockButton = findButton(
    studioSource,
    /(?:legsLocked|lockLegs|lowerBodyLocked|다리\s*(?:고정|잠금))/,
    "leg lock",
  );
  assert.match(
    lockButton,
    /aria-pressed=\{\s*(?:legsLocked|lockLegs|lowerBodyLocked)\s*\}/,
    "leg-lock state must be announced to assistive technology",
  );
  const lockButtonIndex = studioSource.indexOf(lockButton);
  const lockButtonContext = studioSource.slice(
    Math.max(0, lockButtonIndex - 1_000),
    lockButtonIndex + lockButton.length,
  );
  assert.ok(
    /disabled=\{[^}]*(?:!modelReady|!characterReady|modelState\s*!==\s*["']ready["'])/.test(
      lockButton,
    ) ||
      /\{\s*(?:modelReady|modelState\s*===\s*["']ready["'])\s*(?:&&|\?)/.test(
        lockButtonContext,
      ),
    "leg lock must be disabled or hidden without a ready VRM",
  );
  assertButtonTarget(lockButton, cssSource, "leg lock");
});

test("renders mirrored pose, face, and both-hand landmark points over the camera", async () => {
  const [
    studioSource,
    studioCssSource,
    componentSource,
    componentCssSource,
    ...optionalOverlaySources
  ] = await Promise.all([
    readFile(studioUrl, "utf8"),
    readFile(studioCssUrl, "utf8"),
    readOptional(trackingOverlayUrl),
    readOptional(trackingOverlayCssUrl),
    ...optionalTrackingOverlayUrls.map(readOptional),
  ]);
  const overlaySource = [
    studioSource,
    componentSource,
    ...optionalOverlaySources,
  ].join("\n");
  const overlayCssSource = [studioCssSource, componentCssSource].join("\n");

  assert.ok(
    /const\s+(?:trackingOverlayCanvasRef|landmarkOverlayCanvasRef)\s*=\s*useRef<HTMLCanvasElement(?:\s*\|\s*null)?>\(\s*null\s*\)/.test(
      studioSource,
    ) ||
      /const\s+(?:trackingOverlayRef|landmarkOverlayRef)\s*=\s*useRef<TrackingLandmarkOverlayHandle(?:\s*\|\s*null)?>\(\s*null\s*\)/.test(
        studioSource,
      ),
    "camera landmark overlay needs an owned canvas or imperative component ref",
  );
  assert.ok(
    /\b(?:drawTrackingLandmarks|renderTrackingOverlay)\s*\(/.test(studioSource) ||
      /(?:trackingOverlayRef|landmarkOverlayRef)\.current\?\.draw\s*\(/.test(
        studioSource,
      ),
    "tracking results must be sent to the camera overlay",
  );
  const overlayIntegration = blockFromPattern(
    studioSource,
    /(?:(?:drawTrackingLandmarks|renderTrackingOverlay)\s*\(|(?:trackingOverlayRef|landmarkOverlayRef)\.current\?\.draw\s*\()/,
    1_200,
    "tracking-result overlay integration",
  );
  const passesWholeResult = /\(\s*(?:message\.)?result\s*\)/.test(
    overlayIntegration,
  );

  for (const field of [
    "poseLandmarks",
    "faceLandmarks",
    "leftHandLandmarks",
    "rightHandLandmarks",
  ]) {
    assert.match(
      passesWholeResult ? overlaySource : overlayIntegration,
      new RegExp(`\\b${field}\\b`),
      `${field} must reach the camera overlay renderer`,
    );
  }
  assert.match(
    overlaySource,
    /(?:getContext\s*\(\s*["']2d["']\s*\)|drawLandmarks\s*\(|\.arc\s*\()/,
    "the overlay renderer must draw visible landmark points",
  );

  const cameraPreview = blockFromPattern(
    studioSource,
    /className=\{styles\.cameraPreview\}/,
    1_400,
    "camera preview",
  );
  assert.ok(
    /<canvas[\s\S]{0,300}ref=\{(?:trackingOverlayCanvasRef|landmarkOverlayCanvasRef)\}/.test(
      cameraPreview,
    ) ||
      /<TrackingLandmarkOverlay[\s\S]{0,300}ref=\{(?:trackingOverlayRef|landmarkOverlayRef)\}/.test(
        cameraPreview,
      ),
    "the landmark renderer must be layered inside the camera preview",
  );
  assert.ok(
    /<canvas[\s\S]{0,400}aria-hidden=["'{]true/.test(cameraPreview) ||
      /<canvas[\s\S]{0,400}aria-hidden=["'{]true/.test(componentSource),
    "decorative landmark points must stay out of the accessibility tree",
  );

  const stopTracking = blockFromPattern(
    studioSource,
    /const\s+stopTracking\s*=\s*useCallback/,
    2_600,
    "tracking cleanup",
  );
  assert.match(
    stopTracking,
    /(?:clearTrackingOverlay\s*\(|clearRect\s*\(|(?:trackingOverlayRef|landmarkOverlayRef)\.current\?\.clear\s*\()/,
    "stopping the camera must clear stale landmark points",
  );
  assert.match(
    overlayCssSource,
    /\.(?:trackingOverlay|landmarkOverlay|canvas)[^{]*\{[^}]*position\s*:\s*absolute[^}]*pointer-events\s*:\s*none/s,
    "the landmark canvas must be a non-interactive absolute overlay",
  );
  assert.ok(
    /\.(?:trackingOverlay|landmarkOverlay|canvas)[^{]*\{[^}]*transform\s*:\s*scaleX\(\s*-1\s*\)/s.test(
      overlayCssSource,
    ) ||
      /(?:1\s*-\s*(?:point|landmark)\.x|mirror\s*\?\s*1\s*-\s*landmark\.x|canvas\.width\s*\*\s*\(\s*1\s*-)/.test(
        overlaySource,
      ),
    "overlay coordinates must mirror with the selfie preview",
  );
});

test("opens the active 2D or VRM stage in local Picture-in-Picture and cleans it up", async () => {
  const [studioSource, cssSource, paperDollSource] = await Promise.all([
    readFile(studioUrl, "utf8"),
    readFile(studioCssUrl, "utf8"),
    readFile(paperDollUrl, "utf8"),
  ]);

  assert.match(
    studioSource,
    /const\s+(?:pipVideoRef|pictureInPictureVideoRef)\s*=\s*useRef<HTMLVideoElement(?:\s*\|\s*null)?>\(\s*null\s*\)/,
    "stage PiP needs a dedicated video element ref",
  );
  assert.match(
    studioSource,
    /const\s+(?:pipStreamRef|pictureInPictureStreamRef)\s*=\s*useRef<MediaStream(?:\s*\|\s*null)?>\(\s*null\s*\)/,
    "stage PiP must own a stream separate from the camera stream",
  );
  assert.match(
    studioSource,
    /const\s+(?:pipSessionRef|pictureInPictureSessionRef)\s*=\s*useRef(?:<number>)?\(/,
    "async PiP entry needs a session token for load/unmount cancellation",
  );
  assert.match(
    studioSource,
    /const\s+(?:pipTransitionRef|pictureInPictureTransitionRef)\s*=\s*useRef\(\s*false\s*\)/,
    "PiP needs a synchronous transition lock before its first await",
  );
  assert.match(
    studioSource,
    /const\s*\[\s*(?:pipTransitioning|pictureInPictureTransitioning)\s*,\s*set(?:PipTransitioning|PictureInPictureTransitioning)\s*\]\s*=\s*useState\(\s*false\s*\)/,
    "PiP transition state must be reflected in the UI",
  );

  const enterPip = blockFromPattern(
    studioSource,
    /const\s+(?:enterStagePictureInPicture|openStagePictureInPicture|startStagePictureInPicture)\s*=/,
    7_000,
    "stage Picture-in-Picture entry handler",
  );
  assert.match(
    enterPip,
    /(?:document\.pictureInPictureEnabled|requestPictureInPicture\s+["']?in|typeof\s+[^\n;]*requestPictureInPicture)/,
    "PiP entry must feature-detect the browser API",
  );
  assert.ok(
    /(?:PiP|Picture-in-Picture|화면\s*속\s*화면|작은\s*화면)/i.test(enterPip) &&
      /(?:지원하지|미지원|사용할\s*수\s*없)/.test(enterPip),
    "unsupported browsers must receive a clear PiP explanation",
  );
  assert.match(
    enterPip,
    /rendererRef\.current\??\.domElement/,
    "VRM PiP must capture the Three.js renderer canvas",
  );
  assert.ok(
    /paperDollRef\.current\?\.(?:getCanvas|getStageCanvas|captureStream)/.test(enterPip) ||
      (/paperDollActive/.test(enterPip) && /querySelector(?:<HTMLCanvasElement>)?\s*\(/.test(enterPip)) ||
      /(?:getCanvas|getStageCanvas|captureStream)/.test(paperDollSource),
    "PiP must also be able to capture the active paper-doll canvas",
  );
  assert.match(enterPip, /\.captureStream\s*\(/, "PiP must use a browser-local canvas stream");
  assert.match(
    enterPip,
    /\.requestPictureInPicture\s*\(/,
    "the dedicated PiP video must enter browser Picture-in-Picture",
  );
  assert.match(
    enterPip,
    /(?:pipSessionRef|pictureInPictureSessionRef)\.current\s*!==\s*(?:session|pipSession|entrySession)/,
    "stale async PiP entry must release instead of becoming active",
  );
  assert.match(
    enterPip,
    /if\s*\(\s*(?:pipTransitionRef|pictureInPictureTransitionRef)\.current\s*\)\s*return/,
    "a second PiP request must be rejected while entry or exit is pending",
  );
  assert.match(
    enterPip,
    /(?:pipTransitionRef|pictureInPictureTransitionRef)\.current\s*=\s*true[\s\S]{0,180}set(?:PipTransitioning|PictureInPictureTransitioning)\s*\(\s*true\s*\)/,
    "PiP must lock synchronously before starting asynchronous browser work",
  );

  assert.match(
    studioSource,
    /<video[\s\S]{0,350}ref=\{(?:pipVideoRef|pictureInPictureVideoRef)\}[\s\S]{0,350}(?:muted[\s\S]{0,120}playsInline|playsInline[\s\S]{0,120}muted)/,
    "PiP needs a muted inline local video element",
  );
  assert.match(
    studioSource,
    /(?:leavepictureinpicture|onleavepictureinpicture)/,
    "browser-initiated PiP exit must reset local state and resources",
  );

  const exitPip = blockFromPattern(
    studioSource,
    /const\s+(?:exitStagePictureInPicture|cleanupStagePictureInPicture|stopStagePictureInPicture)\s*=/,
    4_500,
    "stage Picture-in-Picture cleanup",
  );
  const resourceCleanupMatch = studioSource.match(
    /const\s+(?:releasePipResources|releasePictureInPictureResources)\s*=/,
  );
  const pipCleanupSource = [
    exitPip,
    resourceCleanupMatch
      ? studioSource.slice(resourceCleanupMatch.index, resourceCleanupMatch.index + 2_500)
      : "",
  ].join("\n");
  assert.match(
    pipCleanupSource,
    /(?:pipSessionRef|pictureInPictureSessionRef)\.current\s*(?:\+=\s*1|\+\+)/,
    "PiP cleanup must invalidate an entry still awaiting play/request",
  );
  assert.match(
    exitPip,
    /document\.pictureInPictureElement[\s\S]{0,500}exitPictureInPicture\s*\(/,
    "PiP cleanup must leave the browser's active picture",
  );
  assert.match(
    pipCleanupSource,
    /(?:(?:pipStreamRef|pictureInPictureStreamRef)\.current|expectedStream)\??\.getTracks\s*\(\s*\)[\s\S]{0,180}\.stop\s*\(/,
    "PiP cleanup must stop every local canvas-stream track",
  );
  assert.match(
    pipCleanupSource,
    /\.srcObject\s*=\s*null/,
    "PiP cleanup must detach its video stream",
  );

  const pipButton = findButton(
    studioSource,
    /(?:enterStagePictureInPicture|exitStagePictureInPicture|openStagePictureInPicture|pipActive|pictureInPictureActive)/,
    "Picture-in-Picture",
  );
  assert.match(
    pipButton,
    /aria-pressed=\{\s*(?:pipActive|pictureInPictureActive)\s*\}/,
    "PiP active state must be exposed to assistive technology",
  );
  assert.match(
    pipButton,
    /disabled=\{[^}]*(?:isRecording|modelState\s*===\s*["']loading["'])/,
    "PiP entry must be disabled during recording or VRM replacement",
  );
  assert.match(
    pipButton,
    /disabled=\{[^}]*(?:pipTransitioning|pictureInPictureTransitioning)/,
    "the PiP control must stay disabled for the complete browser transition",
  );
  assert.match(
    pipButton,
    /aria-busy=\{\s*(?:pipTransitioning|pictureInPictureTransitioning)\s*\}/,
    "assistive technology must receive the PiP transition state",
  );
  assertButtonTarget(pipButton, cssSource, "Picture-in-Picture");
});

test("offers an accessible chroma-key green stage background for 2D and VRM", async () => {
  const [studioSource, cssSource] = await Promise.all([
    readFile(studioUrl, "utf8"),
    readFile(studioCssUrl, "utf8"),
  ]);

  assert.match(
    studioSource,
    /const\s+CHROMA_KEY_GREEN\s*=\s*["'](?:#00ff00|#00b140|rgb\(\s*0\s*,\s*255\s*,\s*0\s*\))["']/i,
    "studio must name a standard chroma-key green value",
  );
  assert.match(
    studioSource,
    /STAGE_COLORS\s*=\s*\[[\s\S]{0,400}CHROMA_KEY_GREEN[\s\S]{0,400}\]/,
    "chroma-key green must be one of the selectable stage colors",
  );

  const chromaButton = findButton(
    studioSource,
    /(?:CHROMA_KEY_GREEN|크로마키\s*초록)/,
    "chroma-key green",
  );
  const hasDirectChromaLabel = /aria-label=["'{`][^\n}]*크로마키\s*초록/.test(
    chromaButton,
  );
  const hasCatalogDrivenChromaLabel =
    /CHROMA_KEY_GREEN\s*,\s*label\s*:\s*["']크로마키\s*초록["']/.test(
      studioSource,
    ) && /aria-label=\{`[^`]*\$\{label\}[^`]*`\}/.test(chromaButton);
  assert.ok(
    hasDirectChromaLabel || hasCatalogDrivenChromaLabel,
    "the green swatch needs a meaningful Korean accessible name",
  );
  assert.match(
    chromaButton,
    /aria-pressed=\{[^}]*(?:stageColor|selectedStageColor)[^}]*\}/,
    "the selected background color must be exposed with aria-pressed",
  );
  assertButtonTarget(chromaButton, cssSource, "chroma-key green", { square: true });

  assert.match(
    studioSource,
    /sceneRef\.current\.background\s*=\s*new\s+THREE\.Color\(stageColor\)/,
    "the selected green must reach the 3D VRM renderer",
  );
  assert.match(
    studioSource,
    /style=\{paperDollActive\s*\?\s*\{\s*background\s*:\s*stageColor\s*\}/,
    "the selected green must also reach the 2D paper-doll stage",
  );
});

test("keeps stage settings visible on mobile and restores speed-control focus", async () => {
  const [studioSource, cssSource] = await Promise.all([
    readFile(studioUrl, "utf8"),
    readFile(studioCssUrl, "utf8"),
  ]);

  const settingsPanel = studioSource.slice(
    studioSource.lastIndexOf('<aside className={styles.panel}'),
  );
  assert.match(
    settingsPanel,
    /STAGE_COLORS\.map\s*\(/,
    "the responsive settings panel must own the background choices",
  );
  assert.match(
    settingsPanel,
    /onClick=\{toggleLegLock\}/,
    "the responsive settings panel must own the leg-lock control",
  );

  for (const [pattern, label] of [
    [/@media\s*\(max-width:\s*1120px\)/, "tablet settings media query"],
    [/@media\s*\(max-width:\s*760px\)/, "mobile settings media query"],
  ]) {
    const media = balancedBlockFromPattern(cssSource, pattern, label);
    const panelRule = media.match(/\.panel:last-child\s*\{([^}]*)\}/);
    assert.ok(panelRule, `${label} must explicitly lay out the settings panel`);
    assert.doesNotMatch(
      panelRule[1],
      /display\s*:\s*none/,
      `${label} must not hide chroma-key or leg-lock controls`,
    );
    assert.match(
      panelRule[1],
      /display\s*:\s*(?:flex|grid|block)/,
      `${label} must keep the settings panel visible`,
    );
  }

  assert.match(
    cssSource,
    /(?:\.speedControl:focus-within|\.speedControl\s+select:focus-visible)\s*\{[^}]*(?:outline\s*:\s*(?!0\b)|box-shadow\s*:)/s,
    "keyboard focus on the playback-speed select must remain visibly indicated",
  );
});

test("serializes recording, camera, VRM loading, PiP, and VRM motion teardown", async () => {
  const studioSource = await readFile(studioUrl, "utf8");

  const startTracking = blockFromPattern(
    studioSource,
    /const\s+startTracking\s*=\s*useCallback/,
    2_000,
    "camera startup handler",
  );
  assert.match(startTracking, /if\s*\(\s*isRecording\s*\)/, "camera must not start during recording");
  assert.match(
    startTracking,
    /(?:(?:stopVrmAnimation|stopVrmMotion|pauseVrmAnimation|pauseVrmMotion)\s*\(|vrmMotionPlayerRef\.current\?\.(?:stop|pause)\s*\()/,
    "live camera tracking must stop a competing VRM preset",
  );

  const playVrm = blockFromPattern(
    studioSource,
    /const\s+(?:selectMotionPreset|playVrmPreset|playVrmAnimation|playVrmMotion)\s*=/,
    3_500,
    "VRM preset play handler",
  );
  assert.match(
    playVrm,
    /if\s*\(\s*trackingState\s*!==\s*["']idle["']\s*\)\s*stopTracking\s*\(/,
    "starting a VRM preset must cancel loading or running camera tracking",
  );

  const loadVrm = blockFromPattern(
    studioSource,
    /const\s+handleModelFile\s*=\s*useCallback/,
    5_000,
    "VRM load handler",
  );
  assert.match(loadVrm, /if\s*\(\s*isRecording\s*\)/, "VRM replacement must be blocked during recording");
  assert.match(loadVrm, /stopTracking\s*\(/, "VRM replacement must close the active camera session");
  assert.match(
    loadVrm,
    /(?:(?:stopVrmAnimation|stopVrmMotion|pauseVrmAnimation|pauseVrmMotion)\s*\(|vrmMotionPlayerRef\.current\?\.(?:stop|dispose)\s*\()[\s\S]{0,1600}await\s+loadVrm\s*\(/,
    "VRM replacement must stop the old animation before awaiting the new model",
  );
  assert.match(
    loadVrm,
    /(?:exitStagePictureInPicture|cleanupStagePictureInPicture|stopStagePictureInPicture)\s*\(/,
    "VRM replacement must close a PiP stream bound to the old stage state",
  );
  assert.match(
    loadVrm,
    /const\s+loadSession\s*=\s*\+\+(?:modelLoadSessionRef)\.current[\s\S]{0,1600}modelLoadSessionRef\.current\s*!==\s*loadSession[\s\S]{0,300}disposeVrm\s*\(/,
    "a stale async VRM load must dispose its result instead of replacing the current model",
  );

  const recordAnimation = blockFromPattern(
    studioSource,
    /const\s+recordAnimation\s*=\s*useCallback/,
    2_800,
    "animation recording handler",
  );
  assert.ok(
    /(?:exitStagePictureInPicture|cleanupStagePictureInPicture|stopStagePictureInPicture)\s*\(/.test(
      recordAnimation,
    ) || /if\s*\(\s*(?:pipActive|pictureInPictureActive)\s*\)/.test(recordAnimation),
    "recording must close or explicitly reject an already active PiP session",
  );

  const enterPip = blockFromPattern(
    studioSource,
    /const\s+(?:enterStagePictureInPicture|openStagePictureInPicture|startStagePictureInPicture)\s*=/,
    1_500,
    "PiP entry handler",
  );
  assert.match(enterPip, /if\s*\(\s*isRecording\b/, "PiP must not start during recording");

  const teardown = contextAround(
    studioSource,
    /modelLoadSessionRef\.current\s*\+=\s*1/,
    300,
    1_500,
    "studio unmount teardown",
  );
  for (const [pattern, label] of [
    [/cancelRecording\s*\(/, "recording"],
    [/stopTracking\s*\(/, "camera"],
    [/(?:exitStagePictureInPicture|cleanupStagePictureInPicture|stopStagePictureInPicture|releasePipResources)\s*\(/, "PiP"],
  ]) {
    assert.match(teardown, pattern, `component unmount must clean up ${label}`);
  }
  assert.match(
    studioSource,
    /return\s*\(\s*\)\s*=>\s*\{[\s\S]{0,1200}vrmMotionPlayerRef\.current\?\.dispose\s*\(\)[\s\S]{0,300}vrmLegLockRef\.current\?\.dispose\s*\(\)/,
    "component unmount must dispose both the VRM motion loop and captured leg lock",
  );
});
