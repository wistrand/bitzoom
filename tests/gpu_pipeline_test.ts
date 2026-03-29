// GPU vs CPU pipeline comparison test.
// Run: deno test --unstable-webgpu --no-check --allow-read tests/gpu_pipeline_test.ts

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/assert_equals.ts';
import { assertAlmostEquals } from 'https://deno.land/std@0.208.0/assert/assert_almost_equals.ts';
import { assert } from 'https://deno.land/std@0.208.0/assert/assert.ts';

import { initGPU, computeProjectionsGPU } from '../docs/bitzoom-gpu.js';
import { runPipeline, runPipelineGPU } from '../docs/bitzoom-pipeline.js';
import { MINHASH_K } from '../docs/bitzoom-algo.js';

Deno.test('GPU pipeline init', async () => {
  assert(await initGPU(), 'GPU should be available');
});

Deno.test('GPU vs CPU pipeline: BitZoom Source dataset', async () => {
  const edgesText = Deno.readTextFileSync('docs/data/bitzoom-source.edges');
  const nodesText = Deno.readTextFileSync('docs/data/bitzoom-source.nodes');

  const cpuResult = runPipeline(edgesText, nodesText);
  const gpuResult = await runPipelineGPU(edgesText, nodesText, computeProjectionsGPU);

  // Same structure
  assertEquals(cpuResult.nodeArray.length, gpuResult.nodeArray.length, 'node count');
  assertEquals(cpuResult.edges.length, gpuResult.edges.length, 'edge count');
  assertEquals(cpuResult.groupNames.length, gpuResult.groupNames.length, 'group count');
  for (let i = 0; i < cpuResult.groupNames.length; i++) {
    assertEquals(cpuResult.groupNames[i], gpuResult.groupNames[i], `group name ${i}`);
  }

  // Compare projections
  const N = cpuResult.nodeArray.length;
  const G = cpuResult.groupNames.length;
  let maxDelta = 0;
  let mismatches = 0;
  const tolerance = 0.01; // float32 vs float64 projection

  for (let i = 0; i < N; i++) {
    for (let g = 0; g < G; g++) {
      const off = (i * G + g) * 2;
      const cpuPx = cpuResult.projBuf[off];
      const gpuPx = gpuResult.projBuf[off];
      const cpuPy = cpuResult.projBuf[off + 1];
      const gpuPy = gpuResult.projBuf[off + 1];

      const dx = Math.abs(cpuPx - gpuPx);
      const dy = Math.abs(cpuPy - gpuPy);
      const delta = Math.max(dx, dy);
      if (delta > maxDelta) maxDelta = delta;
      if (delta > tolerance) mismatches++;
    }
  }

  console.log(`  Nodes: ${N}, Groups: ${G}, Total projections: ${N * G}`);
  console.log(`  Max delta: ${maxDelta.toFixed(6)}`);
  console.log(`  Mismatches (> ${tolerance}): ${mismatches} / ${N * G}`);

  // Allow small float32/float64 rounding differences but no large divergences
  assert(maxDelta < 0.1, `Max delta ${maxDelta} should be < 0.1`);
  assert(mismatches < N * G * 0.01, `Too many mismatches: ${mismatches}`);
});

Deno.test('GPU vs CPU pipeline: Epstein dataset', async () => {
  const edgesText = Deno.readTextFileSync('docs/data/epstein.edges');
  const nodesText = Deno.readTextFileSync('docs/data/epstein.nodes');

  const cpuResult = runPipeline(edgesText, nodesText);
  const gpuResult = await runPipelineGPU(edgesText, nodesText, computeProjectionsGPU);

  const N = cpuResult.nodeArray.length;
  const G = cpuResult.groupNames.length;
  let maxDelta = 0;
  let mismatches = 0;

  for (let i = 0; i < N; i++) {
    for (let g = 0; g < G; g++) {
      const off = (i * G + g) * 2;
      const dx = Math.abs(cpuResult.projBuf[off] - gpuResult.projBuf[off]);
      const dy = Math.abs(cpuResult.projBuf[off + 1] - gpuResult.projBuf[off + 1]);
      const delta = Math.max(dx, dy);
      if (delta > maxDelta) maxDelta = delta;
      if (delta > 0.01) mismatches++;
    }
  }

  console.log(`  Nodes: ${N}, Groups: ${G}`);
  console.log(`  Max delta: ${maxDelta.toFixed(6)}`);
  console.log(`  Mismatches (> 0.01): ${mismatches} / ${N * G}`);
  assert(maxDelta < 0.1, `Max delta ${maxDelta} should be < 0.1`);
});

Deno.test('GPU vs CPU pipeline: Karate dataset', async () => {
  const edgesText = Deno.readTextFileSync('docs/data/karate.edges');
  const nodesText = Deno.readTextFileSync('docs/data/karate.nodes');

  const cpuResult = runPipeline(edgesText, nodesText);
  const gpuResult = await runPipelineGPU(edgesText, nodesText, computeProjectionsGPU);

  const N = cpuResult.nodeArray.length;
  const G = cpuResult.groupNames.length;
  let maxDelta = 0;

  for (let i = 0; i < N * G * 2; i++) {
    const delta = Math.abs(cpuResult.projBuf[i] - gpuResult.projBuf[i]);
    if (delta > maxDelta) maxDelta = delta;
  }

  console.log(`  Nodes: ${N}, Groups: ${G}, Max delta: ${maxDelta.toFixed(6)}`);
  assert(maxDelta < 0.1, `Max delta ${maxDelta} should be < 0.1`);
});

Deno.test('GPU vs CPU pipeline: MITRE ATT&CK dataset', async () => {
  const edgesText = Deno.readTextFileSync('docs/data/mitre-attack.edges');
  const nodesText = Deno.readTextFileSync('docs/data/mitre-attack.nodes');

  const cpuResult = runPipeline(edgesText, nodesText);
  const gpuResult = await runPipelineGPU(edgesText, nodesText, computeProjectionsGPU);

  const N = cpuResult.nodeArray.length;
  const G = cpuResult.groupNames.length;
  let maxDelta = 0;
  let mismatches = 0;

  for (let i = 0; i < N; i++) {
    for (let g = 0; g < G; g++) {
      const off = (i * G + g) * 2;
      const dx = Math.abs(cpuResult.projBuf[off] - gpuResult.projBuf[off]);
      const dy = Math.abs(cpuResult.projBuf[off + 1] - gpuResult.projBuf[off + 1]);
      const delta = Math.max(dx, dy);
      if (delta > maxDelta) maxDelta = delta;
      if (delta > 0.01) mismatches++;
    }
  }

  console.log(`  Nodes: ${N}, Groups: ${G}`);
  console.log(`  Max delta: ${maxDelta.toFixed(6)}`);
  console.log(`  Mismatches (> 0.01): ${mismatches} / ${N * G}`);
  assert(maxDelta < 0.1, `Max delta ${maxDelta} should be < 0.1`);
});
