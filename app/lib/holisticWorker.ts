/// <reference types="vite/client" />

import HolisticWorker from "../workers/holistic.worker.ts?worker";

/**
 * Create the bundled MediaPipe worker through Vite's worker constructor import.
 *
 * Keeping this behind `?worker` avoids Vinext/Rolldown serializing an
 * `import.meta.url` base as `file:///ROOT/...` in the deployed client chunk.
 */
export function createHolisticTrackingWorker(): Worker {
  return new HolisticWorker({ name: "motion-ink-holistic" });
}

