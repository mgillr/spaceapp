import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_MEMORY_CAMERA, MEMORY_NODE_ROOT, memoryGraphScale, memoryNodeRadius, memoryProjection, projectMemoryPointInto, type MemoryCamera3D, type MemoryProjection } from "./memory-3d.js";
import { MEMORY_3D_BENCH_PARAM, observeLongTasks, runMemory3DBench, type Memory3DBenchResult } from "./memory-3d-bench.js";
import { MEMORY_3D_LABEL_CANDIDATES, MEMORY_3D_RECORD_LABEL_ZOOM, selectMemoryLabels } from "./memory-3d-labels.js";
import { MemoryPickIndex, MemoryRayPickIndex } from "./memory-3d-picking.js";
import { canRenderInWorker, MemoryGraphGLWorker } from "./memory-3d-render-client.js";
import { MemoryGraphGL, type MemoryGraphRenderer } from "./memory-3d-webgl.js";
import { memoryFocusState, type MemoryGraph3DData } from "./memory-graph-3d-data.js";
import type { MemoryGraph3DMessage, MemoryGraph3DSource, MemoryGraph3DTotals } from "./memory-graph-3d-job.js";

type Renderer = "webgl2" | "canvas2d";
/** Labels for records far from the camera wait until the camera has been still this long. */
const SETTLE_MS = 150;

export function MemoryGraph3D({ source, showTitles, selectedNodeId, onSelectNode, loading, resetToken, spin = 0 }: {
  /** Graph to show; the worker loads and lays it out. Null while the overview is loading. */
  source: MemoryGraph3DSource | null;
  showTitles: boolean; selectedNodeId: string | null; onSelectNode: (id: string) => void;
  loading: boolean; resetToken: number;
  /** Extra turn about the vertical axis, for the animated feature showcase. */
  spin?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });
  const redrawRef = useRef<() => void>(() => {});
  const benchRef = useRef<{ start: (loadStartedAt: number) => void } | null>(null);
  const [graph, setGraph] = useState<{ data: MemoryGraph3DData; totals: MemoryGraph3DTotals; index: Map<string, number> } | null>(null);
  const [layout, setLayout] = useState<{ positions: Float32Array; extent: number; volume: number; step: number; totalSteps: number; done: boolean } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [renderer, setRenderer] = useState<Renderer>("webgl2");
  const [bench, setBench] = useState<Memory3DBenchResult | null>(null);
  const current = useRef({ graph, layout, showTitles, selectedNodeId, onSelectNode, spin });
  current.current = { graph, layout, showTitles, selectedNodeId, onSelectNode, spin };
  const benchRequested = useMemo(() => typeof location !== "undefined" && new URLSearchParams(location.search).get(MEMORY_3D_BENCH_PARAM) === "1", []);
  const longTasks = useMemo(() => benchRequested ? observeLongTasks() : null, [benchRequested]);
  const loadStartedAt = useRef(0);
  useEffect(() => () => longTasks?.stop(), [longTasks]);

  // Load and lay out in the existing layout worker; positions stream in until the layout converges.
  useEffect(() => {
    setGraph(null); setLayout(null); setFailure(null);
    if (!source || typeof Worker === "undefined") return;
    const worker = new Worker(new URL("./memory-network-layout.worker.ts", import.meta.url), { type: "module" });
    const id = Date.now();
    loadStartedAt.current = performance.now();
    worker.onmessage = (event: MessageEvent<MemoryGraph3DMessage>) => {
      const message = event.data;
      if (message.id !== id) return;
      if (message.type === "graph3d:graph") setGraph({ data: message.data, totals: message.totals, index: new Map(message.data.ids.map((nodeId, i) => [nodeId, i])) });
      else if (message.type === "graph3d:positions") {
        setLayout({ positions: message.positions, extent: message.extent, volume: message.volume, step: message.step, totalSteps: message.totalSteps, done: message.done });
        if (message.done) worker.terminate();
      } else { setFailure(message.message); worker.terminate(); }
    };
    worker.onerror = event => { setFailure(`Memory layout could not be calculated: ${event.message || "worker unavailable"}`); worker.terminate(); };
    worker.postMessage({ type: "graph3d", id, source });
    return () => worker.terminate();
  }, [source]);

  useEffect(() => {
    cameraRef.current = { ...DEFAULT_MEMORY_CAMERA };
    redrawRef.current();
  }, [resetToken]);

  useEffect(() => {
    const canvas = canvasRef.current, overlay = overlayRef.current;
    if (!canvas || !overlay) return;
    let context: CanvasRenderingContext2D | null = null;
    try { context = overlay.getContext("2d"); } catch { context = null; }
    // Where the browser allows it, the canvas goes to a render worker, so the main thread never
    // waits for the GPU; otherwise WebGL2 runs here, and without either the view uses Canvas 2D.
    const switchTo = (next: Renderer) => { mode = next; uploaded = { graph: null, positions: null }; setRenderer(mode); pickDirty = true; schedule(); };
    // The worker gets its own canvas under the interactive one (a canvas can be transferred only
    // once, and the interactive canvas keeps focus, input and its attributes).
    let surface: HTMLCanvasElement | null = canRenderInWorker(canvas) ? document.createElement("canvas") : null;
    if (surface) { surface.className = "memory-3d-gpu"; surface.setAttribute("aria-hidden", "true"); canvas.before(surface); }
    const offThread = !surface ? null : MemoryGraphGLWorker.create(surface, {
      ready: ok => switchTo(ok ? "webgl2" : "canvas2d"),
      lost: () => switchTo("canvas2d"),
      restored: ok => switchTo(ok ? "webgl2" : "canvas2d")
    });
    if (surface && !offThread) { surface.remove(); surface = null; }
    let gl: MemoryGraphRenderer | null = offThread ?? MemoryGraphGL.create(canvas);
    let mode: Renderer = gl ? "webgl2" : "canvas2d";
    setRenderer(mode);
    let frame = 0, settleTimer = 0, width = 1, height = 1, dpr = 1, movingUntil = 0;
    let hover = -1, focus = -1;
    let uploaded: { graph: MemoryGraph3DData | null; positions: Float32Array | null } = { graph: null, positions: null };
    const state = { array: new Uint8Array(0) };
    // Labels use the screen index (rebuilt when the camera stops); hover and click use the
    // world-space index, which a rotating camera does not invalidate.
    const pickIndex = new MemoryPickIndex();
    let pickDirty = true, nearby: Int32Array | null = null;
    const rayIndex = new MemoryRayPickIndex();
    let rayKey: { data: MemoryGraph3DData | null; positions: Float32Array | null; subset: ArrayLike<number> | null } = { data: null, positions: null, subset: null };
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false, downX = 0, downY = 0;
    const widths = new Map<string, number>();
    let scratch: { data: MemoryGraph3DData | null; sx: Float32Array; sy: Float32Array; sz: Float32Array; sp: Float32Array } = { data: null, sx: new Float32Array(0), sy: new Float32Array(0), sz: new Float32Array(0), sp: new Float32Array(0) };
    const view = (): MemoryProjection => memoryProjection({ ...cameraRef.current, yaw: cameraRef.current.yaw - current.current.spin }, memoryGraphScale(current.current.layout?.extent ?? 60, width, height), width, height);
    const subset = () => mode === "canvas2d" ? current.current.graph?.data.fallbackNodes ?? null : null;
    const ensurePickIndex = () => {
      const { graph, layout } = current.current;
      if (!graph || !layout) return false;
      if (pickDirty) {
        pickIndex.rebuild(layout.positions, 4, graph.data.kinds, graph.data.count, view(), focus, subset());
        pickDirty = false; nearby = null;
      }
      return true;
    };
    const syncData = () => {
      const { graph, layout } = current.current;
      if (graph?.data !== uploaded.graph) {
        uploaded = { graph: graph?.data ?? null, positions: null };
        state.array = new Uint8Array(graph?.data.count ?? 0);
        hover = -1; focus = -2; pickDirty = true;
        if (gl && graph && !gl.lost) gl.setGraph(graph.data);
      }
      if (layout?.positions !== uploaded.positions && layout) {
        uploaded.positions = layout.positions; pickDirty = true;
        if (gl && graph && !gl.lost) gl.setPositions(layout.positions);
      }
      const { selectedNodeId } = current.current;
      const nextFocus = hover >= 0 ? hover : selectedNodeId ? graph?.index.get(selectedNodeId) ?? -1 : -1;
      if (nextFocus !== focus && graph) {
        focus = nextFocus; pickDirty = true;
        memoryFocusState(graph.data, focus, state.array);
        if (gl && !gl.lost) gl.setState(state.array);
      }
    };
    const drawFallback = (ctx: CanvasRenderingContext2D, data: MemoryGraph3DData, positions: Float32Array, projection: MemoryProjection) => {
      // The Canvas 2D renderer, unchanged apart from reading flat arrays: capped nodes, painter's order.
      const nodes = data.fallbackNodes, point = { x: 0, y: 0, z: 0, perspective: 1 };
      if (scratch.data !== data) scratch = { data, sx: new Float32Array(data.count), sy: new Float32Array(data.count), sz: new Float32Array(data.count), sp: new Float32Array(data.count) };
      const { sx, sy, sz, sp } = scratch;
      for (const i of nodes) {
        projectMemoryPointInto(projection, positions[i * 4]!, positions[i * 4 + 1]!, positions[i * 4 + 2]!, point);
        sx[i] = point.x; sy[i] = point.y; sz[i] = point.z; sp[i] = point.perspective;
      }
      for (const e of data.fallbackEdges) {
        const a = data.edgeNodes[e * 2]!, b = data.edgeNodes[e * 2 + 1]!;
        const incident = a === focus || b === focus;
        ctx.strokeStyle = incident ? "#98dafa" : focus >= 0 ? "#14202b" : data.edgeKinds[e] === 1 ? "#385068" : "#203343";
        ctx.lineWidth = incident ? 1.15 : 0.55;
        ctx.beginPath(); ctx.moveTo(sx[a]!, sy[a]!); ctx.lineTo(sx[b]!, sy[b]!); ctx.stroke();
      }
      const ordered = Array.from(nodes).sort((a, b) => sz[b]! - sz[a]!);
      for (const i of ordered) {
        const highlighted = i === focus;
        const radius = memoryNodeRadius(data.kinds[i]!, sp[i]!, projection.zoom, highlighted);
        ctx.globalAlpha = focus >= 0 && !highlighted && state.array[i] !== 1 ? 0.2 : Math.max(0.4, Math.min(1, sp[i]!));
        ctx.fillStyle = highlighted ? "#ffffff" : data.colorNames[i]!;
        if (data.kinds[i] === MEMORY_NODE_ROOT || highlighted) { ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 13; }
        ctx.beginPath(); ctx.arc(sx[i]!, sy[i]!, radius, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = 1;
    };
    const drawLabels = (ctx: CanvasRenderingContext2D, data: MemoryGraph3DData, positions: Float32Array, projection: MemoryProjection, moving: boolean) => {
      ctx.font = "11px system-ui, sans-serif";
      const fallback = mode === "canvas2d" ? new Set(data.fallbackNodes) : null;
      if (!moving && projection.zoom >= MEMORY_3D_RECORD_LABEL_ZOOM && ensurePickIndex()) nearby ??= pickIndex.frontToBack(MEMORY_3D_LABEL_CANDIDATES);
      const point = { x: 0, y: 0, z: 0, perspective: 1 };
      const priority = fallback ? Array.from(data.labelPriority).filter(i => fallback.has(i)) : data.labelPriority;
      const { labels } = selectMemoryLabels({
        focus, priority, nearby: moving ? null : nearby, kinds: data.kinds, core: data.core, labels: data.labels, zoom: projection.zoom, width, height,
        position: i => projectMemoryPointInto(projection, positions[i * 4]!, positions[i * 4 + 1]!, positions[i * 4 + 2]!, point),
        measure: text => { let w = widths.get(text); if (w === undefined) { w = ctx.measureText(text).width; if (widths.size > 20_000) widths.clear(); widths.set(text, w); } return w; }
      });
      for (const label of labels) {
        ctx.fillStyle = "#09111bea"; ctx.fillRect(label.x - 3, label.y - 11, label.w + 6, 16);
        ctx.fillStyle = label.core ? "#fff0b0" : "#c6dfed"; ctx.fillText(label.text, label.x, label.y + 1);
      }
    };
    const render = () => {
      frame = 0;
      syncData();
      const { graph, layout, showTitles } = current.current;
      const projection = view();
      const moving = performance.now() < movingUntil;
      if (mode === "webgl2" && gl && !gl.lost) gl.draw(projection, dpr, layout?.extent ?? 60, focus >= 0);
      if (context) {
        context.clearRect(0, 0, width, height);
        if (graph && layout) {
          if (mode === "canvas2d") drawFallback(context, graph.data, layout.positions, projection);
          if (showTitles) drawLabels(context, graph.data, layout.positions, projection, moving);
        }
      }
      canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
      canvas.dataset.zoom = cameraRef.current.zoom.toFixed(3);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
    const cameraChanged = () => {
      pickDirty = true; movingUntil = performance.now() + SETTLE_MS;
      window.clearTimeout(settleTimer); settleTimer = window.setTimeout(schedule, SETTLE_MS + 10);
      schedule();
    };
    redrawRef.current = () => { pickDirty = true; schedule(); };
    const resize = () => {
      const rect = canvas.getBoundingClientRect(); width = Math.max(1, rect.width); height = Math.max(1, rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      for (const target of [canvas, overlay]) { target.width = Math.round(width * dpr); target.height = Math.round(height * dpr); }
      // The worker's canvas is sized by the worker.
      if (offThread) offThread.resize(Math.round(width * dpr), Math.round(height * dpr));
      context?.setTransform(dpr, 0, 0, dpr, 0, 0);
      pickDirty = true; schedule();
    };
    const hit = (x: number, y: number) => {
      const { graph, layout } = current.current;
      if (!graph || !layout) return -1;
      const nodes = subset();
      if (rayKey.data !== graph.data || rayKey.positions !== layout.positions || rayKey.subset !== nodes) {
        rayIndex.rebuild(layout.positions, 4, graph.data.count, nodes);
        rayKey = { data: graph.data, positions: layout.positions, subset: nodes };
      }
      return rayIndex.pick(view(), graph.data.kinds, x, y, focus);
    };
    const idOf = (i: number) => i >= 0 ? current.current.graph?.data.ids[i] ?? null : null;
    const local = (event: PointerEvent) => { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
    const down = (event: PointerEvent) => {
      canvas.focus(); canvas.setPointerCapture(event.pointerId);
      const p = local(event); pointers.set(event.pointerId, p); downX = p.x; downY = p.y; dragged = false; hover = -1;
    };
    const move = (event: PointerEvent) => {
      const p = local(event), previous = pointers.get(event.pointerId);
      if (previous) {
        if (Math.hypot(p.x - downX, p.y - downY) > 4) dragged = true;
        if (pointers.size > 1) {
          const other = [...pointers].find(([pointerId]) => pointerId !== event.pointerId)![1];
          const before = Math.hypot(previous.x - other.x, previous.y - other.y), after = Math.hypot(p.x - other.x, p.y - other.y);
          if (before > 1) cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * after / before));
        } else { cameraRef.current.yaw += (p.x - previous.x) * 0.009; cameraRef.current.pitch += (p.y - previous.y) * 0.009; }
        pointers.set(event.pointerId, p);
        cameraChanged();
      } else {
        const next = hit(p.x, p.y);
        canvas.style.cursor = next >= 0 ? "pointer" : "grab";
        if (next !== hover) { hover = next; schedule(); }
      }
    };
    const up = (event: PointerEvent) => {
      const p = local(event);
      if (!dragged && pointers.size === 1) { const id = idOf(hit(p.x, p.y)); if (id) current.current.onSelectNode(id); }
      pointers.delete(event.pointerId);
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    const cancel = (event: PointerEvent) => { pointers.delete(event.pointerId); dragged = true; };
    const leave = () => { if (!pointers.size && hover !== -1) { hover = -1; schedule(); } };
    const zoomBy = (factor: number) => { cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * factor)); cameraChanged(); };
    const wheel = (event: WheelEvent) => { event.preventDefault(); zoomBy(Math.exp(-event.deltaY * 0.001)); };
    const key = (event: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault(); cameraRef.current.yaw += event.key === "ArrowLeft" ? -0.15 : event.key === "ArrowRight" ? 0.15 : 0;
        cameraRef.current.pitch += event.key === "ArrowUp" ? -0.15 : event.key === "ArrowDown" ? 0.15 : 0; cameraChanged();
      } else if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomBy(1.15); }
      else if (event.key === "-" || event.key === "_") { event.preventDefault(); zoomBy(1 / 1.15); }
      else if (event.key === "Enter") {
        const { graph, selectedNodeId } = current.current;
        if (!graph) return;
        const selected = selectedNodeId ? graph.index.get(selectedNodeId) : undefined;
        const index = selected ?? graph.data.labelPriority.find(i => graph.data.core[i] === 1) ?? -1;
        const id = idOf(index);
        if (id) current.current.onSelectNode(id);
      }
    };
    // A lost context falls back to Canvas 2D on the overlay; a restored one switches back to WebGL2.
    // (In the render worker the worker sees these events and reports them through `offThread`.)
    const lost = (event: Event) => { event.preventDefault(); switchTo("canvas2d"); };
    const restored = () => {
      try { gl?.restore(); } catch { gl = null; }
      switchTo(gl ? "webgl2" : "canvas2d");
    };
    benchRef.current = {
      start: (since: number) => {
        void runMemory3DBench({
          frame: (yaw, pitch, zoom) => {
            cameraRef.current = { yaw, pitch, zoom }; pickDirty = true; movingUntil = performance.now() + SETTLE_MS; render();
            // Drawn in the worker: the frame counts once the worker has drawn it.
            return offThread && mode === "webgl2" ? offThread.drawn() : undefined;
          },
          pick: (x, y) => { const started = performance.now(); hit(x, y); return performance.now() - started; },
          size: () => ({ width, height }),
          info: () => ({ nodes: current.current.graph?.data.count ?? 0, edges: current.current.graph?.data.edgeCount ?? 0, renderer: mode, renderThread: offThread && mode === "webgl2" ? "worker" : "main" })
        }, longTasks ?? { entries: [] }, { gpu: gl && !gl.lost ? gl.gpu() : null, loadStartedAt: since }).then(result => {
          setBench(result);
          (window as unknown as { __spaceMemory3DBench?: Memory3DBenchResult }).__spaceMemory3DBench = result;
          schedule();
        });
      }
    };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", cancel); canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", key);
    canvas.addEventListener("webglcontextlost", lost); canvas.addEventListener("webglcontextrestored", restored);
    return () => {
      observer.disconnect(); cancelAnimationFrame(frame); window.clearTimeout(settleTimer); redrawRef.current = () => {}; benchRef.current = null;
      canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up); canvas.removeEventListener("pointercancel", cancel); canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("keydown", key);
      canvas.removeEventListener("webglcontextlost", lost); canvas.removeEventListener("webglcontextrestored", restored);
      gl?.dispose(); surface?.remove();
    };
  }, [longTasks]);
  useEffect(() => { redrawRef.current(); }, [graph, layout, showTitles, selectedNodeId, spin]);
  const benchStarted = useRef(false);
  useEffect(() => {
    if (!benchRequested || benchStarted.current || !layout?.done || !graph) return;
    benchStarted.current = true;
    const timer = window.setTimeout(() => benchRef.current?.start(loadStartedAt.current), 500);
    return () => window.clearTimeout(timer);
  }, [benchRequested, layout, graph]);
  const busy = loading || Boolean(source && !failure && !layout?.done);
  return <div className="memory-3d-surface" data-renderer={renderer} data-node-count={graph?.data.count ?? 0} data-edge-count={graph?.data.edgeCount ?? 0} data-layout-step={layout?.step ?? 0} data-layout-done={Boolean(layout?.done)}>
    <canvas ref={canvasRef} tabIndex={0} role="application" aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll, pinch or use plus and minus to zoom. Click a node to open." aria-busy={busy} data-titles-visible={showTitles} data-layout-volume={(layout?.volume ?? 0).toFixed(4)} />
    <canvas ref={overlayRef} className="memory-3d-overlay" aria-hidden="true" />
    <span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span>
    {failure ? <div className="memory-3d-status" role="alert">{failure}</div> : graph?.totals.truncated ? <div className="memory-3d-status" role="status">Showing {graph.data.count.toLocaleString()} of {graph.totals.totalNodes.toLocaleString()} nodes</div> : null}
    {bench ? <output className="memory-3d-bench" data-memory-3d-bench={JSON.stringify(bench)}>{`${bench.renderer} · ${bench.nodes.toLocaleString()} nodes · p95 ${bench.frameMs.p95} ms · pick p95 ${bench.pickMs.p95} ms · long tasks ${bench.longTasks.load + bench.longTasks.interaction} (max ${Math.max(bench.longTasks.loadMaxMs, bench.longTasks.interactionMaxMs)} ms)`}</output> : null}
  </div>;
}
