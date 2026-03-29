// GPU MinHash + Projection tests.
// Run: deno test --unstable-webgpu --no-check --allow-read tests/gpu_test.ts

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/assert_equals.ts';
import { assertAlmostEquals } from 'https://deno.land/std@0.208.0/assert/assert_almost_equals.ts';
import { assert } from 'https://deno.land/std@0.208.0/assert/assert.ts';

import { initGPU, gpuMinHashProject, destroyGPU } from '../docs/bitzoom-gpu.js';
import {
  MINHASH_K, HASH_PARAMS_A, HASH_PARAMS_B, LARGE_PRIME,
  hashToken, computeMinHashInto, _sig, buildGaussianProjection, projectInto, mulberry32,
} from '../docs/bitzoom-algo.js';

// ─── Helper: build GPU input from string tokens ─────────────────────────────

function buildGPUInput(tokenSets: string[][], groupProjections: Float64Array[][]) {
  // Hash all tokens, build flat array + offsets/counts
  const allHashed: number[] = [];
  const offsets: number[] = [];
  const counts: number[] = [];
  const groups: number[] = [];

  const G = groupProjections.length;

  for (let g = 0; g < G; g++) {
    for (const tokens of tokenSets) {
      offsets.push(allHashed.length);
      counts.push(tokens.length);
      groups.push(g);
      for (const t of tokens) allHashed.push(hashToken(t));
    }
  }

  // Build projection matrix: G × 2 × K as Float32Array
  const projFlat = new Float32Array(G * 2 * MINHASH_K);
  for (let g = 0; g < G; g++) {
    const R = groupProjections[g];
    for (let i = 0; i < MINHASH_K; i++) {
      projFlat[g * 2 * MINHASH_K + i] = R[0][i];
      projFlat[g * 2 * MINHASH_K + MINHASH_K + i] = R[1][i];
    }
  }

  return {
    allTokens: new Uint32Array(allHashed),
    taskOffsets: new Uint32Array(offsets),
    taskCounts: new Uint32Array(counts),
    taskGroups: new Uint32Array(groups),
    projMatrices: projFlat,
    numNodes: tokenSets.length,
    G,
  };
}

// CPU reference: compute MinHash + project for one token set with one projection
function cpuMinHashProject(tokens: string[], proj: Float64Array[]): [number, number] {
  const hashed = tokens.map(t => hashToken(t));
  // Use the allocating version
  computeMinHashInto(hashed.map(String), 0); // trick: we need to use the raw hash path

  // Actually, let's do it properly with the string tokens
  const buf = new Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) buf[i] = tokens[i];
  computeMinHashInto(buf, tokens.length);

  const outBuf = [0, 0];
  projectInto(_sig, proj, outBuf, 0);
  return [outBuf[0], outBuf[1]];
}

// ─── Tests ───────────────────────────────────────────────────────────────────

Deno.test('initGPU succeeds', async () => {
  destroyGPU(); // reset in case other test files left stale state
  const ok = await initGPU();
  assert(ok, 'GPU should be available');
});

Deno.test('GPU MinHash matches CPU for single token', async () => {
  const proj = buildGaussianProjection(2001, MINHASH_K);
  const tokens = [['group:Person']];
  const input = buildGPUInput(tokens, [proj]);

  const gpuResult = await gpuMinHashProject(
    input.allTokens, input.taskOffsets, input.taskCounts, input.taskGroups, input.projMatrices
  );

  const [cpuPx, cpuPy] = cpuMinHashProject(['group:Person'], proj);

  // GPU uses float32, CPU uses float64 — allow tolerance
  assertAlmostEquals(gpuResult[0], cpuPx, 0.05);
  assertAlmostEquals(gpuResult[1], cpuPy, 0.05);
});

Deno.test('GPU MinHash matches CPU for multiple tokens', async () => {
  const proj = buildGaussianProjection(2001, MINHASH_K);
  const tokens = [['label:jeffrey', 'label:epstein', 'label:network']];
  const input = buildGPUInput(tokens, [proj]);

  const gpuResult = await gpuMinHashProject(
    input.allTokens, input.taskOffsets, input.taskCounts, input.taskGroups, input.projMatrices
  );

  const [cpuPx, cpuPy] = cpuMinHashProject(['label:jeffrey', 'label:epstein', 'label:network'], proj);

  assertAlmostEquals(gpuResult[0], cpuPx, 0.05);
  assertAlmostEquals(gpuResult[1], cpuPy, 0.05);
});

Deno.test('GPU handles empty token set (neutral [0,0])', async () => {
  const proj = buildGaussianProjection(2001, MINHASH_K);
  const tokens: string[][] = [[]];
  const input = buildGPUInput(tokens, [proj]);

  const gpuResult = await gpuMinHashProject(
    input.allTokens, input.taskOffsets, input.taskCounts, input.taskGroups, input.projMatrices
  );

  assertEquals(gpuResult[0], 0);
  assertEquals(gpuResult[1], 0);
});

Deno.test('GPU handles multiple nodes in parallel', async () => {
  const proj = buildGaussianProjection(2001, MINHASH_K);
  const tokenSets = [
    ['group:Person'],
    ['group:Organization'],
    ['group:Person'],
    [],
    ['label:alice', 'label:bob', 'label:charlie'],
  ];
  const input = buildGPUInput(tokenSets, [proj]);

  const gpuResult = await gpuMinHashProject(
    input.allTokens, input.taskOffsets, input.taskCounts, input.taskGroups, input.projMatrices
  );

  // Check each node against CPU
  for (let i = 0; i < tokenSets.length; i++) {
    const [cpuPx, cpuPy] = cpuMinHashProject(tokenSets[i], proj);
    assertAlmostEquals(gpuResult[i * 2], cpuPx, 0.05, `node ${i} px`);
    assertAlmostEquals(gpuResult[i * 2 + 1], cpuPy, 0.05, `node ${i} py`);
  }
});

Deno.test('GPU handles multiple groups', async () => {
  const proj0 = buildGaussianProjection(2001, MINHASH_K);
  const proj1 = buildGaussianProjection(2002, MINHASH_K);
  const tokenSets = [
    ['group:Person'],
    ['group:Organization'],
  ];
  const input = buildGPUInput(tokenSets, [proj0, proj1]);

  const gpuResult = await gpuMinHashProject(
    input.allTokens, input.taskOffsets, input.taskCounts, input.taskGroups, input.projMatrices
  );

  // Group 0 results (first N tasks)
  const N = tokenSets.length;
  for (let i = 0; i < N; i++) {
    const [cpuPx, cpuPy] = cpuMinHashProject(tokenSets[i], proj0);
    assertAlmostEquals(gpuResult[i * 2], cpuPx, 0.05, `group0 node ${i} px`);
    assertAlmostEquals(gpuResult[i * 2 + 1], cpuPy, 0.05, `group0 node ${i} py`);
  }

  // Group 1 results (next N tasks)
  for (let i = 0; i < N; i++) {
    const [cpuPx, cpuPy] = cpuMinHashProject(tokenSets[i], proj1);
    assertAlmostEquals(gpuResult[(N + i) * 2], cpuPx, 0.05, `group1 node ${i} px`);
    assertAlmostEquals(gpuResult[(N + i) * 2 + 1], cpuPy, 0.05, `group1 node ${i} py`);
  }
});

Deno.test('GPU OPH path (>=12 tokens) produces non-zero output and similar tokens cluster', async () => {
  const proj = buildGaussianProjection(2001, MINHASH_K);
  // Two similar token sets (18/20 overlap) and one different
  const tokensA = []; const tokensB = []; const tokensC = [];
  for (let i = 0; i < 20; i++) tokensA.push(`ngroup:type_${i}`);
  for (let i = 0; i < 18; i++) tokensB.push(`ngroup:type_${i}`);
  tokensB.push('ngroup:type_90', 'ngroup:type_91');
  for (let i = 0; i < 20; i++) tokensC.push(`ngroup:other_${i}`);
  const tokenSets = [tokensA, tokensB, tokensC];
  const input = buildGPUInput(tokenSets, [proj]);

  const gpuResult = await gpuMinHashProject(
    input.allTokens, input.taskOffsets, input.taskCounts, input.taskGroups, input.projMatrices
  );

  // Non-zero output
  assert(gpuResult[0] !== 0 || gpuResult[1] !== 0, 'OPH should produce non-zero output');

  // Similar sets (A, B) should be closer than dissimilar (A, C)
  const dist = (i: number, j: number) => {
    const dx = gpuResult[i * 2] - gpuResult[j * 2];
    const dy = gpuResult[i * 2 + 1] - gpuResult[j * 2 + 1];
    return Math.sqrt(dx * dx + dy * dy);
  };
  const abDist = dist(0, 1);
  const acDist = dist(0, 2);
  assert(abDist < acDist, `Similar sets (A,B) dist ${abDist} should be < different (A,C) dist ${acDist}`);
});

Deno.test('GPU similar nodes project to nearby points', async () => {
  const proj = buildGaussianProjection(2001, MINHASH_K);
  const tokenSets = [
    ['group:Person', 'label:alice'],
    ['group:Person', 'label:bob'],
    ['group:Organization', 'label:megacorp'],
  ];
  const input = buildGPUInput(tokenSets, [proj]);

  const gpuResult = await gpuMinHashProject(
    input.allTokens, input.taskOffsets, input.taskCounts, input.taskGroups, input.projMatrices
  );

  // Distance between two Person nodes should be < distance to Organization node
  const dist = (i: number, j: number) => {
    const dx = gpuResult[i * 2] - gpuResult[j * 2];
    const dy = gpuResult[i * 2 + 1] - gpuResult[j * 2 + 1];
    return Math.sqrt(dx * dx + dy * dy);
  };

  const personPerson = dist(0, 1);
  const personOrg = dist(0, 2);
  assert(personPerson < personOrg, `Person-Person dist (${personPerson}) should be < Person-Org dist (${personOrg})`);
});

// Note: don't destroy GPU here — other test files share the device.
