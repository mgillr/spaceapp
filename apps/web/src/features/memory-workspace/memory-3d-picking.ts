import { memoryNodeRadius, projectMemoryPointInto, type MemoryProjection } from "./memory-3d.js";

/** Smallest hit radius in CSS pixels, as in the Canvas 2D renderer: max(7, radius + 3). */
const hitRadius = (radius: number) => Math.max(7, radius + 3);

/**
 * Screen-space uniform grid over the projected nodes. `rebuild` is O(n) and runs at most once per
 * camera or layout change; `pick` only visits the cells under the pointer, so hover and click do
 * not scan every node. The frontmost hit wins, as with the painter's order of the 2D renderer.
 */
export class MemoryPickIndex {
  readonly cellSize: number;
  private capacity = 0;
  private sx = new Float32Array(0);
  private sy = new Float32Array(0);
  private sz = new Float32Array(0);
  private hit = new Float32Array(0);
  private members = new Int32Array(0);
  private cellOf = new Int32Array(0);
  private cellStart = new Int32Array(0);
  private columns = 0;
  private rows = 0;
  private maxHit = 7;
  private visible = 0;
  /** Number of nodes examined by the last `pick`, for tests and the frame harness. */
  lastCandidates = 0;

  constructor(cellSize = 24) { this.cellSize = cellSize; }

  /** Projects nodes 0..count-1 (or only `subset`) and bins them into screen cells. */
  rebuild(positions: ArrayLike<number>, stride: number, kinds: Uint8Array, count: number, view: MemoryProjection, focus = -1, subset: ArrayLike<number> | null = null) {
    if (count > this.capacity) {
      this.capacity = count;
      this.sx = new Float32Array(count); this.sy = new Float32Array(count); this.sz = new Float32Array(count);
      this.hit = new Float32Array(count); this.members = new Int32Array(count);
    }
    this.columns = Math.max(1, Math.ceil(view.width / this.cellSize));
    this.rows = Math.max(1, Math.ceil(view.height / this.cellSize));
    const cells = this.columns * this.rows;
    if (this.cellStart.length < cells + 1) this.cellStart = new Int32Array(cells + 1);
    const cellStart = this.cellStart;
    cellStart.fill(0, 0, cells + 1);
    const point = { x: 0, y: 0, z: 0, perspective: 1 };
    if (this.cellOf.length < count) this.cellOf = new Int32Array(count);
    const cellOf = this.cellOf;
    let maxHit = 7, visible = 0;
    const total = subset ? subset.length : count;
    for (let k = 0; k < total; k++) {
      const i = subset ? subset[k]! : k;
      projectMemoryPointInto(view, positions[i * stride]!, positions[i * stride + 1]!, positions[i * stride + 2]!, point);
      const radius = hitRadius(memoryNodeRadius(kinds[i]!, point.perspective, view.zoom, i === focus));
      this.sx[i] = point.x; this.sy[i] = point.y; this.sz[i] = point.z; this.hit[i] = radius;
      const column = Math.floor(point.x / this.cellSize), row = Math.floor(point.y / this.cellSize);
      if (point.x < -radius || point.y < -radius || point.x > view.width + radius || point.y > view.height + radius) { cellOf[i] = -1; continue; }
      const cell = Math.min(this.rows - 1, Math.max(0, row)) * this.columns + Math.min(this.columns - 1, Math.max(0, column));
      cellOf[i] = cell; cellStart[cell + 1]!++; visible++;
      if (radius > maxHit) maxHit = radius;
    }
    for (let c = 0; c < cells; c++) cellStart[c + 1]! += cellStart[c]!;
    const fill = cellStart.slice(0, cells);
    for (let k = 0; k < total; k++) {
      const i = subset ? subset[k]! : k;
      if (cellOf[i]! >= 0) this.members[fill[cellOf[i]!]!++] = i;
    }
    this.maxHit = maxHit; this.visible = visible;
  }

  /** Index of the frontmost node under (x, y), or -1. */
  pick(x: number, y: number): number {
    const reach = this.maxHit;
    const c0 = Math.max(0, Math.floor((x - reach) / this.cellSize)), c1 = Math.min(this.columns - 1, Math.floor((x + reach) / this.cellSize));
    const r0 = Math.max(0, Math.floor((y - reach) / this.cellSize)), r1 = Math.min(this.rows - 1, Math.floor((y + reach) / this.cellSize));
    let best = -1, bestZ = Infinity, candidates = 0;
    for (let row = r0; row <= r1; row++) for (let column = c0; column <= c1; column++) {
      const cell = row * this.columns + column;
      for (let k = this.cellStart[cell]!, end = this.cellStart[cell + 1]!; k < end; k++) {
        const i = this.members[k]!;
        candidates++;
        const dx = this.sx[i]! - x, dy = this.sy[i]! - y, r = this.hit[i]!;
        if (dx * dx + dy * dy < r * r && (this.sz[i]! < bestZ || (this.sz[i] === bestZ && i > best))) { best = i; bestZ = this.sz[i]!; }
      }
    }
    this.lastCandidates = candidates;
    return best;
  }

  /** On-screen nodes from the last rebuild, nearest the camera first, at most `limit`. */
  frontToBack(limit: number): Int32Array {
    const list = this.members.slice(0, this.visible), z = this.sz;
    list.sort((a, b) => z[a]! - z[b]! || a - b);
    return list.subarray(0, limit);
  }

  /** Nodes whose centre is on screen after the last rebuild. */
  get visibleCount() { return this.visible; }
  /** Projected screen position of node `i` from the last rebuild. */
  screen(i: number) { return { x: this.sx[i]!, y: this.sy[i]!, z: this.sz[i]! }; }
}
