import type { MemoryGraphEdge, MemoryGraphNode, MemoryGraphOverviewPayload } from "@space/contracts";
import { memory3DVolumeRatioPacked, memoryGraphExtent } from "./memory-3d.js";
import { createMemoryLayout3D } from "./memory-3d-layout.js";
import { buildMemoryGraph3DData, type MemoryGraph3DData } from "./memory-graph-3d-data.js";
import { createSyntheticMemoryGraph } from "./memory-graph-synthetic.js";

/** Where the worker gets the graph: the overview already on the page, the server, or the demo generator. */
export type MemoryGraph3DSource =
  | { kind: "inline"; nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[]; totalNodes?: number; totalEdges?: number; truncated?: boolean }
  | { kind: "http"; url: string }
  | { kind: "demo"; nodes: number; q?: string };

export type MemoryGraph3DRequest = { type: "graph3d"; id: number; source: MemoryGraph3DSource; sliceMs?: number };
export type MemoryGraph3DTotals = { totalNodes: number; totalEdges: number; truncated: boolean };
export type MemoryGraph3DMessage =
  | { type: "graph3d:graph"; id: number; data: MemoryGraph3DData; totals: MemoryGraph3DTotals }
  | { type: "graph3d:positions"; id: number; positions: Float32Array; step: number; totalSteps: number; done: boolean; extent: number; volume: number }
  | { type: "graph3d:error"; id: number; message: string };

/** Minimum time between two streamed position updates while the layout converges. */
export const MEMORY_3D_STREAM_INTERVAL_MS = 50;

async function loadGraph(source: MemoryGraph3DSource, fetchOverview: (url: string) => Promise<MemoryGraphOverviewPayload>) {
  if (source.kind === "inline") return { nodes: source.nodes, edges: source.edges, totals: { totalNodes: source.totalNodes ?? source.nodes.length, totalEdges: source.totalEdges ?? source.edges.length, truncated: source.truncated ?? false } };
  if (source.kind === "demo") {
    const graph = createSyntheticMemoryGraph(source.nodes);
    const needle = source.q?.trim().toLowerCase();
    if (!needle) return { nodes: graph.nodes, edges: graph.edges, totals: { totalNodes: graph.totalNodes, totalEdges: graph.totalEdges, truncated: false } };
    const nodes = graph.nodes.filter(node => node.label.toLowerCase().includes(needle));
    const ids = new Set(nodes.map(node => node.id));
    const edges = graph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target));
    return { nodes, edges, totals: { totalNodes: nodes.length, totalEdges: edges.length, truncated: false } };
  }
  const payload = await fetchOverview(source.url);
  return { nodes: payload.nodes, edges: payload.edges, totals: { totalNodes: payload.totalMatchingNodes, totalEdges: payload.totalMatchingEdges, truncated: payload.truncated } };
}

/**
 * Loads, parses and lays out the 3D graph off the main thread. The flattened graph is posted once,
 * then positions stream every `MEMORY_3D_STREAM_INTERVAL_MS` while the simulation converges, so
 * the view is drawn and usable from the first update.
 */
export async function runMemoryGraph3DJob(request: MemoryGraph3DRequest, io: {
  post: (message: MemoryGraph3DMessage, transfer?: Transferable[]) => void;
  fetchOverview: (url: string) => Promise<MemoryGraphOverviewPayload>;
  now: () => number;
  yieldToEvents: () => Promise<void>;
}) {
  try {
    const { nodes, edges, totals } = await loadGraph(request.source, io.fetchOverview);
    const built = buildMemoryGraph3DData(nodes, edges);
    const { data } = built;
    io.post({ type: "graph3d:graph", id: request.id, data, totals }, [data.kinds, data.core, data.colors, data.edgeNodes, data.edgeKinds, data.adjacencyStart, data.adjacency, data.labelPriority, data.fallbackNodes, data.fallbackEdges].map(array => array.buffer));
    const layout = createMemoryLayout3D(built.nodes, built.edges);
    const interval = request.sliceMs ?? MEMORY_3D_STREAM_INTERVAL_MS;
    const send = () => {
      const positions = new Float32Array(data.count * 4);
      for (let i = 0; i < data.count; i++) {
        positions[i * 4] = layout.positions[i * 3]!; positions[i * 4 + 1] = layout.positions[i * 3 + 1]!; positions[i * 4 + 2] = layout.positions[i * 3 + 2]!; positions[i * 4 + 3] = 1;
      }
      io.post({
        type: "graph3d:positions", id: request.id, positions, step: layout.step, totalSteps: layout.totalSteps, done: layout.done,
        extent: memoryGraphExtent(layout.positions, data.count), volume: memory3DVolumeRatioPacked(layout.positions, data.count)
      }, [positions.buffer]);
    };
    send();
    while (!layout.done) {
      const started = io.now();
      while (!layout.done && io.now() - started < interval) layout.advance(1);
      send();
      await io.yieldToEvents();
    }
  } catch (error) {
    io.post({ type: "graph3d:error", id: request.id, message: error instanceof Error ? error.message : "Memory graph could not be loaded." });
  }
}
