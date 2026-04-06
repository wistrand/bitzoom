// Benchmark: simulates the viewer's actual workload without DOM.
// Generates synthetic datasets at various scales and measures every stage
// the viewer executes: parse → project → blend → quantize → level build →
// strength change → level switch → hit test simulation.

import { runPipeline } from '../docs/bitzoom-pipeline.js';
import {
  MINHASH_K, ZOOM_LEVELS, GRID_SIZE, GRID_BITS,
  unifiedBlend, buildLevelNodes, buildLevelEdges, buildLevel,
  cellIdAtLevel,
} from '../docs/bitzoom-algo.js';
import { generateGroupColors } from '../docs/bitzoom-colors.js';

function fmt(ms) { return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(1)}ms`; }

// ─── Synthetic dataset generator ──────────────────────────────────────────

function generateSNAP(nodeCount, edgesPerNode, groupCount, extraProps) {
  const groups = Array.from({ length: groupCount }, (_, i) => `group_${i}`);
  const edgeLines = [];
  const nodeLines = [`# NodeId\tLabel\tGroup${extraProps.map(p => '\t' + p).join('')}`];

  for (let i = 0; i < nodeCount; i++) {
    const id = `n${i}`;
    const group = groups[i % groupCount];
    const label = `node_${i}_${group}`;
    const extras = extraProps.map(p => {
      if (p === 'score') return String(Math.floor(Math.random() * 1000));
      if (p === 'category') return `cat_${i % 20}`;
      if (p === 'region') return `region_${i % 8}`;
      return `val_${i % 15}`;
    });
    nodeLines.push(`${id}\t${label}\t${group}${extras.map(e => '\t' + e).join('')}`);

    // Random edges (undirected, skip self-loops)
    for (let e = 0; e < edgesPerNode; e++) {
      const target = Math.floor(Math.random() * nodeCount);
      if (target !== i) edgeLines.push(`n${i}\tn${target}`);
    }
  }

  return { edgesText: edgeLines.join('\n'), nodesText: nodeLines.join('\n') };
}

// ─── Hydrate + adjacency (same as viewer) ─────────────────────────────────

function hydrateResult(result) {
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
    if (adjList[e.src] && adjList[e.dst]) {
      adjList[e.src].push(e.dst);
      adjList[e.dst].push(e.src);
    }
  }
  return { nodes, nodeIndex, adjList };
}

// ─── Simulate layout (no canvas, just coordinate math) ───────────────────

function simulateLayout(nodes, W, H) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (n.px < minX) minX = n.px;
    if (n.px > maxX) maxX = n.px;
    if (n.py < minY) minY = n.py;
    if (n.py > maxY) maxY = n.py;
  }
  const rangeX = maxX - minX || 1, rangeY = maxY - minY || 1;
  const pad = 60;
  const scale = Math.min((W - pad * 2) / rangeX, (H - pad * 2) / rangeY);
  const offX = pad + ((W - pad * 2) - rangeX * scale) / 2;
  const offY = pad + ((H - pad * 2) - rangeY * scale) / 2;
  for (const n of nodes) {
    n.x = offX + (n.px - minX) * scale;
    n.y = offY + (n.py - minY) * scale;
  }
  return { scale, offX, offY, minX, minY };
}

// ─── Simulate spatial hit test ────────────────────────────────────────────

function simulateHitTests(supernodes, snByBid, cullLevel, layout, count) {
  const shift = GRID_BITS - cullLevel;
  const k = 1 << cullLevel;
  let hits = 0;
  for (let i = 0; i < count; i++) {
    const wx = Math.random() * 1000;
    const wy = Math.random() * 800;
    const px = (wx - layout.offX) / layout.scale + layout.minX;
    const py = (wy - layout.offY) / layout.scale + layout.minY;
    const gx = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((px + 1) / 2 * GRID_SIZE)));
    const gy = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((py + 1) / 2 * GRID_SIZE)));
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
  return hits;
}

// ─── Run benchmarks ──────────────────────────────────────────────────────

const SCALES = [
  { nodes: 1000,   edgesPerNode: 3,  groups: 5,  extras: ['score', 'category'] },
  { nodes: 5000,   edgesPerNode: 4,  groups: 10, extras: ['score', 'category', 'region'] },
  { nodes: 20000,  edgesPerNode: 5,  groups: 15, extras: ['score', 'category', 'region'] },
  { nodes: 50000,  edgesPerNode: 4,  groups: 20, extras: ['score', 'category', 'region', 'tag'] },
  { nodes: 100000, edgesPerNode: 3,  groups: 25, extras: ['score', 'category'] },
];

for (const sc of SCALES) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`${sc.nodes.toLocaleString()} nodes, ~${(sc.nodes * sc.edgesPerNode).toLocaleString()} edges, ${sc.groups} groups, ${sc.extras.length} extra props`);
  console.log('='.repeat(70));

  // Generate
  const t0 = performance.now();
  const { edgesText, nodesText } = generateSNAP(sc.nodes, sc.edgesPerNode, sc.groups, sc.extras);
  console.log(`  Generate SNAP text: ${fmt(performance.now() - t0)}`);

  // Parse + project
  const t1 = performance.now();
  const result = runPipeline(edgesText, nodesText);
  const tPipeline = performance.now() - t1;
  console.log(`  runPipeline: ${fmt(tPipeline)} (${result.nodeArray.length} nodes, ${result.edges.length} edges, ${result.groupNames.length} groups)`);

  // Hydrate
  const t2 = performance.now();
  const { nodes, nodeIndex, adjList } = hydrateResult(result);
  console.log(`  Hydrate: ${fmt(performance.now() - t2)}`);

  // Initial blend (α=0, gaussian)
  const strengths = {};
  for (const g of result.groupNames) strengths[g] = g === 'group' ? 3 : g === 'label' ? 1 : 0;
  const quantStats = {};

  const t3 = performance.now();
  unifiedBlend(nodes, result.groupNames, strengths, 0, adjList, nodeIndex, 5, 'gaussian', quantStats);
  const tBlend = performance.now() - t3;
  console.log(`  Blend (α=0, gaussian): ${fmt(tBlend)}`);

  // Layout simulation
  const t4 = performance.now();
  const layout = simulateLayout(nodes, 1200, 800);
  console.log(`  Layout: ${fmt(performance.now() - t4)}`);

  // Build levels (two-phase)
  for (const lvIdx of [3, 5, 7]) {
    const level = ZOOM_LEVELS[lvIdx];
    const tN = performance.now();
    const lvl = buildLevelNodes(level, nodes, n => n.group, n => n.label || n.id, () => '#888');
    const tNodes = performance.now() - tN;
    const tE = performance.now();
    buildLevelEdges(lvl, result.edges, nodeIndex, level);
    const tEdges = performance.now() - tE;
    console.log(`  buildLevel L${level}: nodes=${fmt(tNodes)} edges=${fmt(tEdges)} → ${lvl.supernodes.length} sn, ${lvl.snEdges.length} se`);
  }

  // Strength change simulation (what happens when user moves a slider)
  const t5 = performance.now();
  strengths['group'] = 1;
  strengths[sc.extras[0]] = 8;
  unifiedBlend(nodes, result.groupNames, strengths, 0, adjList, nodeIndex, 5, 'gaussian', quantStats);
  const tReblend = performance.now() - t5;
  console.log(`  Strength change (reblend): ${fmt(tReblend)}`);

  // Topology smoothing (what happens when user increases α)
  const t6 = performance.now();
  unifiedBlend(nodes, result.groupNames, strengths, 0.5, adjList, nodeIndex, 5, 'gaussian', quantStats);
  const tTopo = performance.now() - t6;
  console.log(`  Topo blend (α=0.5): ${fmt(tTopo)}`);

  // Level switch: build a new level after strength change
  const t7 = performance.now();
  const freshLv = buildLevel(ZOOM_LEVELS[3], nodes, result.edges, nodeIndex, n => n.group, n => n.label || n.id, () => '#888');
  console.log(`  Level rebuild after strengths: ${fmt(performance.now() - t7)} → ${freshLv.supernodes.length} sn`);

  // Spatial hit test simulation (10K lookups)
  const cullLevel = ZOOM_LEVELS[5];
  const lvl6 = buildLevelNodes(cullLevel, nodes, n => n.group, n => n.label || n.id, () => '#888');
  buildLevelEdges(lvl6, result.edges, nodeIndex, cullLevel);
  const snByBid = new Map();
  for (const sn of lvl6.supernodes) snByBid.set(sn.bid, sn);

  const HIT_COUNT = 10000;
  const t8 = performance.now();
  const hits = simulateHitTests(lvl6.supernodes, snByBid, cullLevel, layout, HIT_COUNT);
  const tHit = performance.now() - t8;
  console.log(`  ${HIT_COUNT} spatial hit tests: ${fmt(tHit)} (${(tHit / HIT_COUNT * 1000).toFixed(1)}µs/test)`);

  // Edge sampling simulation (what render does per frame)
  const t9 = performance.now();
  const maxEdges = Math.min(5000, Math.max(200, lvl6.supernodes.length * 3));
  let drawn = 0;
  for (const e of lvl6.snEdges) {
    const a = snByBid.get(e.a), b = snByBid.get(e.b);
    if (!a || !b) continue;
    // Simulate screen transform + distance check
    const dx = (a.ax - b.ax) * 500, dy = (a.ay - b.ay) * 400;
    if (dx * dx + dy * dy > 1000000) continue;
    if (++drawn > maxEdges) break;
  }
  console.log(`  Edge sampling sim: ${fmt(performance.now() - t9)} (${drawn}/${lvl6.snEdges.length} drawn)`);

  // Summary
  const total = tPipeline + tBlend;
  console.log(`  ── Load total: ${fmt(total)} | Per strength change: ${fmt(tReblend)}`);
}
