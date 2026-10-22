import type { MemoryProjection } from "./memory-3d.js";
import type { MemoryGLGraph, MemoryGraphRenderer } from "./memory-3d-webgl.js";

/** Messages from the page to the render worker. */
export type MemoryRenderRequest =
  | { type: "init"; canvas: OffscreenCanvas }
  | { type: "resize"; width: number; height: number }
  | { type: "graph"; graph: MemoryGLGraph }
  | { type: "positions"; positions: Float32Array }
  | { type: "state"; state: Uint8Array }
  | { type: "draw"; seq: number; view: MemoryProjection; dpr: number; extent: number; hasFocus: boolean }
  | { type: "dispose" };

/** Messages from the render worker to the page. `drawn` names the last draw request it has drawn. */
export type MemoryRenderEvent =
  | { type: "ready"; ok: boolean; gpu: string | null }
  | { type: "drawn"; seq: number }
  | { type: "lost" }
  | { type: "restored"; ok: boolean };

type Draw = Extract<MemoryRenderRequest, { type: "draw" }>;

/**
 * The render worker's message handler, kept free of worker globals so it can be tested. It owns
 * the OffscreenCanvas and its WebGL2 renderer, draws at most once per animation frame (only the
 * newest draw request counts) and restores the context itself after a loss.
 */
export function createMemoryRenderHost(io: {
  post: (event: MemoryRenderEvent) => void;
  requestFrame: (callback: () => void) => void;
  create: (canvas: OffscreenCanvas) => MemoryGraphRenderer | null;
}) {
  let canvas: OffscreenCanvas | null = null;
  let renderer: MemoryGraphRenderer | null = null;
  let pending: Draw | null = null, last: Draw | null = null, scheduled = false;
  const frame = () => {
    scheduled = false;
    const request = pending;
    pending = null;
    if (!request) return;
    last = request;
    if (renderer && !renderer.lost) {
      try { renderer.draw(request.view, request.dpr, request.extent, request.hasFocus); } catch { /* a lost context reports itself through the events below */ }
    }
    io.post({ type: "drawn", seq: request.seq });
  };
  const schedule = (request: Draw) => {
    pending = request;
    if (!scheduled) { scheduled = true; io.requestFrame(frame); }
  };
  const lost = (event: Event) => { event.preventDefault(); io.post({ type: "lost" }); };
  const restored = () => {
    let ok = true;
    try { renderer?.restore(); } catch { ok = false; renderer = null; }
    io.post({ type: "restored", ok });
    if (ok && last) schedule(last);
  };
  return (message: MemoryRenderRequest) => {
    switch (message.type) {
      case "init":
        canvas = message.canvas;
        renderer = io.create(canvas);
        if (renderer) {
          canvas.addEventListener("webglcontextlost", lost);
          canvas.addEventListener("webglcontextrestored", restored);
        }
        io.post({ type: "ready", ok: Boolean(renderer), gpu: renderer?.gpu() ?? null });
        return;
      case "resize": renderer?.resize(message.width, message.height); return;
      case "graph": if (renderer && !renderer.lost) renderer.setGraph(message.graph); return;
      case "positions": if (renderer && !renderer.lost) renderer.setPositions(message.positions); return;
      case "state": if (renderer && !renderer.lost) renderer.setState(message.state); return;
      case "draw": schedule(message); return;
      case "dispose":
        canvas?.removeEventListener("webglcontextlost", lost);
        canvas?.removeEventListener("webglcontextrestored", restored);
        renderer?.dispose(); renderer = null; pending = null;
        return;
    }
  };
}
