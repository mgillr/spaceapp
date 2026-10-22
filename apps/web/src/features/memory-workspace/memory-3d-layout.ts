import { isMemoryCoreLabel } from "./memory-graph-visuals.js";

/** Minimal node and edge shapes, so the worker can lay out compact data as well as API payloads. */
export type MemoryLayoutNode = { id: string; type: string; label: string };
export type MemoryLayoutEdge = { id: string; type: string; source: string; target: string };

export const MEMORY_3D_LAYOUT_STEPS = 180;
const BASE_NODE_COUNT = 2000;
const BASE_SPREAD = 260;
const CELL = 32;
/** Repulsion pairs per node and step above 2,000 nodes. */
const MAX_PAIRS = 24;
/** The 27 neighbour cells (index = 9 dx + 3 dy + dz, each 0..2), the node's own cell (13) first. */
const NEAR_FIRST = Int8Array.from([13, ...Array.from({ length: 27 }, (_, c) => c).filter(c => c !== 13)]);
const OFFSET_X = Int8Array.from({ length: 27 }, (_, c) => Math.floor(c / 9) - 1);
const OFFSET_Y = Int8Array.from({ length: 27 }, (_, c) => Math.floor(c / 3) % 3 - 1);
const OFFSET_Z = Int8Array.from({ length: 27 }, (_, c) => c % 3 - 1);

// Avalanche each seed so the three axes are independent even for similar file IDs.
export const memoryLayoutUnit = (seed: string) => {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
};

const compareIds = new Intl.Collator().compare;

export interface MemoryLayout3D {
  /** Node ids in layout order (sorted by id, independent of input order). */
  readonly ids: readonly string[];
  /** Interleaved x, y, z per node, in layout order. */
  readonly positions: Float64Array;
  readonly totalSteps: number;
  readonly step: number;
  readonly done: boolean;
  /** Runs up to `steps` simulation steps; returns true when the layout has converged. */
  advance(steps: number): boolean;
}

/**
 * Independent XYZ force layout that can be advanced a few steps at a time, so the worker can
 * stream positions while it converges. Up to 2,000 nodes it uses the original parameters and
 * produces exactly the original positions. Larger graphs start in a volume scaled with the cube
 * root of the node count, which keeps the density of the 32-unit repulsion grid constant, and cap
 * the repulsion pairs per node, so a step costs O(n) however records cluster around their files.
 */
export function createMemoryLayout3D(nodes: readonly MemoryLayoutNode[], edges: readonly MemoryLayoutEdge[]): MemoryLayout3D {
  const ordered = [...nodes].sort((a, b) => compareIds(a.id, b.id));
  const ids = ordered.map(node => node.id);
  const count = ordered.length;
  const index = new Map<string, number>();
  ordered.forEach((node, i) => index.set(node.id, i));
  const source = new Uint8Array(count);
  ordered.forEach((node, i) => { source[i] = node.type === "SOURCE" ? 1 : 0; });
  const root = ordered.findIndex(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label));
  const spread = BASE_SPREAD * Math.max(1, Math.cbrt(count / BASE_NODE_COUNT));
  const positions = new Float64Array(count * 3);
  ordered.forEach((node, i) => {
    positions[i * 3] = (memoryLayoutUnit(`${node.id}:x`) - 0.5) * spread;
    positions[i * 3 + 1] = (memoryLayoutUnit(`${node.id}:y`) - 0.5) * spread;
    positions[i * 3 + 2] = (memoryLayoutUnit(`${node.id}:z`) - 0.5) * spread;
  });
  if (root >= 0) positions.fill(0, root * 3, root * 3 + 3);
  const sortedEdges = [...edges].sort((a, b) => compareIds(a.id, b.id));
  const linkA: number[] = [], linkB: number[] = [], linkLength: number[] = [], linkStrength: number[] = [];
  for (const edge of sortedEdges) {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (a === undefined || b === undefined || a === b) continue;
    const fileLink = source[a] === 1 && source[b] === 1;
    linkA.push(a); linkB.push(b);
    linkLength.push(fileLink ? 110 : edge.type === "CONTAINS" ? 34 : 55);
    linkStrength.push(fileLink ? 0.035 : edge.type === "CONTAINS" ? 0.028 : 0.004);
  }
  // Initialize records around their actual file, in a volume rather than a plane. Above 2,000
  // nodes the cloud around a file grows with the cube root of its record count, so a file with
  // thousands of records does not start as one dense cell.
  const large = count > BASE_NODE_COUNT;
  const children = new Uint32Array(large ? count : 0);
  if (large) for (const edge of edges) {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (edge.type === "CONTAINS" && a !== undefined && b !== undefined && ordered[a]!.type === "SOURCE" && ordered[b]!.type === "MEMORY") children[a]!++;
  }
  for (const edge of edges) {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (edge.type !== "CONTAINS" || a === undefined || b === undefined || ordered[a]!.type !== "SOURCE" || ordered[b]!.type !== "MEMORY") continue;
    const id = ordered[b]!.id, cloud = large ? 70 * Math.max(1, Math.cbrt(children[a]! / 40)) : 70;
    positions[b * 3] = positions[a * 3]! + (memoryLayoutUnit(`${id}:dx`) - 0.5) * cloud;
    positions[b * 3 + 1] = positions[a * 3 + 1]! + (memoryLayoutUnit(`${id}:dy`) - 0.5) * cloud;
    positions[b * 3 + 2] = positions[a * 3 + 2]! + (memoryLayoutUnit(`${id}:dz`) - 0.5) * cloud;
  }
  const fx = new Float64Array(count), fy = new Float64Array(count), fz = new Float64Array(count);
  const cellX = new Int32Array(count), cellY = new Int32Array(count), cellZ = new Int32Array(count);
  let buckets = 1;
  while (buckets < count * 2) buckets <<= 1;
  const mask = buckets - 1;
  const bucketOf = (x: number, y: number, z: number) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & mask;
  const bucketStart = new Int32Array(buckets + 1), bucketFill = new Int32Array(buckets), members = new Int32Array(count), nodeBucket = new Int32Array(count);
  const maxPairs = large ? MAX_PAIRS : Infinity;
  let step = 0;
  const runStep = () => {
    fx.fill(0); fy.fill(0); fz.fill(0);
    // Spatial grid as a counting sort over hashed cells: members of a bucket stay in ascending
    // node order, so forces accumulate in the same order as the original string-keyed grid.
    bucketStart.fill(0);
    for (let i = 0; i < count; i++) {
      const x = Math.floor(positions[i * 3]! / CELL), y = Math.floor(positions[i * 3 + 1]! / CELL), z = Math.floor(positions[i * 3 + 2]! / CELL);
      cellX[i] = x; cellY[i] = y; cellZ[i] = z;
      const bucket = bucketOf(x, y, z);
      nodeBucket[i] = bucket; bucketStart[bucket + 1]!++;
    }
    for (let b = 0; b < buckets; b++) bucketStart[b + 1]! += bucketStart[b]!;
    bucketFill.set(bucketStart.subarray(0, buckets));
    for (let i = 0; i < count; i++) members[bucketFill[nodeBucket[i]!]!++] = i;
    for (let i = 0; i < count; i++) {
      const px = positions[i * 3]!, py = positions[i * 3 + 1]!, pz = positions[i * 3 + 2]!;
      const gx = cellX[i]!, gy = cellY[i]!, gz = cellZ[i]!;
      let pairs = 0;
      // Up to 2,000 nodes: the 27 cells in x, y, z order, every pair (the original scheme). Larger
      // graphs visit the node's own cell first and stop after MAX_PAIRS pairs, so a dense cluster
      // costs the same per node as a sparse one.
      for (let c = 0; c < 27 && pairs < maxPairs; c++) {
        const offset = large ? NEAR_FIRST[c]! : c;
        const x = gx + OFFSET_X[offset]!, y = gy + OFFSET_Y[offset]!, z = gz + OFFSET_Z[offset]!;
        const bucket = bucketOf(x, y, z);
        // Bucket members are in ascending order: binary-search past j <= i instead of scanning them.
        const end = bucketStart[bucket + 1]!;
        let k = bucketStart[bucket]!, high = end;
        while (k < high) { const middle = (k + high) >>> 1; if (members[middle]! <= i) k = middle + 1; else high = middle; }
        for (; k < end && pairs < maxPairs; k++) {
          const j = members[k]!;
          if (cellX[j] !== x || cellY[j] !== y || cellZ[j] !== z) continue;
          pairs++;
          const dx = px - positions[j * 3]!, dy = py - positions[j * 3 + 1]!, dz = pz - positions[j * 3 + 2]!;
          const distanceSquared = Math.max(1, dx * dx + dy * dy + dz * dz);
          const strength = (source[i] === 1 || source[j] === 1 ? 28 : 12) / distanceSquared;
          fx[i]! += dx * strength; fy[i]! += dy * strength; fz[i]! += dz * strength;
          fx[j]! -= dx * strength; fy[j]! -= dy * strength; fz[j]! -= dz * strength;
        }
      }
    }
    for (let l = 0; l < linkA.length; l++) {
      const a = linkA[l]!, b = linkB[l]!;
      const dx = positions[b * 3]! - positions[a * 3]!, dy = positions[b * 3 + 1]! - positions[a * 3 + 1]!, dz = positions[b * 3 + 2]! - positions[a * 3 + 2]!;
      const distance = Math.max(0.01, Math.hypot(dx, dy, dz));
      const spring = (distance - linkLength[l]!) * linkStrength[l]! / distance;
      fx[a]! += dx * spring; fy[a]! += dy * spring; fz[a]! += dz * spring;
      fx[b]! -= dx * spring; fy[b]! -= dy * spring; fz[b]! -= dz * spring;
    }
    const cooling = 1 - step / 230;
    for (let i = 0; i < count; i++) {
      if (i === root) continue;
      const x = positions[i * 3]!, y = positions[i * 3 + 1]!, z = positions[i * 3 + 2]!;
      const dx = fx[i]! - x * 0.0005, dy = fy[i]! - y * 0.0005, dz = fz[i]! - z * 0.0005;
      const stepScale = Math.min(1, 4 / Math.max(0.01, Math.hypot(dx, dy, dz))) * cooling;
      positions[i * 3] = x + dx * stepScale; positions[i * 3 + 1] = y + dy * stepScale; positions[i * 3 + 2] = z + dz * stepScale;
    }
    step++;
  };
  return {
    ids, positions, totalSteps: MEMORY_3D_LAYOUT_STEPS,
    get step() { return step; },
    get done() { return step >= MEMORY_3D_LAYOUT_STEPS || count === 0; },
    advance(steps: number) {
      if (count === 0) return true;
      for (let n = 0; n < steps && step < MEMORY_3D_LAYOUT_STEPS; n++) runStep();
      return step >= MEMORY_3D_LAYOUT_STEPS;
    }
  };
}
