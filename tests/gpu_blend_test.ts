// GPU Blend comparison test.
// Run: deno test --unstable-webgpu --no-check --allow-read tests/gpu_blend_test.ts

import { assert } from 'https://deno.land/std@0.208.0/assert/assert.ts';
import { initGPU, gpuBlend, gpuUnifiedBlend, setGpuBlendProfiling, getLastBlendProfile } from '../docs/bitzoom-gpu.js';
import { runPipeline } from '../docs/bitzoom-pipeline.js';
import { unifiedBlend, gaussianQuantize, MINHASH_K, buildGaussianProjection, STRENGTH_FLOOR_RATIO, STRENGTH_FLOOR_MIN } from '../docs/bitzoom-algo.js';

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

Deno.test('GPU blend profiling: MITRE', async () => {
  setGpuBlendProfiling(true);
  const { maxDelta } = await compareBlend('MITRE-profile', 'docs/data/mitre-attack.edges', 'docs/data/mitre-attack.nodes', 0.5,
    { group: 5, label: 0, structure: 0, neighbors: 0, subtype: 0, killchain: 4, aliases: 0, level: 0, platforms: 6, edgetype: 0 });
  const profile = getLastBlendProfile();
  setGpuBlendProfiling(false);
  assert(maxDelta < 0.01, `Max delta ${maxDelta} should be < 0.01`);
  assert(profile, 'Profile should exist');
  assert(profile.totalMs > 0, 'Total should be positive');
  assert(profile.N === 4736, `N should be 4736, got ${profile.N}`);
  console.log('Profile:', JSON.stringify(profile, null, 2));
});

Deno.test('GPU blend: bind group cache (consecutive blends)', async () => {
  const r1 = await compareBlend('Epstein-cache-1', 'docs/data/epstein.edges', 'docs/data/epstein.nodes', 0.75);
  const r2 = await compareBlend('Epstein-cache-2', 'docs/data/epstein.edges', 'docs/data/epstein.nodes', 0.75);
  assert(r1.maxDelta < 0.01, `Blend 1: maxDelta ${r1.maxDelta} should be < 0.01`);
  assert(r2.maxDelta < 0.01, `Blend 2: maxDelta ${r2.maxDelta} should be < 0.01`);
});

Deno.test('GPU blend: sequential blends with varying strengths', async () => {
  for (let i = 0; i < 4; i++) {
    const { maxDelta } = await compareBlend(`Seq-${i}`, 'docs/data/epstein.edges', 'docs/data/epstein.nodes', 0.75);
    assert(maxDelta < 0.01, `Blend ${i}: maxDelta ${maxDelta} should be < 0.01`);
  }
});

Deno.test('GPU vs CPU full pipeline (blend + quantize): gx/gy match', async () => {
  assert(await initGPU(), 'GPU should be available');
  const datasets = [
    { name: 'Karate', edges: 'docs/data/karate.edges', nodes: 'docs/data/karate.nodes', alpha: 0.5 },
    { name: 'Epstein', edges: 'docs/data/epstein.edges', nodes: 'docs/data/epstein.nodes', alpha: 0.75 },
    { name: 'MITRE', edges: 'docs/data/mitre-attack.edges', nodes: 'docs/data/mitre-attack.nodes', alpha: 0.5,
      strengths: { group: 5, label: 0, structure: 0, neighbors: 0, subtype: 0, killchain: 4, aliases: 0, level: 0, platforms: 6, edgetype: 0 } },
    { name: 'Amazon', gz: true, edges: 'docs/data/amazon-copurchase.edges.gz', nodes: 'docs/data/amazon-copurchase.nodes.gz', alpha: 0.5 },
  ];

  async function gunzip(path: string): Promise<string> {
    const compressed = Deno.readFileSync(path);
    const ds2 = new DecompressionStream('gzip');
    const writer = ds2.writable.getWriter();
    writer.write(compressed);
    writer.close();
    const reader = ds2.readable.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const merged = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
    let off2 = 0;
    for (const c of chunks) { merged.set(c, off2); off2 += c.length; }
    return new TextDecoder().decode(merged);
  }
  for (const ds of datasets) {
    const edgesText = (ds as any).gz ? await gunzip(ds.edges) : Deno.readTextFileSync(ds.edges);
    const nodesText = ds.nodes ? ((ds as any).gz ? await gunzip(ds.nodes) : Deno.readTextFileSync(ds.nodes)) : null;
    const result = runPipeline(edgesText, nodesText);
    const G = result.groupNames.length;

    // Build two copies of nodes with projections
    function buildNodes() {
      return result.nodeArray.map((n: any, i: number) => {
        const projections: Record<string, number[]> = {};
        for (let g = 0; g < G; g++) {
          const off = (i * G + g) * 2;
          projections[result.groupNames[g]] = [result.projBuf[off], result.projBuf[off + 1]];
        }
        return { ...n, projections, px: 0, py: 0, gx: 0, gy: 0 };
      });
    }
    const cpuNodes = buildNodes();
    const gpuNodes = buildNodes();

    const adjList: Record<string, string[]> = {};
    for (const n of cpuNodes) adjList[n.id] = [];
    for (const e of result.edges) {
      if (adjList[e.src] && adjList[e.dst]) {
        adjList[e.src].push(e.dst);
        adjList[e.dst].push(e.src);
      }
    }
    const cpuNodeIndex: Record<string, any> = {};
    for (const n of cpuNodes) cpuNodeIndex[n.id] = n;
    const gpuNodeIndex: Record<string, any> = {};
    for (const n of gpuNodes) gpuNodeIndex[n.id] = n;

    const propStrengths: Record<string, number> = ds.strengths || {};
    if (!ds.strengths) {
      for (const g of result.groupNames) propStrengths[g] = g === 'group' ? 3 : g === 'label' ? 1 : 0;
    }

    // CPU: full blend + quantize with fresh quantStats
    const cpuQuantStats = {};
    unifiedBlend(cpuNodes, result.groupNames, propStrengths, ds.alpha, adjList, cpuNodeIndex, 5, 'gaussian', cpuQuantStats);

    // GPU: full blend + quantize with fresh quantStats
    const gpuQuantStats = {};
    await gpuUnifiedBlend(gpuNodes, result.groupNames, propStrengths, ds.alpha, adjList, gpuNodeIndex, 5, 'gaussian', gpuQuantStats);

    // Compare px/py (pre-quantization values stored by gaussianQuantize)
    let maxPxDelta = 0;
    for (let i = 0; i < cpuNodes.length; i++) {
      const dx = Math.abs(gpuNodes[i].px - cpuNodes[i].px);
      const dy = Math.abs(gpuNodes[i].py - cpuNodes[i].py);
      if (dx > maxPxDelta) maxPxDelta = dx;
      if (dy > maxPxDelta) maxPxDelta = dy;
    }

    // Compare gx/gy (post-quantization grid positions)
    let gxMismatches = 0, maxGxDelta = 0;
    for (let i = 0; i < cpuNodes.length; i++) {
      const dg = Math.max(Math.abs(gpuNodes[i].gx - cpuNodes[i].gx), Math.abs(gpuNodes[i].gy - cpuNodes[i].gy));
      if (dg > maxGxDelta) maxGxDelta = dg;
      if (dg > 0) gxMismatches++;
    }

    // Compare quantStats
    const muDelta = Math.abs((gpuQuantStats as any).mx - (cpuQuantStats as any).mx) +
                    Math.abs((gpuQuantStats as any).my - (cpuQuantStats as any).my);
    const sigDelta = Math.abs((gpuQuantStats as any).sx - (cpuQuantStats as any).sx) +
                     Math.abs((gpuQuantStats as any).sy - (cpuQuantStats as any).sy);

    // Log mismatched nodes
    if (gxMismatches > 0 && gxMismatches <= 30) {
      for (let i = 0; i < cpuNodes.length; i++) {
        const dgx = gpuNodes[i].gx - cpuNodes[i].gx;
        const dgy = gpuNodes[i].gy - cpuNodes[i].gy;
        if (dgx !== 0 || dgy !== 0) {
          const dpx = gpuNodes[i].px - cpuNodes[i].px;
          const dpy = gpuNodes[i].py - cpuNodes[i].py;
          console.log(`    mismatch ${cpuNodes[i].id}: gx ${cpuNodes[i].gx}→${gpuNodes[i].gx} (Δ${dgx}), gy ${cpuNodes[i].gy}→${gpuNodes[i].gy} (Δ${dgy}), pxΔ=${dpx.toFixed(8)}, pyΔ=${dpy.toFixed(8)}`);
        }
      }
    }
    console.log(`  ${ds.name}: N=${cpuNodes.length}, maxPxDelta=${maxPxDelta.toFixed(6)}, maxGxDelta=${maxGxDelta}, gxMismatches=${gxMismatches}/${cpuNodes.length}, μΔ=${muDelta.toFixed(6)}, σΔ=${sigDelta.toFixed(6)}`);
    assert(maxPxDelta < 0.01, `${ds.name}: px delta ${maxPxDelta} should be < 0.01`);
    assert(gxMismatches < cpuNodes.length * 0.02, `${ds.name}: too many gx mismatches: ${gxMismatches}/${cpuNodes.length}`);
  }
});

Deno.test('GPU blend profiling: Amazon (367K nodes)', async () => {
  // Decompress .gz files
  async function gunzip(path: string): Promise<string> {
    const compressed = Deno.readFileSync(path);
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(compressed);
    writer.close();
    const reader = ds.readable.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const merged = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    return new TextDecoder().decode(merged);
  }

  const edgesText = await gunzip('docs/data/amazon-copurchase.edges.gz');
  const nodesText = await gunzip('docs/data/amazon-copurchase.nodes.gz');
  const result = runPipeline(edgesText, nodesText);

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

  const propStrengths: Record<string, number> = {};
  for (const g of result.groupNames) propStrengths[g] = g === 'group' ? 3 : 0;

  console.log(`  Amazon: N=${nodes.length}, E=${result.edges.length}, G=${G}`);

  // Ensure GPU is initialized (may not have run init test when filtered)
  assert(await initGPU(), 'GPU should be available');

  // Run 3 profiled blends to see warm-cache behavior
  setGpuBlendProfiling(true);
  for (let i = 0; i < 3; i++) {
    await gpuBlend(nodes, result.groupNames, propStrengths, 0.5, adjList, nodeIndexFull, 5);
    const p = getLastBlendProfile()!;
    console.log(`  Blend ${i}: total=${p.totalMs.toFixed(1)}ms anchor=${p.anchorComputeMs.toFixed(1)} csr=${p.csrBuildMs.toFixed(1)} upload=${p.bufferUploadMs.toFixed(1)} bind=${p.bindGroupCreateMs.toFixed(1)} dispatch=${p.gpuDispatchMs.toFixed(1)} readback=${p.readbackMs.toFixed(1)} deinterleave=${p.deinterleaveMs.toFixed(1)}`);
  }
  setGpuBlendProfiling(false);

  const profile = getLastBlendProfile()!;
  assert(profile.N > 300000, `Expected >300K nodes, got ${profile.N}`);
  assert(profile.totalMs > 0, 'Total should be positive');
});

