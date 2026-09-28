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

/** Keep fractional display time; resetting to `now` halves 60fps on 75/90Hz displays. */
export class TrackingRenderClock {
  private nextAt = -Infinity;
  private lastAt: number | null = null;
  reset() { this.nextAt = -Infinity; this.lastAt = null; }
  step(now: number, fps = 60): number | null {
    if (now + 0.5 < this.nextAt) return null;
    const interval = 1000 / fps;
    const delta = this.lastAt === null ? 1 / fps : Math.min(0.1, Math.max(0, (now - this.lastAt) / 1000));
    this.lastAt = now;
    this.nextAt = !Number.isFinite(this.nextAt) || now - this.nextAt > interval * 2
      ? now + interval : this.nextAt + interval;
    return delta;
  }
}

/** Spread slower camera results over display frames without delaying fast blinks. */
export class TrackingCadence {
  intervalMs = 1000 / 30;
  private lastAt = 0;
  reset() { this.intervalMs = 1000 / 30; this.lastAt = 0; }
  observe(now: number) {
    const gap = now - this.lastAt;
    if (this.lastAt && gap > 0 && gap < 180) this.intervalMs += (gap - this.intervalMs) * 0.25;
    this.lastAt = now;
  }
  response() {
    const timeConstant = Math.min(70, Math.max(28, this.intervalMs * 0.85));
    return 1 - Math.exp(-(1000 / 30) / timeConstant);
  }
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
