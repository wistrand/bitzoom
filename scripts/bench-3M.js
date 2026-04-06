// Benchmark: 3 million node synthetic dataset.
// Skips MinHash/projection (which would take hours at this scale) and
// generates pre-projected data directly. Tests the stages that matter
// for viewer interactivity: blend, quantize, level build, hit test.

import {
  MINHASH_K, ZOOM_LEVELS, GRID_SIZE, GRID_BITS,
  unifiedBlend, buildLevelNodes, buildLevelEdges,
  cellIdAtLevel, normalizeAndQuantize, gaussianQuantize,
} from '../docs/bitzoom-algo.js';

function fmt(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

const N = 3_000_000;
const EDGES_PER_NODE = 3;
const GROUPS = 30;
const GROUP_NAMES = ['group', 'label', 'structure', 'neighbors', 'score', 'category'];

console.log(`\nGenerating ${(N/1e6).toFixed(0)}M nodes, ~${(N * EDGES_PER_NODE / 1e6).toFixed(0)}M edges, ${GROUPS} groups...\n`);

// ─── Generate pre-projected nodes ─────────────────────────────────────────

const t0 = performance.now();
const nodes = new Array(N);
const nodeIndex = {};
const adjList = {};

for (let i = 0; i < N; i++) {
  const id = `n${i}`;
  const group = `g${i % GROUPS}`;
  // Fake projections: random 2D per group, simulating what the pipeline produces
  const projections = {};
  for (const g of GROUP_NAMES) {
    projections[g] = [(Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4];
  }
  nodes[i] = {
    id, group, label: id, degree: 0,
    projections, px: 0, py: 0, gx: 0, gy: 0, x: 0, y: 0,
  };
  nodeIndex[id] = nodes[i];
  adjList[id] = [];
}
console.log(`  Generate nodes: ${fmt(performance.now() - t0)}`);

// Generate edges
const t1 = performance.now();
const edges = [];
for (let i = 0; i < N; i++) {
  for (let e = 0; e < EDGES_PER_NODE; e++) {
    const j = Math.floor(Math.random() * N);
    if (j !== i) {
      edges.push({ src: `n${i}`, dst: `n${j}` });
      nodes[i].degree++;
      nodes[j].degree++;
      adjList[`n${i}`].push(`n${j}`);
      adjList[`n${j}`].push(`n${i}`);
    }
  }
}
console.log(`  Generate ${(edges.length / 1e6).toFixed(1)}M edges: ${fmt(performance.now() - t1)}`);

// ─── Blend (α=0) ──────────────────────────────────────────────────────────

const strengths = {};
for (const g of GROUP_NAMES) strengths[g] = g === 'group' ? 3 : g === 'label' ? 1 : 0;

console.log('\n=== Blend + Quantize ===');

const quantStats = {};
const t2 = performance.now();
unifiedBlend(nodes, GROUP_NAMES, strengths, 0, adjList, nodeIndex, 5, 'gaussian', quantStats);
console.log(`  Blend (α=0, gaussian): ${fmt(performance.now() - t2)}`);

// Re-blend with rank for comparison
const t2b = performance.now();
unifiedBlend(nodes, GROUP_NAMES, strengths, 0, adjList, nodeIndex, 5, 'rank');
console.log(`  Blend (α=0, rank): ${fmt(performance.now() - t2b)}`);

// Strength change
strengths['group'] = 1;
strengths['score'] = 8;
const t2c = performance.now();
unifiedBlend(nodes, GROUP_NAMES, strengths, 0, adjList, nodeIndex, 5, 'gaussian', quantStats);
console.log(`  Strength change (reblend): ${fmt(performance.now() - t2c)}`);

// Topology
const t2d = performance.now();
unifiedBlend(nodes, GROUP_NAMES, strengths, 0.3, adjList, nodeIndex, 5, 'gaussian', quantStats);
console.log(`  Topo blend (α=0.3, 5 passes): ${fmt(performance.now() - t2d)}`);

// ─── Level building (two-phase) ──────────────────────────────────────────

console.log('\n=== Level Building ===');

for (const lvIdx of [1, 3, 5, 7, 9]) {
  const level = ZOOM_LEVELS[lvIdx];
  const tN = performance.now();
  const lvl = buildLevelNodes(level, nodes, n => n.group, n => n.id, () => '#888');
  const tNodes = performance.now() - tN;

  const tE = performance.now();
  buildLevelEdges(lvl, edges, nodeIndex, level);
  const tEdges = performance.now() - tE;

  console.log(`  L${level}: nodes=${fmt(tNodes)} edges=${fmt(tEdges)} → ${lvl.supernodes.length.toLocaleString()} sn, ${lvl.snEdges.length.toLocaleString()} se`);
}

// ─── Layout simulation ───────────────────────────────────────────────────

console.log('\n=== Layout ===');
const t3 = performance.now();
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
for (const n of nodes) {
  if (n.px < minX) minX = n.px;
  if (n.px > maxX) maxX = n.px;
  if (n.py < minY) minY = n.py;
  if (n.py > maxY) maxY = n.py;
}
const rangeX = maxX - minX || 1, rangeY = maxY - minY || 1;
const scale = Math.min(1080 / rangeX, 720 / rangeY);
const offX = 60, offY = 60;
for (const n of nodes) {
  n.x = offX + (n.px - minX) * scale;
  n.y = offY + (n.py - minY) * scale;
}
console.log(`  Layout ${(N / 1e6).toFixed(0)}M nodes: ${fmt(performance.now() - t3)}`);

// ─── Spatial hit test ────────────────────────────────────────────────────

console.log('\n=== Spatial Hit Test (L6) ===');
const cullLevel = ZOOM_LEVELS[5];
const lvl6 = buildLevelNodes(cullLevel, nodes, n => n.group, n => n.id, () => '#888');
const snByBid = new Map();
for (const sn of lvl6.supernodes) snByBid.set(sn.bid, sn);

const shift = GRID_BITS - cullLevel;
const k = 1 << cullLevel;
const LOOKUPS = 100000;

const t4 = performance.now();
let hits = 0;
for (let i = 0; i < LOOKUPS; i++) {
  const gx = Math.floor(Math.random() * GRID_SIZE);
  const gy = Math.floor(Math.random() * GRID_SIZE);
  const ccx = gx >> shift, ccy = gy >> shift;
  for (let dy = -1; dy <= 1; dy++) {
    const cy = ccy + dy;
    if (cy < 0 || cy >= k) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ccx + dx;
      if (cx < 0 || cx >= k) continue;
      if (snByBid.get((cx << cullLevel) | cy)) hits++;
    }
  }
}
console.log(`  ${(LOOKUPS / 1000).toFixed(0)}K spatial lookups: ${fmt(performance.now() - t4)} (${((performance.now() - t4) / LOOKUPS * 1000).toFixed(1)}µs/lookup)`);

// Linear scan comparison (1K only — full 100K would be too slow)
const LINEAR_LOOKUPS = 1000;
const t5 = performance.now();
for (let i = 0; i < LINEAR_LOOKUPS; i++) {
  const wx = Math.random() * 1200;
  for (const sn of lvl6.supernodes) {
    if (Math.abs(sn.ax - wx) < 0.001) hits++;
  }
}
const tLinear = performance.now() - t5;
console.log(`  ${LINEAR_LOOKUPS} linear scans (${lvl6.supernodes.length.toLocaleString()} sn): ${fmt(tLinear)} (${(tLinear / LINEAR_LOOKUPS * 1000).toFixed(0)}µs/scan)`);
console.log(`  Spatial speedup: ~${(tLinear / LINEAR_LOOKUPS / ((performance.now() - t4) / LOOKUPS)).toFixed(0)}x`);

// ─── Memory estimate ──────────────────────────────────────────────────────

console.log('\n=== Memory Estimate ===');
const nodeBytes = N * (6 * 2 * 8 + 6 * 8 + 100); // projections + coords + overhead
const edgeBytes = edges.length * 50; // {src, dst} strings + overhead
const adjBytes = N * EDGES_PER_NODE * 2 * 30; // adjList arrays
console.log(`  Nodes: ~${(nodeBytes / 1e9).toFixed(1)} GB`);
console.log(`  Edges: ~${(edgeBytes / 1e9).toFixed(1)} GB`);
console.log(`  AdjList: ~${(adjBytes / 1e9).toFixed(1)} GB`);
console.log(`  Total estimate: ~${((nodeBytes + edgeBytes + adjBytes) / 1e9).toFixed(1)} GB`);
