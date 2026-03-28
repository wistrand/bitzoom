// Benchmark: rendering-related computations (no actual canvas).
// Measures: layoutAll, hitTest, level building phases, edge batching.

import { runPipeline } from '../docs/bitzoom-pipeline.js';
import { unifiedBlend, buildLevelNodes, buildLevelEdges, cellIdAtLevel, ZOOM_LEVELS, GRID_SIZE, GRID_BITS } from '../docs/bitzoom-algo.js';

function fmt(ms) { return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(1)}ms`; }

// Use MITRE for meaningful size
const edgesText = Deno.readTextFileSync('docs/data/mitre-attack.edges');
const nodesText = Deno.readTextFileSync('docs/data/mitre-attack.nodes');
const result = runPipeline(edgesText, nodesText);
const G = result.groupNames.length;

const nodes = result.nodeArray.map((n, i) => {
  const projections = {};
  for (let g = 0; g < G; g++) {
    const off = (i * G + g) * 2;
    projections[result.groupNames[g]] = [result.projBuf[off], result.projBuf[off + 1]];
  }
  return { ...n, projections, px: 0, py: 0, gx: 0, gy: 0, x: 0, y: 0 };
});
const nodeIndex = Object.fromEntries(nodes.map(n => [n.id, n]));
const adjList = Object.fromEntries(nodes.map(n => [n.id, []]));
for (const e of result.edges) {
  if (adjList[e.src] && adjList[e.dst]) { adjList[e.src].push(e.dst); adjList[e.dst].push(e.src); }
}
const weights = {};
for (const g of result.groupNames) weights[g] = g === 'group' ? 3 : 0;
unifiedBlend(nodes, result.groupNames, weights, 0, adjList, nodeIndex, 5, 'gaussian');

const N = nodes.length;
const E = result.edges.length;
console.log(`Dataset: MITRE ATT&CK (${N} nodes, ${E} edges)\n`);

// Benchmark: buildLevelNodes vs buildLevelEdges
console.log('=== Two-Phase Level Building ===');
for (const lvIdx of [2, 4, 6, 8]) {
  const level = ZOOM_LEVELS[lvIdx];

  const t0 = performance.now();
  const lvl = buildLevelNodes(level, nodes, n => n.group, n => n.label || n.id, () => '#888');
  const tNodes = performance.now() - t0;

  const t1 = performance.now();
  buildLevelEdges(lvl, result.edges, nodeIndex, level);
  const tEdges = performance.now() - t1;

  console.log(`  L${level}: nodes=${fmt(tNodes)} edges=${fmt(tEdges)} total=${fmt(tNodes + tEdges)} → ${lvl.supernodes.length} sn, ${lvl.snEdges.length} se`);
}

// Benchmark: cellIdAtLevel throughput
console.log('\n=== cellIdAtLevel Throughput ===');
const ITERS = 100;
const t2 = performance.now();
for (let iter = 0; iter < ITERS; iter++) {
  for (let i = 0; i < N; i++) cellIdAtLevel(nodes[i].gx, nodes[i].gy, 6);
}
const tCell = performance.now() - t2;
console.log(`  ${N * ITERS} calls: ${fmt(tCell)} (${(tCell / (N * ITERS) * 1e6).toFixed(1)}ns/call)`);

// Benchmark: spatial lookup simulation (world→grid→cell)
console.log('\n=== Spatial Lookup (hitTest-style) ===');
const LOOKUPS = 10000;
const scale = 700 / 2; // simulated layout scale
const offX = 40, offY = 40, minX = -1, minY = -1;
const cullLevel = ZOOM_LEVELS[5]; // L6
const shift = GRID_BITS - cullLevel;
const k = 1 << cullLevel;

// Build snByBid index
const lvl6 = buildLevelNodes(cullLevel, nodes, n => n.group, n => n.label || n.id, () => '#888');
buildLevelEdges(lvl6, result.edges, nodeIndex, cullLevel);
const snByBid = new Map();
for (const sn of lvl6.supernodes) snByBid.set(sn.bid, sn);

const t3 = performance.now();
let hits = 0;
for (let i = 0; i < LOOKUPS; i++) {
  const wx = Math.random() * 700;
  const wy = Math.random() * 700;
  const px = (wx - offX) / scale + minX;
  const py = (wy - offY) / scale + minY;
  const gx = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((px + 1) / 2 * GRID_SIZE)));
  const gy = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((py + 1) / 2 * GRID_SIZE)));
  const ccx = gx >> shift, ccy = gy >> shift;
  for (let dy = -1; dy <= 1; dy++) {
    const cy = ccy + dy;
    if (cy < 0 || cy >= k) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ccx + dx;
      if (cx < 0 || cx >= k) continue;
      const sn = snByBid.get((cx << cullLevel) | cy);
      if (sn) hits++;
    }
  }
}
const tLookup = performance.now() - t3;
console.log(`  ${LOOKUPS} lookups: ${fmt(tLookup)} (${(tLookup / LOOKUPS * 1000).toFixed(1)}µs/lookup, ${hits} cell hits)`);

// Benchmark: linear scan vs spatial for comparison
const t4 = performance.now();
let linearHits = 0;
for (let i = 0; i < LOOKUPS; i++) {
  const wx = Math.random() * 700;
  const wy = Math.random() * 700;
  for (const sn of lvl6.supernodes) {
    const dx = sn.ax - wx / scale;
    if (dx * dx < 0.01) linearHits++;
  }
}
const tLinear = performance.now() - t4;
console.log(`  ${LOOKUPS} linear scans: ${fmt(tLinear)} (${(tLinear / LOOKUPS * 1000).toFixed(1)}µs/scan)`);
console.log(`  Speedup: ${(tLinear / tLookup).toFixed(0)}x`);
