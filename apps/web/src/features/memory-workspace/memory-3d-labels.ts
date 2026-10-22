import { MEMORY_NODE_OTHER } from "./memory-3d.js";

/** At most this many labels are measured (and so drawn) per frame, whatever the graph size. */
export const MEMORY_3D_LABEL_BUDGET = 160;
/** At most this many label candidates are examined per frame. */
export const MEMORY_3D_LABEL_CANDIDATES = 4000;
/** Record titles appear from this zoom, as before; file titles always. */
export const MEMORY_3D_RECORD_LABEL_ZOOM = 1.6;

export type MemoryLabel = { index: number; text: string; x: number; y: number; w: number; core: boolean };
export type MemoryLabelSelection = { labels: MemoryLabel[]; measured: number; examined: number };

export const memoryLabelText = (label: string) => label.length > 48 ? `${label.slice(0, 45)}…` : label;

/**
 * Picks the labels for one frame with the existing rules: the focused node first, then core files,
 * then other files, then (from zoom 1.6, and only from `nearby`) records; a label is skipped when
 * it would leave the canvas or overlap one already placed. The number of candidates examined and
 * of labels measured is capped, so the cost per frame does not grow with the graph.
 */
export function selectMemoryLabels(input: {
  focus: number;
  priority: ArrayLike<number>;
  /** Record candidates near the camera, front first; only used at record-label zoom. */
  nearby: ArrayLike<number> | null;
  kinds: Uint8Array;
  core: Uint8Array;
  labels: readonly string[];
  zoom: number;
  width: number;
  height: number;
  /** Screen position of node `i`, or null when it is not projected. */
  position: (i: number) => { x: number; y: number } | null;
  measure: (text: string) => number;
  budget?: number;
  candidates?: number;
}): MemoryLabelSelection {
  const budget = input.budget ?? MEMORY_3D_LABEL_BUDGET, maxCandidates = input.candidates ?? MEMORY_3D_LABEL_CANDIDATES;
  const placed: MemoryLabel[] = [];
  const seen = new Set<number>();
  let measured = 0, examined = 0;
  const consider = (i: number) => {
    if (seen.has(i)) return;
    seen.add(i); examined++;
    if (input.kinds[i] === MEMORY_NODE_OTHER && i !== input.focus && input.zoom < MEMORY_3D_RECORD_LABEL_ZOOM) return;
    const p = input.position(i);
    if (!p) return;
    const x = p.x + 9, y = p.y;
    if (y < 14 || y > input.height - 5 || x > input.width) return;
    const text = memoryLabelText(input.labels[i]!);
    const w = input.measure(text); measured++;
    if (x + w > input.width || placed.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + w + 5 > box.x)) return;
    placed.push({ index: i, text, x, y, w, core: input.core[i] === 1 });
  };
  const open = () => measured < budget && examined < maxCandidates;
  if (input.focus >= 0) consider(input.focus);
  for (let k = 0; k < input.priority.length && open(); k++) consider(input.priority[k]!);
  if (input.nearby && input.zoom >= MEMORY_3D_RECORD_LABEL_ZOOM) for (let k = 0; k < input.nearby.length && open(); k++) consider(input.nearby[k]!);
  return { labels: placed, measured, examined };
}
