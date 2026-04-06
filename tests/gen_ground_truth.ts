#!/usr/bin/env -S deno run --allow-read --allow-write
// Generate ground truth projection + blend output for datasets.
// Saves px/py/gx/gy per node for comparison after refactoring.
// Usage: deno run --allow-read --allow-write tests/gen_ground_truth.ts

import { runPipeline } from '../docs/bitzoom-pipeline.js';
import { unifiedBlend, MINHASH_K, buildGaussianProjection } from '../docs/bitzoom-algo.js';

interface TestCase {
  name: string;
  edges: string;
  nodes: string | null;
  strengths: Record<string, number>;
  alpha: number;
  quant: string;
}

const cases: TestCase[] = [
  { name: 'karate-balanced',
    edges: 'docs/data/karate.edges', nodes: 'docs/data/karate.nodes',
    strengths: { group: 3, label: 1 }, alpha: 0, quant: 'gaussian' },
  { name: 'karate-topo',
    edges: 'docs/data/karate.edges', nodes: 'docs/data/karate.nodes',
    strengths: { group: 3, label: 1 }, alpha: 0.75, quant: 'gaussian' },
  { name: 'epstein-edgetype',
    edges: 'docs/data/epstein.edges', nodes: 'docs/data/epstein.nodes',
    strengths: { group: 5, edgetype: 8 }, alpha: 0, quant: 'gaussian' },
  { name: 'epstein-topo',
    edges: 'docs/data/epstein.edges', nodes: 'docs/data/epstein.nodes',
    strengths: { group: 5, edgetype: 8 }, alpha: 0.75, quant: 'gaussian' },
  { name: 'bzsource-kind',
    edges: 'docs/data/bitzoom-source.edges', nodes: 'docs/data/bitzoom-source.nodes',
    strengths: { kind: 8, group: 3 }, alpha: 0, quant: 'gaussian' },
  { name: 'bzsource-topo',
    edges: 'docs/data/bitzoom-source.edges', nodes: 'docs/data/bitzoom-source.nodes',
    strengths: { kind: 8, group: 3 }, alpha: 0.5, quant: 'gaussian' },
  { name: 'mitre-weighted',
    edges: 'docs/data/mitre-attack.edges', nodes: 'docs/data/mitre-attack.nodes',
    strengths: { group: 5, platforms: 6, killchain: 4 }, alpha: 0, quant: 'gaussian' },
  { name: 'mitre-rank',
    edges: 'docs/data/mitre-attack.edges', nodes: 'docs/data/mitre-attack.nodes',
    strengths: { group: 5, platforms: 6, killchain: 4 }, alpha: 0, quant: 'rank' },
  { name: 'email-topo',
    edges: 'docs/data/email-eu.edges', nodes: null,
    strengths: {}, alpha: 0.75, quant: 'rank' },
];

const outDir = 'tests/ground-truth';
try { Deno.mkdirSync(outDir, { recursive: true }); } catch {}

for (const tc of cases) {
  const edgesText = Deno.readTextFileSync(tc.edges);
  const nodesText = tc.nodes ? Deno.readTextFileSync(tc.nodes) : null;
  const result = runPipeline(edgesText, nodesText);

  // Hydrate nodes with projections
  const G = result.groupNames.length;
  const nodes = result.nodeArray.map((n: any, i: number) => {
    const projections: Record<string, number[]> = {};
    for (let g = 0; g < G; g++) {
      const off = (i * G + g) * 2;
      projections[result.groupNames[g]] = [result.projBuf[off], result.projBuf[off + 1]];
    }
    return { ...n, projections, px: 0, py: 0, gx: 0, gy: 0 };
  });

  // Build adjList
  const adjList: Record<string, string[]> = {};
  for (const n of nodes) adjList[n.id] = [];
  for (const e of result.edges) {
    if (adjList[e.src] && adjList[e.dst]) {
      adjList[e.src].push(e.dst);
      adjList[e.dst].push(e.src);
    }
  }
  const nodeIndexFull: Record<string, any> = {};
  for (const n of nodes) nodeIndexFull[n.id] = n;

  // Set strengths (fill unspecified with 0)
  const propStrengths: Record<string, number> = {};
  for (const g of result.groupNames) propStrengths[g] = tc.strengths[g] ?? 0;

  // Blend + quantize
  unifiedBlend(nodes, result.groupNames, propStrengths, tc.alpha, adjList, nodeIndexFull, 5, tc.quant, {});

  // Save: id, px, py, gx, gy, projections per group
  const lines: string[] = [];
  // Header
  const projHeaders = result.groupNames.map((g: string) => `proj_${g}_x\tproj_${g}_y`).join('\t');
  lines.push(`# id\tpx\tpy\tgx\tgy\t${projHeaders}`);
  lines.push(`# config: strengths=${JSON.stringify(tc.strengths)} alpha=${tc.alpha} quant=${tc.quant}`);
  lines.push(`# nodes=${nodes.length} groups=${result.groupNames.join(',')}`);

  for (const n of nodes) {
    const projVals = result.groupNames.map((g: string) => {
      const p = n.projections[g];
      return p ? `${p[0]}\t${p[1]}` : '0\t0';
    }).join('\t');
    lines.push(`${n.id}\t${n.px}\t${n.py}\t${n.gx}\t${n.gy}\t${projVals}`);
  }

  const path = `${outDir}/${tc.name}.tsv`;
  Deno.writeTextFileSync(path, lines.join('\n') + '\n');
  console.log(`${tc.name}: ${nodes.length} nodes → ${path}`);
}

console.log('\nDone. Ground truth saved to tests/ground-truth/');
