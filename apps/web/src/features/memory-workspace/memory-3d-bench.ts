/** `?memory3dBench=1` runs the frame-time harness once the 3D layout has converged. */
export const MEMORY_3D_BENCH_PARAM = "memory3dBench";

export type Memory3DBenchController = {
  /** Rotates and zooms the camera, then draws one frame synchronously. */
  frame: (yaw: number, pitch: number, zoom: number) => void;
  /** Hit-tests one point (rebuilding the index when the camera moved); returns elapsed ms. */
  pick: (x: number, y: number) => number;
  size: () => { width: number; height: number };
  info: () => { nodes: number; edges: number; renderer: string };
};

export type Memory3DBenchResult = {
  nodes: number; edges: number; renderer: string; userAgent: string; gpu: string | null;
  frames: number; frameMs: { p50: number; p95: number; max: number };
  /** Main-thread time spent preparing and submitting each frame (camera, pick index, draw calls, labels). */
  frameWorkMs: { p50: number; p95: number; max: number };
  pickMs: { p50: number; p95: number; max: number; samples: number };
  longTasks: { load: number; loadMaxMs: number; interaction: number; interactionMaxMs: number };
};

export const percentile = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))]!;
};
const summary = (values: number[]) => ({ p50: round(percentile(values, 50)), p95: round(percentile(values, 95)), max: round(values.length ? Math.max(...values) : 0) });
const round = (value: number) => Math.round(value * 100) / 100;

/** Collects main-thread long tasks (over 50 ms) from page load, so load and layout are included. */
export function observeLongTasks(): { entries: Array<{ start: number; duration: number }>; stop: () => void } {
  const entries: Array<{ start: number; duration: number }> = [];
  if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes("longtask")) return { entries, stop: () => {} };
  const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) entries.push({ start: entry.startTime, duration: entry.duration }); });
  observer.observe({ type: "longtask", buffered: true });
  return { entries, stop: () => observer.disconnect() };
}

/**
 * Rotates a full turn while zooming between 0.6x and 2.5x for `frames` animation frames, timing
 * each frame (requestAnimationFrame to requestAnimationFrame) and one hover pick per frame.
 */
export async function runMemory3DBench(controller: Memory3DBenchController, longTasks: { entries: Array<{ start: number; duration: number }> }, options: { frames?: number; gpu?: string | null; loadStartedAt?: number } = {}): Promise<Memory3DBenchResult> {
  const frames = options.frames ?? 600;
  const startedAt = performance.now();
  const frameTimes: number[] = [], workTimes: number[] = [], pickTimes: number[] = [];
  let previous = 0;
  await new Promise<void>(resolve => {
    let index = 0;
    const tick = (time: number) => {
      if (previous) frameTimes.push(time - previous);
      previous = time;
      if (index >= frames) { resolve(); return; }
      const t = index / frames;
      const workStarted = performance.now();
      controller.frame(0.3 + t * Math.PI * 2, -0.15 + Math.sin(t * Math.PI * 4) * 0.3, 1.55 + Math.sin(t * Math.PI * 6) * 0.95);
      workTimes.push(performance.now() - workStarted);
      const { width, height } = controller.size();
      pickTimes.push(controller.pick(width * (0.25 + 0.5 * ((index * 37) % 101) / 100), height * (0.25 + 0.5 * ((index * 53) % 97) / 96)));
      index++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const load = longTasks.entries.filter(entry => entry.start >= (options.loadStartedAt ?? 0) && entry.start < startedAt), interaction = longTasks.entries.filter(entry => entry.start >= startedAt);
  const info = controller.info();
  return {
    ...info, userAgent: navigator.userAgent, gpu: options.gpu ?? null, frames: frameTimes.length,
    frameMs: summary(frameTimes), frameWorkMs: summary(workTimes), pickMs: { ...summary(pickTimes), samples: pickTimes.length },
    longTasks: {
      load: load.length, loadMaxMs: round(Math.max(0, ...load.map(entry => entry.duration))),
      interaction: interaction.length, interactionMaxMs: round(Math.max(0, ...interaction.map(entry => entry.duration)))
    }
  };
}
