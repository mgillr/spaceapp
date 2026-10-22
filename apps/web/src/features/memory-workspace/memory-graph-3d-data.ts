import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { createMemoryAtlas } from "./memory-atlas.js";
import { MEMORY_NODE_OTHER, MEMORY_NODE_ROOT, MEMORY_NODE_SOURCE } from "./memory-3d.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";

/** The Canvas 2D fallback keeps the current caps. */
export const MEMORY_3D_FALLBACK_NODES = 2000;
export const MEMORY_3D_FALLBACK_EDGES = 6000;
export const MEMORY_3D_FALLBACK_COLOR = "#7395ad";

/**
 * The 3D view's graph as flat arrays, built in the worker. Node order is the layout order (sorted
 * by id), so streamed positions line up with these arrays without a lookup.
 */
export interface MemoryGraph3DData {
  count: number;
  ids: string[];
  labels: string[];
  /** MEMORY_NODE_ROOT, MEMORY_NODE_SOURCE or MEMORY_NODE_OTHER per node. */
  kinds: Uint8Array;
  /** 1 when the label is a core memory file (gold label, labelled first). */
  core: Uint8Array;
  /** RGBA per node, the atlas group colour. */
  colors: Uint8Array;
  /** Hex colour per node, for the Canvas 2D fallback. */
  colorNames: string[];
  edgeCount: number;
  /** Two node indices per edge. */
  edgeNodes: Uint32Array;
  /** 1 for DERIVED_FROM, else 0. */
  edgeKinds: Uint8Array;
  /** CSR adjacency: neighbours of i are adjacency[adjacencyStart[i] .. adjacencyStart[i + 1]). */
  adjacencyStart: Uint32Array;
  adjacency: Uint32Array;
  /** Nodes whose labels are always candidates: core files first, then other files. */
  labelPriority: Uint32Array;
  /** The capped subset the Canvas 2D fallback draws. */
  fallbackNodes: Uint32Array;
  fallbackEdges: Uint32Array;
}

const compareIds = new Intl.Collator().compare;

export function hexToRgba(color: string, out: Uint8Array, offset: number) {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  const value = match ? Number.parseInt(match[1]!, 16) : 0x7395ad;
  out[offset] = value >> 16 & 255; out[offset + 1] = value >> 8 & 255; out[offset + 2] = value & 255; out[offset + 3] = 255;
}

/** Applies the atlas rules (visible node types, real taxonomy colours) and flattens the result. */
export function buildMemoryGraph3DData(rawNodes: MemoryGraphNode[], rawEdges: MemoryGraphEdge[]): { data: MemoryGraph3DData; nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] } {
  const atlas = createMemoryAtlas(rawNodes, rawEdges, false);
  const nodes = [...atlas.nodes].sort((a, b) => compareIds(a.id, b.id));
  const count = nodes.length;
  const index = new Map<string, number>();
  nodes.forEach((node, i) => index.set(node.id, i));
  const kinds = new Uint8Array(count), core = new Uint8Array(count), colors = new Uint8Array(count * 4);
  const colorNames: string[] = new Array(count);
  const labels: string[] = new Array(count);
  nodes.forEach((node, i) => {
    const isCore = isMemoryCoreLabel(node.label);
    kinds[i] = node.type === "SOURCE" ? (isCore ? MEMORY_NODE_ROOT : MEMORY_NODE_SOURCE) : MEMORY_NODE_OTHER;
    core[i] = isCore ? 1 : 0;
    colorNames[i] = atlas.positions.get(node.id)?.color ?? MEMORY_3D_FALLBACK_COLOR;
    hexToRgba(colorNames[i]!, colors, i * 4);
    labels[i] = node.label;
  });
  const pairs: number[] = [];
  const edgeKindList: number[] = [];
  const edges: MemoryGraphEdge[] = [];
  const degree = new Uint32Array(count + 1);
  for (const edge of atlas.edges) {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (a === undefined || b === undefined) continue;
    pairs.push(a, b); edgeKindList.push(edge.type === "DERIVED_FROM" ? 1 : 0); edges.push(edge);
    degree[a + 1]!++; degree[b + 1]!++;
  }
  const edgeCount = edgeKindList.length;
  const adjacencyStart = new Uint32Array(count + 1);
  for (let i = 0; i < count; i++) adjacencyStart[i + 1] = adjacencyStart[i]! + degree[i + 1]!;
  const adjacency = new Uint32Array(adjacencyStart[count]!);
  const fill = adjacencyStart.slice(0, count);
  for (let e = 0; e < edgeCount; e++) {
    const a = pairs[e * 2]!, b = pairs[e * 2 + 1]!;
    adjacency[fill[a]!++] = b; adjacency[fill[b]!++] = a;
  }
  const priority: number[] = [];
  for (let i = 0; i < count; i++) if (core[i]) priority.push(i);
  for (let i = 0; i < count; i++) if (!core[i] && kinds[i] !== MEMORY_NODE_OTHER) priority.push(i);
  // Fallback subset: files and topics first (the taxonomy that explains the map), then records.
  const fallback: number[] = [];
  const taken = new Uint8Array(count);
  const take = (i: number) => { if (!taken[i] && fallback.length < MEMORY_3D_FALLBACK_NODES) { taken[i] = 1; fallback.push(i); } };
  for (const i of priority) take(i);
  for (let i = 0; i < count; i++) if (nodes[i]!.type === "TOPIC") take(i);
  for (let i = 0; i < count && fallback.length < MEMORY_3D_FALLBACK_NODES; i++) take(i);
  const structural: number[] = [], other: number[] = [];
  for (let e = 0; e < edgeCount; e++) {
    if (!taken[pairs[e * 2]!] || !taken[pairs[e * 2 + 1]!]) continue;
    (edges[e]!.type === "CONTAINS" || edges[e]!.type === "DERIVED_FROM" ? structural : other).push(e);
  }
  const fallbackEdges = Uint32Array.from([...structural, ...other].slice(0, MEMORY_3D_FALLBACK_EDGES));
  return {
    nodes, edges,
    data: {
      count, ids: nodes.map(node => node.id), labels, kinds, core, colors, colorNames,
      edgeCount, edgeNodes: Uint32Array.from(pairs), edgeKinds: Uint8Array.from(edgeKindList),
      adjacencyStart, adjacency, labelPriority: Uint32Array.from(priority),
      fallbackNodes: Uint32Array.from(fallback), fallbackEdges
    }
  };
}

/** Neighbour-highlight state per node: 0 normal, 1 neighbour of the focus, 2 the focus. */
export function memoryFocusState(data: Pick<MemoryGraph3DData, "count" | "adjacencyStart" | "adjacency">, focus: number, out = new Uint8Array(data.count)) {
  out.fill(0);
  if (focus < 0 || focus >= data.count) return out;
  for (let k = data.adjacencyStart[focus]!; k < data.adjacencyStart[focus + 1]!; k++) out[data.adjacency[k]!] = 1;
  out[focus] = 2;
  return out;
}
