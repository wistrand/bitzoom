// Benchmark: full pipeline stages on real datasets.
// Measures: parse, build graph, compute projections, blend+quantize, buildLevel.

import { runPipeline } from '../docs/bitzoom-pipeline.js';
import { unifiedBlend, buildLevel, normalizeAndQuantize, gaussianQuantize } from '../docs/bitzoom-algo.js';

const DATASETS = [
  { name: 'Epstein', edges: 'docs/data/epstein.edges', nodes: 'docs/data/epstein.nodes' },
  { name: 'Synth Packages', edges: 'docs/data/synth-packages.edges', nodes: 'docs/data/synth-packages.nodes' },
  { name: 'MITRE ATT&CK', edges: 'docs/data/mitre-attack.edges', nodes: 'docs/data/mitre-attack.nodes' },
];

function fmt(ms) { return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(1)}ms`; }

for (const ds of DATASETS) {
  console.log(`\n=== ${ds.name} ===`);
  const edgesText = Deno.readTextFileSync(ds.edges);
  const nodesText = Deno.readTextFileSync(ds.nodes);

  // Parse + build + project (runPipeline)
  const t0 = performance.now();
  const result = runPipeline(edgesText, nodesText);
  const tPipeline = performance.now() - t0;

  const N = result.nodeArray.length;
  const E = result.edges.length;
  const G = result.groupNames.length;
  console.log(`  Nodes: ${N}, Edges: ${E}, Groups: ${G}`);
  console.log(`  runPipeline (parse+build+project): ${fmt(tPipeline)}`);

  // Hydrate nodes
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
  const weights = {};
  for (const g of result.groupNames) weights[g] = g === 'group' ? 3 : g === 'label' ? 1 : 0;

  // Blend (α=0, no topology smoothing)
  const t1 = performance.now();
  unifiedBlend(nodes, result.groupNames, weights, 0, adjList, nodeIndex, 5, 'gaussian');
  const tBlendNoAlpha = performance.now() - t1;
  console.log(`  Blend (α=0, gaussian): ${fmt(tBlendNoAlpha)}`);

  // Re-blend with topology
  const t2 = performance.now();
  unifiedBlend(nodes, result.groupNames, weights, 0.5, adjList, nodeIndex, 5, 'gaussian');
  const tBlendAlpha = performance.now() - t2;
  console.log(`  Blend (α=0.5, 5 passes, gaussian): ${fmt(tBlendAlpha)}`);

  // Rank quantization comparison
  const t2b = performance.now();
  unifiedBlend(nodes, result.groupNames, weights, 0, adjList, nodeIndex, 5, 'rank');
  const tBlendRank = performance.now() - t2b;
  console.log(`  Blend (α=0, rank): ${fmt(tBlendRank)}`);

  // Build level (combined)
  const t3 = performance.now();
  const lv4 = buildLevel(4, nodes, result.edges, nodeIndex, n => n.group, n => n.label || n.id, () => '#888');
  const tLevel = performance.now() - t3;
  console.log(`  buildLevel(L4): ${fmt(tLevel)} → ${lv4.supernodes.length} supernodes, ${lv4.snEdges.length} edges`);

  // Build level at higher zoom
  const t4 = performance.now();
  const lv8 = buildLevel(8, nodes, result.edges, nodeIndex, n => n.group, n => n.label || n.id, () => '#888');
  const tLevel8 = performance.now() - t4;
  console.log(`  buildLevel(L8): ${fmt(tLevel8)} → ${lv8.supernodes.length} supernodes, ${lv8.snEdges.length} edges`);

  // Total
  console.log(`  Total: ${fmt(tPipeline + tBlendNoAlpha + tLevel)}`);
}
