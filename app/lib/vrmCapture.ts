/**
 * Transparent, full-body PNG capture for a posed VRM.
 *
 * This is an original implementation for the avatar-studio workflow inspired
 * by Kalidoface 3D (https://github.com/yeemachine/kalidoface-3d).
 */

import {
  Box3,
  Color,
  MathUtils,
  PerspectiveCamera,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type Material,
  type Mesh,
  type Object3D,
  type Scene,
  type SkinnedMesh,
  type WebGLRenderer,
} from "three";
import type { VRM } from "@pixiv/three-vrm";

export const DEFAULT_CAPTURE_WIDTH = 1536;
export const DEFAULT_CAPTURE_HEIGHT = 2048;

export type Vector3Input = Vector3 | readonly [number, number, number];

export interface FitVrmCameraOptions {
  /** Extra room around the avatar as a fraction of its projected size. */
  margin?: number;
  /** Direction from the avatar toward the camera. Defaults to +Z. */
  viewDirection?: Vector3Input;
  /** Camera-up direction. Defaults to +Y. */
  up?: Vector3Input;
  aspect?: number;
}

export interface CaptureVrmPngOptions {
  renderer: WebGLRenderer;
  scene: Scene;
  vrm: VRM;
  /** Scene helpers (grid, skeleton, landmark dots, gizmos) hidden for one render only. */
  helpers?: readonly Object3D[];
  width?: number;
  height?: number;
  /** Extra room around the full-body bounds. Defaults to 12%. */
  margin?: number;
  /** Direction from the avatar toward the capture camera. Defaults to +Z. */
  viewDirection?: Vector3Input;
  /** Optional camera whose projection settings are cloned, never mutated. */
  camera?: PerspectiveCamera;
  /** MSAA samples for the offscreen target. Defaults to 4 when supported. */
  samples?: number;
  /** Convert premultiplied WebGL RGB values before placing them on a 2D canvas. */
  unpremultiplyAlpha?: boolean;
}

export interface CapturedVrmPng {
  blob: Blob;
  width: number;
  height: number;
  /** Exact world-space bounds measured from the currently posed mesh vertices. */
  bounds: Box3;
  /** The fitted clone used for the offscreen render. */
  camera: PerspectiveCamera;
}

interface CaptureSize {
  width: number;
  height: number;
}

function asVector3(value: Vector3Input | undefined, fallback: Vector3): Vector3 {
  if (!value) return fallback.clone();
  if (value instanceof Vector3) return value.clone();
  return new Vector3(value[0], value[1], value[2]);
}

function isEffectivelyVisible(object: Object3D, root: Object3D): boolean {
  let current: Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    if (current === root) return true;
    current = current.parent;
  }
  return true;
}

function hasVisibleMaterial(material: Material | Material[]): boolean {
  return Array.isArray(material) ? material.some((entry) => entry.visible) : material.visible;
}

/**
 * Compute bounds from deformed vertices, not the avatar's bind-pose geometry.
 * This makes raised arms, bent legs, morph targets and the current skin pose fit.
 */
export function computePosedVrmBounds(vrm: VRM): Box3 {
  const root = vrm.scene;
  const bounds = new Box3().makeEmpty();
  const localVertex = new Vector3();
  const worldVertex = new Vector3();

  root.updateWorldMatrix(true, true);
  root.traverse((object: Object3D) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh || !isEffectivelyVisible(mesh, root) || !hasVisibleMaterial(mesh.material)) return;

    const position = mesh.geometry.getAttribute("position");
    if (!position) return;

    if ((mesh as SkinnedMesh).isSkinnedMesh) {
      const skinnedMesh = mesh as SkinnedMesh;
      skinnedMesh.skeleton.update();
      // Refresh culling data too, so the offscreen renderer cannot drop a posed limb.
      skinnedMesh.computeBoundingBox();
      skinnedMesh.computeBoundingSphere();
    }

    if ((mesh as Mesh & { isInstancedMesh?: boolean }).isInstancedMesh) {
      // VRM avatars normally do not use instancing. Keep a conservative fallback for add-ons.
      const instancedBounds = new Box3().setFromObject(mesh, true);
      bounds.union(instancedBounds);
      return;
    }

    for (let index = 0; index < position.count; index += 1) {
      mesh.getVertexPosition(index, localVertex);
      worldVertex.copy(localVertex).applyMatrix4(mesh.matrixWorld);
      bounds.expandByPoint(worldVertex);
    }
  });

  return bounds;
}

function boxCorners(box: Box3): Vector3[] {
  const { min, max } = box;
  return [
    new Vector3(min.x, min.y, min.z),
    new Vector3(min.x, min.y, max.z),
    new Vector3(min.x, max.y, min.z),
    new Vector3(min.x, max.y, max.z),
    new Vector3(max.x, min.y, min.z),
    new Vector3(max.x, min.y, max.z),
    new Vector3(max.x, max.y, min.z),
    new Vector3(max.x, max.y, max.z),
  ];
}

/** Fit a perspective camera around a world-space box for any requested view direction. */
export function fitPerspectiveCameraToBounds(
  camera: PerspectiveCamera,
  bounds: Box3,
  options: FitVrmCameraOptions = {},
): PerspectiveCamera {
  if (bounds.isEmpty()) throw new Error("Cannot fit a camera to empty VRM bounds.");

  const aspect = options.aspect ?? camera.aspect;
  if (!Number.isFinite(aspect) || aspect <= 0) throw new RangeError("Camera aspect must be positive.");

  const margin = Math.max(0, options.margin ?? 0.12);
  const center = bounds.getCenter(new Vector3());
  const viewDirection = asVector3(options.viewDirection, new Vector3(0, 0, 1));
  if (viewDirection.lengthSq() < Number.EPSILON) {
    throw new RangeError("viewDirection must not be a zero vector.");
  }
  viewDirection.normalize();

  let up = asVector3(options.up, new Vector3(0, 1, 0));
  if (up.lengthSq() < Number.EPSILON) up.set(0, 1, 0);
  up.normalize();
  if (Math.abs(up.dot(viewDirection)) > 0.999) {
    up = Math.abs(viewDirection.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  }

  camera.aspect = aspect;
  camera.up.copy(up);
  camera.clearViewOffset();
  camera.position.copy(center).add(viewDirection);
  camera.lookAt(center);
  camera.updateMatrixWorld(true);

  const cameraRight = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const cameraUp = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const verticalTangent = Math.tan(MathUtils.degToRad(camera.getEffectiveFOV()) / 2);
  const horizontalTangent = verticalTangent * aspect;
  if (verticalTangent <= 0 || horizontalTangent <= 0) {
    throw new RangeError("The camera field of view and aspect must produce a valid frustum.");
  }

  let distance = 0;
  let nearestOffset = Number.POSITIVE_INFINITY;
  let farthestOffset = Number.NEGATIVE_INFINITY;
  const offset = new Vector3();
  const paddingScale = 1 + margin;

  for (const corner of boxCorners(bounds)) {
    offset.copy(corner).sub(center);
    const towardCamera = offset.dot(viewDirection);
    const horizontal = Math.abs(offset.dot(cameraRight)) * paddingScale;
    const vertical = Math.abs(offset.dot(cameraUp)) * paddingScale;
    distance = Math.max(
      distance,
      towardCamera + horizontal / horizontalTangent,
      towardCamera + vertical / verticalTangent,
    );
    nearestOffset = Math.min(nearestOffset, towardCamera);
    farthestOffset = Math.max(farthestOffset, towardCamera);
  }

  const size = bounds.getSize(new Vector3());
  const minimumDistance = Math.max(size.length() * 0.01, 0.01);
  distance = Math.max(distance, minimumDistance);
  camera.position.copy(center).addScaledVector(viewDirection, distance);
  camera.near = Math.max(0.001, (distance - farthestOffset) * 0.25);
  camera.far = Math.max(camera.near + 1, (distance - nearestOffset) * 2);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

function positiveDimension(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive number.`);
  }
  return Math.max(1, Math.round(resolved));
}

function resolveCaptureSize(renderer: WebGLRenderer, width?: number, height?: number): CaptureSize {
  let resolvedWidth = positiveDimension(width, DEFAULT_CAPTURE_WIDTH, "width");
  let resolvedHeight = positiveDimension(height, DEFAULT_CAPTURE_HEIGHT, "height");
  const maximum = renderer.capabilities.maxTextureSize;
  const scale = Math.min(1, maximum / resolvedWidth, maximum / resolvedHeight);
  resolvedWidth = Math.max(1, Math.floor(resolvedWidth * scale));
  resolvedHeight = Math.max(1, Math.floor(resolvedHeight * scale));
  return { width: resolvedWidth, height: resolvedHeight };
}

function flipPixels(
  source: Uint8Array,
  width: number,
  height: number,
  unpremultiplyAlpha: boolean,
): Uint8ClampedArray<ArrayBuffer> {
  const result = new Uint8ClampedArray(source.length);
  const rowLength = width * 4;

  for (let outputY = 0; outputY < height; outputY += 1) {
    const sourceY = height - outputY - 1;
    const sourceOffset = sourceY * rowLength;
    const outputOffset = outputY * rowLength;
    result.set(source.subarray(sourceOffset, sourceOffset + rowLength), outputOffset);
  }

  if (unpremultiplyAlpha) {
    for (let index = 0; index < result.length; index += 4) {
      const alpha = result[index + 3];
      if (alpha > 0 && alpha < 255) {
        const multiplier = 255 / alpha;
        result[index] = Math.min(255, Math.round(result[index] * multiplier));
        result[index + 1] = Math.min(255, Math.round(result[index + 1] * multiplier));
        result[index + 2] = Math.min(255, Math.round(result[index + 2] * multiplier));
      }
    }
  }

  return result;
}

async function rgbaPixelsToPngBlob(
  pixels: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
): Promise<Blob> {
  const imageData = new ImageData(pixels, width, height);

  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("A 2D canvas context is unavailable for PNG encoding.");
    context.putImageData(imageData, 0, 0);
    return canvas.convertToBlob({ type: "image/png" });
  }

  if (typeof document === "undefined") {
    throw new Error("PNG capture requires a browser Canvas or OffscreenCanvas implementation.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("A 2D canvas context is unavailable for PNG encoding.");
  context.putImageData(imageData, 0, 0);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("The browser could not encode the VRM capture as PNG."));
    }, "image/png");
  });
}

/**
 * Render a transparent high-resolution PNG without resizing the visible canvas.
 * Renderer target/viewport/scissor/clear/XR state, scene background, and helper
 * visibility are restored even when rendering or encoding fails.
 */
export async function captureVrmFullBodyPng(
  options: CaptureVrmPngOptions,
): Promise<CapturedVrmPng> {
  const { renderer, scene, vrm } = options;
  const { width, height } = resolveCaptureSize(renderer, options.width, options.height);
  const bounds = computePosedVrmBounds(vrm);
  if (bounds.isEmpty()) throw new Error("The VRM has no visible mesh vertices to capture.");

  const camera = options.camera
    ? (options.camera.clone() as PerspectiveCamera)
    : new PerspectiveCamera(30, width / height, 0.01, 100);
  fitPerspectiveCameraToBounds(camera, bounds, {
    aspect: width / height,
    margin: options.margin,
    viewDirection: options.viewDirection,
  });

  const renderTarget = new WebGLRenderTarget(width, height, {
    format: RGBAFormat,
    type: UnsignedByteType,
    depthBuffer: true,
    stencilBuffer: false,
  });
  renderTarget.texture.colorSpace = renderer.outputColorSpace || SRGBColorSpace;
  renderTarget.texture.generateMipmaps = false;
  const requestedSamples = Math.max(0, Math.trunc(options.samples ?? 4));
  renderTarget.samples = Math.min(requestedSamples, renderer.capabilities.maxSamples);

  const previousTarget = renderer.getRenderTarget();
  const previousCubeFace = renderer.getActiveCubeFace();
  const previousMipmapLevel = renderer.getActiveMipmapLevel();
  const previousViewport = renderer.getViewport(new Vector4());
  const previousScissor = renderer.getScissor(new Vector4());
  const previousScissorTest = renderer.getScissorTest();
  const previousClearColor = renderer.getClearColor(new Color());
  const previousClearAlpha = renderer.getClearAlpha();
  const previousAutoClear = renderer.autoClear;
  const previousXrEnabled = renderer.xr.enabled;
  const previousBackground = scene.background;
  const helperVisibility = new Map<Object3D, boolean>();
  const pixels = new Uint8Array(width * height * 4);
  let flipped: Uint8ClampedArray<ArrayBuffer> | undefined;

  for (const helper of options.helpers ?? []) {
    helperVisibility.set(helper, helper.visible);
    helper.visible = false;
  }

  try {
    scene.background = null;
    renderer.xr.enabled = false;
    renderer.autoClear = true;
    renderer.setRenderTarget(renderTarget);
    renderer.setViewport(0, 0, width, height);
    renderer.setScissor(0, 0, width, height);
    renderer.setScissorTest(false);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(renderTarget, 0, 0, width, height, pixels);

    flipped = flipPixels(
      pixels,
      width,
      height,
      options.unpremultiplyAlpha ?? true,
    );
  } finally {
    for (const [helper, visible] of helperVisibility) helper.visible = visible;
    scene.background = previousBackground;
    renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel);
    renderer.setViewport(previousViewport);
    renderer.setScissor(previousScissor);
    renderer.setScissorTest(previousScissorTest);
    renderer.setClearColor(previousClearColor, previousClearAlpha);
    renderer.autoClear = previousAutoClear;
    renderer.xr.enabled = previousXrEnabled;
    renderTarget.dispose();
  }

  // Encode only after restoring shared renderer/scene state; the app's normal
  // animation loop can safely resume while the browser compresses the PNG.
  if (!flipped) throw new Error("The VRM capture did not produce pixel data.");
  const blob = await rgbaPixelsToPngBlob(flipped, width, height);
  return { blob, width, height, bounds, camera };
}

function pngFilename(filename: string): string {
  const trimmed = filename.trim() || "my-vrm-character";
  return trimmed.toLowerCase().endsWith(".png") ? trimmed : `${trimmed}.png`;
}

/** Trigger a browser download and promptly release the temporary object URL. */
export function downloadBlob(blob: Blob, filename = "my-vrm-character.png"): void {
  if (typeof document === "undefined") {
    throw new Error("Downloading a capture requires a browser document.");
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = pngFilename(filename);
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Capture the posed avatar and immediately download the resulting PNG. */
export async function captureAndDownloadVrm(
  options: CaptureVrmPngOptions,
  filename = "my-vrm-character.png",
): Promise<CapturedVrmPng> {
  const result = await captureVrmFullBodyPng(options);
  downloadBlob(result.blob, filename);
  return result;
}
