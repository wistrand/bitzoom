#!/usr/bin/env -S deno run --unstable-webgpu --allow-read
// Benchmark: GPU vs CPU for projection and blend.
// Run: deno run --unstable-webgpu --allow-read scripts/bench-gpu.js

import { computeProjections, buildGraph, parseEdgesFile, parseNodesFile } from '../docs/bitzoom-pipeline.js';
import { computeProjectionsGPU, initGPU, gpuBlend } from '../docs/bitzoom-gpu.js';
import { unifiedBlend } from '../docs/bitzoom-algo.js';

const DATASETS = [
  { name: 'Karate',          edges: 'docs/data/karate.edges',          nodes: 'docs/data/karate.nodes' },
  { name: 'Epstein',         edges: 'docs/data/epstein.edges',         nodes: 'docs/data/epstein.nodes' },
  { name: 'BitZoom Source',  edges: 'docs/data/bitzoom-source.edges',  nodes: 'docs/data/bitzoom-source.nodes' },
  { name: 'Synth Packages',  edges: 'docs/data/synth-packages.edges',  nodes: 'docs/data/synth-packages.nodes' },
  { name: 'MITRE ATT&CK',   edges: 'docs/data/mitre-attack.edges',    nodes: 'docs/data/mitre-attack.nodes' },
  { name: 'Amazon',          edges: 'docs/data/amazon-copurchase.edges.gz', nodes: 'docs/data/amazon-copurchase.nodes.gz', gz: true },
];

async function readFile(path, gz) {
  if (!gz) return Deno.readTextFileSync(path);
  const compressed = Deno.readFileSync(path);
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(compressed);
  writer.close();
  const chunks = [];
  const reader = ds.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return new TextDecoder().decode(buf);
}

const WARMUP_DEFAULT = 2;
const RUNS_DEFAULT = 5;
const WARMUP_LARGE = 0;  // 100K+ nodes
const RUNS_LARGE = 1;

function fmt(ms) { return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : ms < 1000 ? `${ms.toFixed(1)}ms` : `${(ms / 1000).toFixed(2)}s`; }
function median(arr) { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

// Init GPU
const gpuOk = await initGPU();
if (!gpuOk) { console.error('WebGPU not available'); Deno.exit(1); }
console.log('WebGPU initialized\n');

// Header
console.log('Dataset'.padEnd(18) +
  'Nodes'.padStart(7) +
  'Groups'.padStart(7) +
  '  CPU proj'.padEnd(12) +
  '  GPU proj'.padEnd(12) +
  ' Speedup'.padEnd(9) +
  '  CPU blend'.padEnd(12) +
  '  GPU blend'.padEnd(12) +
  ' Speedup'.padEnd(9));
console.log('-'.repeat(98));

for (const ds of DATASETS) {
  const edgesText = await readFile(ds.edges, ds.gz);
  const nodesText = await readFile(ds.nodes, ds.gz);

  // Parse and build graph once (shared by both paths)
  const parsed = parseEdgesFile(edgesText);
  const nodesResult = parseNodesFile(nodesText);
  const graph = buildGraph(parsed, nodesResult.nodes, nodesResult.extraPropNames);
  const { nodeArray, adjGroups, groupNames, hasEdgeTypes, numericBins, edges } = graph;
  const extraPropNames = nodesResult.extraPropNames;
  const N = nodeArray.length;
  const G = groupNames.length;
  const large = N > 100000;
  const warmup = large ? WARMUP_LARGE : WARMUP_DEFAULT;
  const runs = large ? RUNS_LARGE : RUNS_DEFAULT;

  // ─── Projection benchmark ───────────────────────────────────────────────

  // CPU projection
  const cpuProjTimes = [];
  for (let i = 0; i < warmup + runs; i++) {
    const t0 = performance.now();
    computeProjections(nodeArray, adjGroups, groupNames, hasEdgeTypes, extraPropNames, numericBins);
    const elapsed = performance.now() - t0;
    if (i >= warmup) cpuProjTimes.push(elapsed);
  }

  // GPU projection
  const gpuProjTimes = [];
  for (let i = 0; i < warmup + runs; i++) {
    const t0 = performance.now();
    await computeProjectionsGPU(nodeArray, adjGroups, groupNames, hasEdgeTypes, extraPropNames, numericBins);
    const elapsed = performance.now() - t0;
    if (i >= warmup) gpuProjTimes.push(elapsed);
  }

  const cpuProjMs = median(cpuProjTimes);
  const gpuProjMs = median(gpuProjTimes);
  const projSpeedup = cpuProjMs / gpuProjMs;

  // ─── Blend benchmark ──────────────────────────────────────────────────

  // Hydrate nodes with projections (use CPU result)
  const cpuProj = computeProjections(nodeArray, adjGroups, groupNames, hasEdgeTypes, extraPropNames, numericBins);
  function makeNodes() {
    return nodeArray.map((n, i) => {
      const projections = {};
      for (let g = 0; g < G; g++) {
        const off = (i * G + g) * 2;
        projections[groupNames[g]] = [cpuProj.projBuf[off], cpuProj.projBuf[off + 1]];
      }
      return { ...n, projections, px: 0, py: 0, gx: 0, gy: 0, x: 0, y: 0 };
    });
  }

  const nodeIndex = Object.fromEntries(nodeArray.map(n => [n.id, n]));
  const adjList = Object.fromEntries(nodeArray.map(n => [n.id, []]));
  for (const e of edges) {
    if (adjList[e.src] && adjList[e.dst]) {
      adjList[e.src].push(e.dst);
      adjList[e.dst].push(e.src);
    }
  }
  const strengths = {};
  for (const g of groupNames) strengths[g] = g === 'group' ? 5 : g === 'label' ? 1 : 2;

  // CPU blend
  const cpuBlendTimes = [];
  for (let i = 0; i < warmup + runs; i++) {
    const nodes = makeNodes();
    const ni = Object.fromEntries(nodes.map(n => [n.id, n]));
    const t0 = performance.now();
    unifiedBlend(nodes, groupNames, strengths, 0.5, adjList, ni, 5, 'gaussian');
    const elapsed = performance.now() - t0;
    if (i >= warmup) cpuBlendTimes.push(elapsed);
  }

  // GPU blend
  const gpuBlendTimes = [];
  for (let i = 0; i < warmup + runs; i++) {
    const nodes = makeNodes();
    const ni = Object.fromEntries(nodes.map(n => [n.id, n]));
    const t0 = performance.now();
    await gpuBlend(nodes, groupNames, strengths, 0.5, adjList, ni, 5);
    const elapsed = performance.now() - t0;
    if (i >= warmup) gpuBlendTimes.push(elapsed);
  }

  const cpuBlendMs = median(cpuBlendTimes);
  const gpuBlendMs = median(gpuBlendTimes);
  const blendSpeedup = cpuBlendMs / gpuBlendMs;

  // ─── Output ──────────────────────────────────────────────────────────

  console.log(
    ds.name.padEnd(18) +
    String(N).padStart(7) +
    String(G).padStart(7) +
    fmt(cpuProjMs).padStart(10) +
    fmt(gpuProjMs).padStart(10) +
    `${projSpeedup.toFixed(2)}x`.padStart(9) +
    fmt(cpuBlendMs).padStart(10) +
    fmt(gpuBlendMs).padStart(10) +
    `${blendSpeedup.toFixed(2)}x`.padStart(9)
  );
}

console.log('\nMedian of 5 runs after 2 warmup (1 run, no warmup for 100K+ nodes).');
console.log('Projection includes tokenization (CPU) + MinHash+project (GPU/CPU).');
console.log('Blend is α=0.5, 5 passes, gaussian quantization. GPU blend excludes quantization (done on CPU).');
