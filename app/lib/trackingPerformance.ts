/** Small, hysteretic input-size controller. Never queues old camera frames. */
export class TrackingInputBudget {
  reduced = false;
  private slowFrames = 0;
  private fastFrames = 0;

  reset() {
    this.reduced = false;
    this.slowFrames = 0;
    this.fastFrames = 0;
  }

  observe(inferenceMs: number) {
    // Ignore initialization/fallback stalls and invalid timing samples.
    if (!Number.isFinite(inferenceMs) || inferenceMs <= 0 || inferenceMs > 500) return;
    this.slowFrames = inferenceMs > 32.5 ? this.slowFrames + 1 : 0;
    this.fastFrames = inferenceMs < 20 ? this.fastFrames + 1 : 0;
    if (!this.reduced && this.slowFrames >= 8) {
      this.reduced = true;
      this.fastFrames = 0;
    } else if (this.reduced && this.fastFrames >= 90) {
      // Recover detail only after sustained headroom, not every other frame.
      this.reduced = false;
      this.slowFrames = 0;
    }
  }
}

/** Response specified at 30 Hz, independent of the actual display frame rate. */
export function trackingResponse(amount: number, deltaSeconds: number) {
  const delta = Number.isFinite(deltaSeconds) ? Math.min(0.1, Math.max(0, deltaSeconds)) : 1 / 60;
  return 1 - Math.pow(1 - Math.min(1, Math.max(0, amount)), delta * 30);
}

/** Preserve aspect ratio, and never upscale a low-resolution camera feed. */
export function fitTrackingInput(width: number, height: number, maxWidth: number, maxHeight: number) {
  const sourceWidth = Number.isFinite(width) && width > 0 ? width : maxWidth;
  const sourceHeight = Number.isFinite(height) && height > 0 ? height : maxHeight;
  const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}
