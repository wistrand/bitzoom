// Benchmark: MinHash accuracy vs speed tradeoffs.
// Measures: signature computation, Jaccard estimation, projection.

import {
  computeMinHash, computeMinHashInto, _sig, jaccardEstimate,
  buildGaussianProjection, projectWith, projectInto, MINHASH_K,
} from '../docs/bitzoom-algo.js';

function fmt(ms) { return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(1)}ms`; }

// Generate token sets
const SETS = 5000;
const universe = [];
for (let i = 0; i < 500; i++) universe.push('tok:' + i);

function randomSet(size) {
  const s = new Set();
  while (s.size < size) s.add(universe[Math.floor(Math.random() * universe.length)]);
  return [...s];
}

const sets = [];
for (let i = 0; i < SETS; i++) sets.push(randomSet(5 + Math.floor(Math.random() * 30)));

console.log(`${SETS} token sets, avg size ${(sets.reduce((s, a) => s + a.length, 0) / SETS).toFixed(1)}\n`);

// Benchmark: computeMinHash (allocating)
console.log('=== MinHash Signature ===');
const t0 = performance.now();
const sigs = sets.map(s => computeMinHash(s));
const tHash = performance.now() - t0;
console.log(`  computeMinHash (allocating): ${fmt(tHash)} for ${SETS} sets (${fmt(tHash / SETS)}/set)`);

// Benchmark: computeMinHashInto (GC-optimized)
const t1 = performance.now();
for (let i = 0; i < SETS; i++) computeMinHashInto(sets[i], sets[i].length);
const tHashInto = performance.now() - t1;
console.log(`  computeMinHashInto (reuse _sig): ${fmt(tHashInto)} (${fmt(tHashInto / SETS)}/set)`);
console.log(`  Speedup: ${(tHash / tHashInto).toFixed(1)}x`);

// Benchmark: Jaccard estimation
console.log('\n=== Jaccard Estimation ===');
const PAIRS = 50000;
const t2 = performance.now();
let sumJ = 0;
for (let i = 0; i < PAIRS; i++) {
  const a = sigs[Math.floor(Math.random() * SETS)];
  const b = sigs[Math.floor(Math.random() * SETS)];
  sumJ += jaccardEstimate(a, b);
}
const tJaccard = performance.now() - t2;
console.log(`  ${PAIRS} estimates: ${fmt(tJaccard)} (${(tJaccard / PAIRS * 1e6).toFixed(0)}ns/pair)`);
console.log(`  Mean J: ${(sumJ / PAIRS).toFixed(4)}`);

// Benchmark: projection
console.log('\n=== Gaussian Projection ===');
const ROT = buildGaussianProjection(42, MINHASH_K);
const buf = new Float64Array(2);

const t3 = performance.now();
for (let i = 0; i < SETS; i++) projectInto(sigs[i], ROT, buf, 0);
const tProj = performance.now() - t3;
console.log(`  projectInto: ${fmt(tProj)} for ${SETS} sigs (${(tProj / SETS * 1e6).toFixed(0)}ns/sig)`);

const t4 = performance.now();
for (let i = 0; i < SETS; i++) projectWith(sigs[i], ROT);
const tProjAlloc = performance.now() - t4;
console.log(`  projectWith (allocating): ${fmt(tProjAlloc)} (${(tProjAlloc / SETS * 1e6).toFixed(0)}ns/sig)`);
console.log(`  Speedup: ${(tProjAlloc / tProj).toFixed(1)}x`);

// Benchmark: empty token handling
console.log('\n=== Empty Token Sentinel ===');
const t5 = performance.now();
for (let i = 0; i < 100000; i++) computeMinHashInto([], 0);
const tEmpty = performance.now() - t5;
console.log(`  100K empty signatures: ${fmt(tEmpty)} (${(tEmpty / 100000 * 1e6).toFixed(0)}ns/call)`);
