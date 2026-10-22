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

/**
 * World-space grid over the layout positions, for hover and click. It is rebuilt only when the
 * positions (or the set of pickable nodes) change, not when the camera moves, so a pick while the
 * graph rotates does not project every node. A pick walks the cells along the pointer's ray through
 * the camera and tests only the nodes in them, with the same projection, hit radius and frontmost
 * rule as `MemoryPickIndex`, so both return the same node.
 */
export class MemoryRayPickIndex {
  private positions: ArrayLike<number> = new Float32Array(0);
  private stride = 4;
  private members = new Int32Array(0);
  private cellOf = new Int32Array(0);
  private cellStart = new Int32Array(1);
  private stamp = new Uint32Array(0);
  private epoch = 0;
  private nx = 1; private ny = 1; private nz = 1;
  private cell = 1;
  private minX = 0; private minY = 0; private minZ = 0;
  /** Largest distance of any indexed node from the origin: the depth range a ray has to cover. */
  private bound = 0;
  private total = 0;
  /** Nodes and cells examined by the last `pick`, for tests. */
  lastCandidates = 0;
  lastCells = 0;

  /** Bins nodes 0..count-1 (or only `subset`) into cubic cells, about one node per cell. */
  rebuild(positions: ArrayLike<number>, stride: number, count: number, subset: ArrayLike<number> | null = null) {
    this.positions = positions; this.stride = stride;
    const total = subset ? subset.length : count;
    this.total = total;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity, bound = 0;
    for (let k = 0; k < total; k++) {
      const i = subset ? subset[k]! : k, o = i * stride;
      const x = positions[o]!, y = positions[o + 1]!, z = positions[o + 2]!;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      const r = Math.hypot(x, y, z); if (r > bound) bound = r;
    }
    if (!total) { this.nx = this.ny = this.nz = 1; this.cellStart = new Int32Array(2); this.bound = 0; return; }
    const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-3);
    const perAxis = Math.max(1, Math.min(64, Math.ceil(Math.cbrt(total))));
    const cell = span / perAxis;
    this.cell = cell; this.minX = minX; this.minY = minY; this.minZ = minZ; this.bound = bound;
    this.nx = Math.max(1, Math.ceil((maxX - minX) / cell)); this.ny = Math.max(1, Math.ceil((maxY - minY) / cell)); this.nz = Math.max(1, Math.ceil((maxZ - minZ) / cell));
    const cells = this.nx * this.ny * this.nz;
    if (this.cellStart.length < cells + 1) this.cellStart = new Int32Array(cells + 1);
    if (this.stamp.length < cells) { this.stamp = new Uint32Array(cells); this.epoch = 0; }
    if (this.cellOf.length < count) this.cellOf = new Int32Array(count);
    if (this.members.length < total) this.members = new Int32Array(total);
    const cellStart = this.cellStart, cellOf = this.cellOf;
    cellStart.fill(0, 0, cells + 1);
    for (let k = 0; k < total; k++) {
      const i = subset ? subset[k]! : k, o = i * stride;
      const c = this.cellIndex(positions[o]!, positions[o + 1]!, positions[o + 2]!);
      cellOf[i] = c; cellStart[c + 1]!++;
    }
    for (let c = 0; c < cells; c++) cellStart[c + 1]! += cellStart[c]!;
    const fill = cellStart.slice(0, cells);
    for (let k = 0; k < total; k++) { const i = subset ? subset[k]! : k; this.members[fill[cellOf[i]!]!++] = i; }
  }

  private cellIndex(x: number, y: number, z: number) {
    const cx = Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.minX) / this.cell)));
    const cy = Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.minY) / this.cell)));
    const cz = Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.minZ) / this.cell)));
    return (cz * this.ny + cy) * this.nx + cx;
  }

  /** Index of the frontmost node under (x, y) for this camera, or -1. */
  pick(view: MemoryProjection, kinds: Uint8Array, x: number, y: number, focus = -1): number {
    this.lastCandidates = 0; this.lastCells = 0;
    if (!this.total) return -1;
    const { scale, zoom, width, height, cosYaw, sinYaw, cosPitch, sinPitch } = view;
    // Camera-space point under the pointer at depth z: x' = dx / (scale * zoom * perspective(z)).
    const dx = x - width / 2, dy = height / 2 - y;
    const unit = 1 / (scale * zoom), rootZoom = Math.sqrt(zoom);
    const inverse = (z: number) => Math.max(120, 650 + z * scale) / 650;
    // Largest hit radius at depth z (any kind, focused), as a distance in layout units around the ray.
    // It grows with z, so the far end of a step bounds the whole step.
    const reachAt = (z: number) => { const inv = inverse(z); return Math.max(7, Math.max(1, 10 * rootZoom / inv) * 1.5 + 3) * inv * unit; };
    // Step along the ray so consecutive samples are at most one cell apart in layout units.
    const slope = Math.hypot(dx, dy) / (650 * zoom);
    const step = this.cell / Math.sqrt(1 + slope * slope);
    const epoch = ++this.epoch;
    if (epoch === 0xffffffff) { this.stamp.fill(0); this.epoch = 1; }
    const stamp = this.stamp, cellStart = this.cellStart, members = this.members, positions = this.positions, stride = this.stride;
    const point = { x: 0, y: 0, z: 0, perspective: 1 };
    let best = -1, bestZ = Infinity, candidates = 0, cellsVisited = 0;
    const steps = Math.ceil(2 * this.bound / step);
    for (let s = 0; s <= steps; s++) {
      const z = -this.bound + s * step, inv = inverse(z);
      const cx = dx * inv * unit, cy = dy * inv * unit;
      // Back to layout coordinates (the inverse of the camera rotation).
      const py = cy * cosPitch + z * sinPitch, depth = -cy * sinPitch + z * cosPitch;
      const px = cx * cosYaw - depth * sinYaw, pz = cx * sinYaw + depth * cosYaw;
      const reach = reachAt(z + step / 2) + this.cell / 2;
      const x0 = Math.floor((px - reach - this.minX) / this.cell), x1 = Math.floor((px + reach - this.minX) / this.cell);
      const y0 = Math.floor((py - reach - this.minY) / this.cell), y1 = Math.floor((py + reach - this.minY) / this.cell);
      const z0 = Math.floor((pz - reach - this.minZ) / this.cell), z1 = Math.floor((pz + reach - this.minZ) / this.cell);
      if (x1 < 0 || y1 < 0 || z1 < 0 || x0 >= this.nx || y0 >= this.ny || z0 >= this.nz) continue;
      for (let gz = Math.max(0, z0), ez = Math.min(this.nz - 1, z1); gz <= ez; gz++) for (let gy = Math.max(0, y0), ey = Math.min(this.ny - 1, y1); gy <= ey; gy++) for (let gx = Math.max(0, x0), ex = Math.min(this.nx - 1, x1); gx <= ex; gx++) {
        const c = (gz * this.ny + gy) * this.nx + gx;
        if (stamp[c] === epoch) continue;
        stamp[c] = epoch; cellsVisited++;
        for (let k = cellStart[c]!, end = cellStart[c + 1]!; k < end; k++) {
          const i = members[k]!, o = i * stride;
          candidates++;
          projectMemoryPointInto(view, positions[o]!, positions[o + 1]!, positions[o + 2]!, point);
          const r = hitRadius(memoryNodeRadius(kinds[i]!, point.perspective, view.zoom, i === focus));
          if (point.x < -r || point.y < -r || point.x > width + r || point.y > height + r) continue;
          const ddx = point.x - x, ddy = point.y - y;
          if (ddx * ddx + ddy * ddy < r * r && (point.z < bestZ || (point.z === bestZ && i > best))) { best = i; bestZ = point.z; }
        }
      }
    }
    this.lastCandidates = candidates; this.lastCells = cellsVisited;
    return best;
  }
}
