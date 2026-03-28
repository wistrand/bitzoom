const LARGE_PRIME = 2147483647;
const MINHASH_K = 128;

// Generate hash params
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(42);
const HASH_PARAMS_A = new Int32Array(MINHASH_K);
const HASH_PARAMS_B = new Int32Array(MINHASH_K);
for (let i = 0; i < MINHASH_K; i++) {
  HASH_PARAMS_A[i] = Math.floor(rng() * (LARGE_PRIME - 1)) + 1;
  HASH_PARAMS_B[i] = Math.floor(rng() * (LARGE_PRIME - 1));
}

// hashToken (shared)
function hashToken(token) {
  let h = 0;
  for (let i = 0; i < token.length; i++) {
    h = (Math.imul(31, h) + token.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

// ── Original: general % ──
function hashSlotOld(a, tv, b) {
  const tvHi = (tv >>> 16), tvLo = tv & 0xFFFF;
  return ((a * tvHi % LARGE_PRIME) * 0x10000 + a * tvLo + b) % LARGE_PRIME;
}

function computeMinHashOld(tokens) {
  const sig = new Float64Array(MINHASH_K);
  sig.fill(LARGE_PRIME);
  for (let t = 0; t < tokens.length; t++) {
    const tv = hashToken(tokens[t]);
    for (let j = 0; j < MINHASH_K; j++) {
      const hv = hashSlotOld(HASH_PARAMS_A[j], tv, HASH_PARAMS_B[j]);
      if (hv < sig[j]) sig[j] = hv;
    }
  }
  return sig;
}

// ── New: Mersenne fast-mod ──
function mersMod(x) {
  x = (x & LARGE_PRIME) + ((x / 0x80000000) | 0);
  return x >= LARGE_PRIME ? x - LARGE_PRIME : x;
}

function hashSlotNew(a, tv, b) {
  const tvHi = (tv >>> 16), tvLo = tv & 0xFFFF;
  const hi = mersMod(a * tvHi);
  return mersMod(hi * 0x10000 + a * tvLo + b);
}

function computeMinHashNew(tokens) {
  const sig = new Float64Array(MINHASH_K);
  sig.fill(LARGE_PRIME);
  for (let t = 0; t < tokens.length; t++) {
    const tv = hashToken(tokens[t]);
    for (let j = 0; j < MINHASH_K; j++) {
      const hv = hashSlotNew(HASH_PARAMS_A[j], tv, HASH_PARAMS_B[j]);
      if (hv < sig[j]) sig[j] = hv;
    }
  }
  return sig;
}

// ── Generate test data ──
const NODES = 5000;
const TOKENS_PER_NODE = 6;
const tokenSets = [];
for (let i = 0; i < NODES; i++) {
  const tokens = [];
  for (let t = 0; t < TOKENS_PER_NODE; t++) {
    tokens.push("group:" + ((Math.random() * 50) | 0) + "_tok" + ((Math.random() * 200) | 0));
  }
  tokenSets.push(tokens);
}

// ── Warmup ──
for (let i = 0; i < 200; i++) { computeMinHashOld(tokenSets[i % NODES]); }
for (let i = 0; i < 200; i++) { computeMinHashNew(tokenSets[i % NODES]); }

// ── Benchmark ──
const RUNS = 5;

for (let run = 0; run < RUNS; run++) {
  const t0 = performance.now();
  for (let i = 0; i < NODES; i++) computeMinHashOld(tokenSets[i]);
  const oldMs = performance.now() - t0;

  const t1 = performance.now();
  for (let i = 0; i < NODES; i++) computeMinHashNew(tokenSets[i]);
  const newMs = performance.now() - t1;

  const speedup = ((oldMs - newMs) / oldMs * 100).toFixed(1);
  console.log(`Run ${run+1}: old=${oldMs.toFixed(1)}ms  new=${newMs.toFixed(1)}ms  speedup=${speedup}%`);
}

// Total hash slot evaluations: NODES * TOKENS_PER_NODE * MINHASH_K
const totalSlots = NODES * TOKENS_PER_NODE * MINHASH_K;
console.log(`\nTotal hashSlot evaluations per run: ${totalSlots.toLocaleString()}`);
