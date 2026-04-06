// GPU Blend comparison test.
// Run: deno test --unstable-webgpu --no-check --allow-read tests/gpu_blend_test.ts

import { assert } from 'https://deno.land/std@0.208.0/assert/assert.ts';
import { initGPU, gpuBlend } from '../docs/bitzoom-gpu.js';
import { runPipeline } from '../docs/bitzoom-pipeline.js';
import { unifiedBlend, MINHASH_K, buildGaussianProjection } from '../docs/bitzoom-algo.js';

Deno.test('GPU blend init', async () => {
  assert(await initGPU(), 'GPU should be available');
});

async function compareBlend(name: string, edgesPath: string, nodesPath: string | null, alpha: number, strengths?: Record<string, number>) {
  const edgesText = Deno.readTextFileSync(edgesPath);
  const nodesText = nodesPath ? Deno.readTextFileSync(nodesPath) : null;
  const result = runPipeline(edgesText, nodesText);

  // Build nodes with projections (same as bitzoom-canvas _hydrateAndLink)
  const G = result.groupNames.length;
  const nodes = result.nodeArray.map((n: any, i: number) => {
    const projections: Record<string, number[]> = {};
    for (let g = 0; g < G; g++) {
      const off = (i * G + g) * 2;
      projections[result.groupNames[g]] = [result.projBuf[off], result.projBuf[off + 1]];
    }
    return { ...n, projections, px: 0, py: 0, gx: 0, gy: 0 };
  });

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

  const propStrengths: Record<string, number> = strengths || {};
  if (!strengths) {
    for (const g of result.groupNames) propStrengths[g] = g === 'group' ? 3 : g === 'label' ? 1 : 0;
  }

  // CPU blend: replicate the blend logic WITHOUT quantization to get comparable positions.
  // unifiedBlend modifies px/py then quantizes (rank quant changes px/py).
  // We need pre-quantization px/py.
  const N = nodes.length;
  const cpuNodes = nodes.map((n: any) => ({ ...n, projections: { ...n.projections } }));
  const cpuNodeIndex: Record<string, any> = {};
  for (const n of cpuNodes) cpuNodeIndex[n.id] = n;

  // Compute property anchors (same as unifiedBlend)
  let maxW = 0;
  for (const g of result.groupNames) { const raw = propStrengths[g] || 0; if (raw > maxW) maxW = raw; }
  const floorVal = Math.max(maxW * 0.10, 0.10);
  let propTotal = 0;
  const effW: Record<string, number> = {};
  for (const g of result.groupNames) { effW[g] = Math.max(propStrengths[g] || 0, floorVal); propTotal += effW[g]; }

  const cpuPropPx = new Float64Array(N);
  const cpuPropPy = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let px = 0, py = 0;
    for (const g of result.groupNames) {
      const p = cpuNodes[i].projections[g];
      if (p) { px += p[0] * effW[g]; py += p[1] * effW[g]; }
    }
    cpuPropPx[i] = px / propTotal;
    cpuPropPy[i] = py / propTotal;
    cpuNodes[i].px = cpuPropPx[i];
    cpuNodes[i].py = cpuPropPy[i];
  }

  // Run smoothing passes (same as unifiedBlend, no quantization)
  const clampedAlpha = Math.max(0, Math.min(1, alpha));
  if (clampedAlpha > 0) {
    for (let pass = 0; pass < 5; pass++) {
      const newPx = new Float64Array(N);
      const newPy = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        const nbrs = adjList[cpuNodes[i].id];
        if (nbrs && nbrs.length > 0) {
          let nx = 0, ny = 0, vc = 0;
          for (const nid of nbrs) {
            const nb = cpuNodeIndex[nid];
            if (nb) { nx += nb.px; ny += nb.py; vc++; }
          }
          if (vc > 0) {
            newPx[i] = (1 - clampedAlpha) * cpuPropPx[i] + clampedAlpha * (nx / vc);
            newPy[i] = (1 - clampedAlpha) * cpuPropPy[i] + clampedAlpha * (ny / vc);
          } else { newPx[i] = cpuPropPx[i]; newPy[i] = cpuPropPy[i]; }
        } else { newPx[i] = cpuPropPx[i]; newPy[i] = cpuPropPy[i]; }
      }
      for (let i = 0; i < N; i++) { cpuNodes[i].px = newPx[i]; cpuNodes[i].py = newPy[i]; }
    }
  }

  // GPU blend
  const gpuResult = await gpuBlend(nodes, result.groupNames, propStrengths, alpha, adjList, nodeIndexFull, 5);

  // Compare pre-quantization positions
  let maxDelta = 0;
  let mismatches = 0;
  for (let i = 0; i < N; i++) {
    const dx = Math.abs(gpuResult.px[i] - cpuNodes[i].px);
    const dy = Math.abs(gpuResult.py[i] - cpuNodes[i].py);
    const d = Math.max(dx, dy);
    if (d > maxDelta) maxDelta = d;
    if (d > 0.01) mismatches++;
  }
  console.log(`  ${name}: N=${N}, alpha=${alpha}, maxDelta=${maxDelta.toFixed(6)}, mismatches=${mismatches}/${N}`);
  return { maxDelta, mismatches, N };
}

Deno.test('GPU vs CPU blend: Karate alpha=0', async () => {
  const { maxDelta } = await compareBlend('Karate a=0', 'docs/data/karate.edges', 'docs/data/karate.nodes', 0);
  assert(maxDelta < 0.01, `Max delta ${maxDelta} should be < 0.01`);
});

Deno.test('GPU vs CPU blend: Karate alpha=0.5', async () => {
  const { maxDelta } = await compareBlend('Karate a=0.5', 'docs/data/karate.edges', 'docs/data/karate.nodes', 0.5);
  assert(maxDelta < 0.01, `Max delta ${maxDelta} should be < 0.01`);
});

Deno.test('GPU vs CPU blend: Karate alpha=1.0', async () => {
  const { maxDelta } = await compareBlend('Karate a=1', 'docs/data/karate.edges', 'docs/data/karate.nodes', 1.0);
  assert(maxDelta < 0.01, `Max delta ${maxDelta} should be < 0.01`);
});

Deno.test('GPU vs CPU blend: Epstein alpha=0.75', async () => {
  const { maxDelta } = await compareBlend('Epstein a=0.75', 'docs/data/epstein.edges', 'docs/data/epstein.nodes', 0.75);
  assert(maxDelta < 0.01, `Max delta ${maxDelta} should be < 0.01`);
});

Deno.test('GPU vs CPU blend: BZ Source alpha=0.5 weighted', async () => {
  const { maxDelta } = await compareBlend('BZ Source', 'docs/data/bitzoom-source.edges', 'docs/data/bitzoom-source.nodes', 0.5,
    { group: 3, label: 0, structure: 0, neighbors: 0, kind: 8, file: 0, lines: 0, bytes: 0, agehours: 0, edgetype: 0 });
  assert(maxDelta < 0.01, `Max delta ${maxDelta} should be < 0.01`);
});

Deno.test('GPU vs CPU blend: MITRE alpha=0.5 weighted', async () => {
  const { maxDelta } = await compareBlend('MITRE', 'docs/data/mitre-attack.edges', 'docs/data/mitre-attack.nodes', 0.5,
    { group: 5, label: 0, structure: 0, neighbors: 0, subtype: 0, killchain: 4, aliases: 0, level: 0, platforms: 6, edgetype: 0 });
  assert(maxDelta < 0.01, `Max delta ${maxDelta} should be < 0.01`);
});

Deno.test('GPU vs CPU blend: Email-EU edge-only alpha=0.75', async () => {
  const { maxDelta } = await compareBlend('Email-EU', 'docs/data/email-eu.edges', null, 0.75);
  assert(maxDelta < 0.01, `Max delta ${maxDelta} should be < 0.01`);
});
