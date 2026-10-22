import type { MemoryProjection } from "./memory-3d.js";
import type { MemoryRenderEvent, MemoryRenderRequest } from "./memory-3d-render-host.js";
import { memoryGLGraph, type MemoryGLGraph, type MemoryGraphRenderer } from "./memory-3d-webgl.js";

type RenderWorker = Pick<Worker, "postMessage" | "terminate"> & { onmessage: ((event: MessageEvent<MemoryRenderEvent>) => void) | null; onerror: ((event: ErrorEvent) => void) | null };

/**
 * Whether this browser can hand a canvas to a worker (OffscreenCanvas with transferControlToOffscreen)
 * and the page itself may use WebGL2. Some browsers still give a worker WebGL when it is turned off
 * for pages, so the page's own answer decides, and the throwaway context is released at once.
 */
export const canRenderInWorker = (canvas: HTMLCanvasElement) => {
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined" || typeof canvas.transferControlToOffscreen !== "function") return false;
  try {
    const probe = canvas.ownerDocument.createElement("canvas").getContext("webgl2");
    if (!probe) return false;
    probe.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch { return false; }
};

/**
 * The WebGL2 renderer running in `memory-3d-render.worker.ts`. The page keeps the camera, picking,
 * labels and the Canvas 2D fallback; the worker owns the canvas and does the GPU work. `lost` is
 * true until the worker has a context, after a context loss and if the worker has no WebGL2.
 */
export class MemoryGraphGLWorker implements MemoryGraphRenderer {
  lost = true;
  private gpuName: string | null = null;
  private seq = 0;
  private waiters: Array<{ seq: number; resolve: () => void }> = [];
  private disposed = false;

  static create(canvas: HTMLCanvasElement, events: { ready: (ok: boolean) => void; lost: () => void; restored: (ok: boolean) => void },
    createWorker: () => RenderWorker = () => new Worker(new URL("./memory-3d-render.worker.ts", import.meta.url), { type: "module" }) as RenderWorker): MemoryGraphGLWorker | null {
    if (!canRenderInWorker(canvas)) return null;
    let worker: RenderWorker;
    try { worker = createWorker(); } catch { return null; }
    let offscreen: OffscreenCanvas;
    try { offscreen = canvas.transferControlToOffscreen(); } catch { worker.terminate(); return null; }
    return new MemoryGraphGLWorker(worker, offscreen, events);
  }

  private constructor(private readonly worker: RenderWorker, offscreen: OffscreenCanvas, events: { ready: (ok: boolean) => void; lost: () => void; restored: (ok: boolean) => void }) {
    worker.onmessage = (event: MessageEvent<MemoryRenderEvent>) => {
      const message = event.data;
      if (message.type === "ready") { this.lost = !message.ok; this.gpuName = message.gpu; events.ready(message.ok); }
      else if (message.type === "drawn") this.settle(message.seq);
      else if (message.type === "lost") { this.lost = true; this.settle(this.seq); events.lost(); }
      else { this.lost = !message.ok; events.restored(message.ok); }
    };
    worker.onerror = () => { this.lost = true; this.settle(this.seq); events.ready(false); };
    this.post({ type: "init", canvas: offscreen }, [offscreen]);
  }

  private post(message: MemoryRenderRequest, transfer: Transferable[] = []) { if (!this.disposed) this.worker.postMessage(message, transfer); }
  private settle(seq: number) {
    const done = this.waiters.filter(waiter => waiter.seq <= seq);
    this.waiters = this.waiters.filter(waiter => waiter.seq > seq);
    for (const waiter of done) waiter.resolve();
  }

  setGraph(graph: MemoryGLGraph) { this.post({ type: "graph", graph: memoryGLGraph(graph) }); }
  setPositions(positions: Float32Array) { this.post({ type: "positions", positions }); }
  setState(state: Uint8Array) { this.post({ type: "state", state }); }
  draw(view: MemoryProjection, dpr: number, extent: number, hasFocus: boolean) { this.post({ type: "draw", seq: ++this.seq, view, dpr, extent, hasFocus }); }
  resize(width: number, height: number) { this.post({ type: "resize", width, height }); }
  /** The worker restores the context itself and reports it; nothing to do here. */
  restore() {}
  gpu() { return this.gpuName; }

  /** Resolves when the worker has drawn the latest draw request (or cannot draw it). */
  drawn(): Promise<void> {
    if (this.lost || this.disposed) return Promise.resolve();
    const seq = this.seq;
    return new Promise(resolve => this.waiters.push({ seq, resolve }));
  }

  dispose() {
    this.post({ type: "dispose" });
    this.disposed = true;
    this.settle(Number.MAX_SAFE_INTEGER);
    this.worker.terminate();
  }
}
