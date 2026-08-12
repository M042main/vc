/**
 * Viewport zoom intentionally spans a very wide range so the stage does not
 * feel artificially bounded, while still keeping finite values for Canvas and
 * Three.js. A 5,000x range is effectively unbounded for normal wheel/trackpad
 * use and avoids the NaN/precision failures caused by allowing Infinity.
 */
export const STAGE_ZOOM_MIN = 0.02;
export const STAGE_ZOOM_MAX = 100;
export const STAGE_CAMERA_MIN_DISTANCE = 0.02;
export const STAGE_CAMERA_MAX_DISTANCE = 100;
export const STAGE_CAMERA_NEAR_PLANE = 0.001;
export const STAGE_CAMERA_FAR_PLANE = 1000;
export const STAGE_ZOOM_BUTTON_FACTOR = 1.25;

const MAX_WHEEL_DELTA_PIXELS = 240;
const WHEEL_ZOOM_SENSITIVITY = 0.002;

function finiteOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

export function clampStageZoom(value: number) {
  return Math.min(
    STAGE_ZOOM_MAX,
    Math.max(STAGE_ZOOM_MIN, finiteOr(value, 1)),
  );
}

export function normalizeWheelDelta(
  deltaY: number,
  deltaMode = 0,
  viewportHeight = 800,
) {
  const finiteDelta = finiteOr(deltaY, 0);
  const pixelDelta =
    deltaMode === 1
      ? finiteDelta * 16
      : deltaMode === 2
        ? finiteDelta * Math.max(1, finiteOr(viewportHeight, 800))
        : finiteDelta;

  return Math.min(
    MAX_WHEEL_DELTA_PIXELS,
    Math.max(-MAX_WHEEL_DELTA_PIXELS, pixelDelta),
  );
}

export function nextStageZoom(
  currentZoom: number,
  deltaY: number,
  deltaMode = 0,
  viewportHeight = 800,
) {
  const current = clampStageZoom(currentZoom);
  const delta = normalizeWheelDelta(deltaY, deltaMode, viewportHeight);
  return clampStageZoom(current * Math.exp(-delta * WHEEL_ZOOM_SENSITIVITY));
}

export function stepStageZoom(currentZoom: number, direction: -1 | 1) {
  return clampStageZoom(
    clampStageZoom(currentZoom) *
      Math.pow(STAGE_ZOOM_BUTTON_FACTOR, direction),
  );
}
