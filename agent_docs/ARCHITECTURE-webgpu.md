# WebGPU Architecture

Implementation of WebGPU compute acceleration for BitZoom's MinHash projection
and topology blend pipelines. Falls back to CPU (Web Workers) when WebGPU is
unavailable.

## Files

| File | Role |
| --- | --- |
| [bitzoom-gpu.js](../docs/bitzoom-gpu.js) | WebGPU compute: MinHash+projection, blend, initialization |
| [tests/gpu_test.ts](../tests/gpu_test.ts) | Unit tests: hashSlot precision, OPH, similarity |
| [tests/gpu_pipeline_test.ts](../tests/gpu_pipeline_test.ts) | Pipeline comparison: GPU vs CPU projections across datasets |
| [tests/gpu_blend_test.ts](../tests/gpu_blend_test.ts) | Blend comparison: GPU vs CPU across datasets and alpha values |
| [gpu-test.html](../docs/gpu-test.html) | Visual side-by-side comparison page |
| [scripts/bench-gpu.js](../scripts/bench-gpu.js) | GPU vs CPU performance benchmark |

## Initialization

At viewer startup (bootstrap in `bitzoom-viewer.js`):

```
await initGPU()
  → navigator.gpu.requestAdapter()
  → adapter.requestDevice()
  → compile MinHash WGSL shader → create pipeline
  → set bz._useGPU = true, bz.view._useGPU = true
```

If any step fails, `_gpuUnavailable = true`, GPU button shows "N/A", all
operations use CPU. The probe completes before the first dataset load.

For embedded views, `createBitZoomView` accepts `autoGPU: true` (default) to
auto-enable WebGPU when N×G > 2000. The factory returns synchronously; initial
blend kicks off async (GPU probe → blend → render). GPU kicks in for the
initial blend and subsequent interactive changes once initialization completes.

## Projection: GPU vs CPU selection

The quantization mode determines which projection path is used:

| quantMode | Projection | Reason |
| --- | --- | --- |
| gaussian (default) | GPU (float32) | Gaussian maps continuously; float32 precision sufficient |
| rank | CPU (float64) | Rank sort is sensitive to tiny ordering changes; float32 causes visible cell jumps |

Decision is made per-dataset at load time in `loadGraphGPU()`, based on
`dataset.settings.quantMode`. File uploads (no dataset settings) default to
gaussian → GPU projections.

### GPU projection pipeline

```
CPU: tokenize strings → hash to uint32 (per node × per group)
GPU: MinHash signatures → z-score normalize → 2D Gaussian projection
CPU: unpack Float32Array result into projBuf
```

WGSL shader (`WGSL` constant in bitzoom-gpu.js), workgroup size 256:
- `mulMod(a, b)`: overflow-safe `(a*b) mod P` via 16-bit half splitting with
  per-addition `mersMod` reduction. Matches CPU `hashSlot` exactly.
- Standard MinHash for <12 tokens (k hash evaluations per token)
- OPH+DOPH for ≥12 tokens (single hash per token + densification)
- Degenerate signature detection (`sd < mean*1e-5 || sd < 1.0` → neutral [0,0])
- 5 storage buffers: tokens, taskMeta (packed offset+count+group), hashParams
  (A+B concatenated), projMatrix, output
- Workgroup size 256 supports up to 16.7M tasks (1M nodes × 16 groups) within the 65535 dispatch limit

### Verified precision

| Dataset | Nodes | Groups | Max delta | Mismatches |
| --- | ---: | ---: | ---: | ---: |
| Karate | 34 | 4 | 0.000031 | 0 |
| Epstein | 364 | 5 | 0.003945 | 0 |
| BZ Source | 433 | 10 | 0.000183 | 0 |
| MITRE | 4,736 | 10 | 0.000053 | 0 |

## Blend

`gpuUnifiedBlend` is a drop-in replacement for `unifiedBlend`. Same signature,
modifies nodes in place, runs quantization on CPU after GPU blend.

### GPU blend pipeline

```
CPU: compute property anchors from projections + effective weights
CPU: build CSR adjacency (adjOffsets, adjTargets)
GPU: 5 passes of neighbor averaging with ping-pong buffers
CPU: quantize (gaussianQuantize or normalizeAndQuantize)
```

WGSL shader (`BLEND_WGSL`), workgroup size 64:
- Reads interleaved property anchors (propAnchors), adjacency (CSR), current positions
- Writes blended positions to separate output buffer (no read-write race)
- All passes batched in a single command encoder (one `submit()` call)
- 6 bindings: propAnchors, adjOffsets, adjTargets, posIn, posOut, params(uniform)

### Ping-pong buffers

Two position buffers (A and B) alternate as read/write targets across passes:
- Pass 0: read A → write B
- Pass 1: read B → write A
- Pass 2: read A → write B
- ...
- Final result in buffer (passes%2==1 ? B : A)

Eliminates the read-write race that caused 1.9-6.7 delta in the initial
single-buffer implementation.

### Verified precision

| Dataset | Alpha | Max delta | Mismatches |
| --- | ---: | ---: | ---: |
| Karate | 0.0 | 0.000000 | 0 |
| Karate | 0.5 | 0.000001 | 0 |
| Karate | 1.0 | 0.000001 | 0 |
| Epstein | 0.75 | 0.000001 | 0 |
| BZ Source | 0.5 | 0.000001 | 0 |
| MITRE | 0.5 | 0.000001 | 0 |
| Email-EU | 0.75 | 0.000004 | 0 |

## Data loading paths

### Path A: CPU Worker (GPU off, or fallback)

```
loadDataset → loadGraph → Web Worker (runPipeline) → _applyWorkerResult
  → CPU unifiedBlend → _finalizeLoad → resize/render
```

### Path B: GPU Main-Thread (GPU on)

```
loadDataset → loadGraphGPU:
  1. Parse edges (CPU, yield)
  2. Parse nodes (CPU, yield)
  3. Build graph (CPU, yield)
  4. Project (GPU if gaussian, CPU if rank, yield)
  5. _applyWorkerResult (skip CPU blend since _useGPU=true)
  → _finalizeLoad → await v._blend() (GPU) → resize/render
```

### Path C: Embedded (createBitZoomView)

```
runPipeline (CPU) → create view → return immediately (sync)
  async: initGPU() → GPU probe → blend → quantize → render
  (autoGPU: true by default, enables GPU when N×G > 2000)
```

## GPU tri-state (viewer)

The GPU button cycles through three states: **Auto** (default) → **GPU** → **CPU**.

- **Auto**: adaptive thresholds — GPU projection when N×G > 2000, GPU blend when N > 50K.
- **GPU**: forces all operations to GPU (projection + blend).
- **CPU**: forces all operations to CPU (Web Workers + synchronous blend).

**GPU/Auto → CPU:**
```
_useGPU = false, v._useGPU = false
→ _reloadCPU() → CPU re-project → await rebuildProjections()
```
Preserves current strengths/bearings/alpha/level/zoom. No auto-tune trigger.

**CPU → Auto/GPU:**
```
await initGPU()
→ _useGPU = true, v._useGPU = true
→ _applyGPUToCurrentData() → GPU re-project → await rebuildProjections()
```
Both paths mirror each other: re-project with the target pipeline, preserve user settings.

**New dataset load while GPU on:**
```
loadGraphGPU (GPU projection if gaussian) → _finalizeLoad → GPU blend
```

## Auto-tune integration

**Status:** `autoTuneStrengths` accepts a `blendFn` option (defaults to CPU `unifiedBlend`).
`blendAndScore` ([bitzoom-utils.js](../docs/bitzoom-utils.js):125) calls `blendFn` for each
evaluation. The viewer does not pass a custom `blendFn`, so auto-tune always uses CPU blend.

### Blend count per auto-tune run

With G tunable groups, 4 weight values (`[0,3,8,10]`), 5 alpha values:
- Presets: (G+1) × 5 alphas + 1 interaction × 5 alphas ≈ 5G+10
- Descent: up to 3 rounds × (G×4 + 5) ≈ 12G+15
- Typical total: 50–80 blends depending on G and early stopping

### GPU blend impact on auto-tune

| Dataset        | Nodes   | Blends | CPU total | GPU total | Effect    |
| -------------- | ------: | -----: | --------: | --------: | --------- |
| MITRE ATT&CK  |   4,736 |    ~70 |    ~0.9s  |    ~2.4s  | 2.7x slower |
| Amazon         | 367,000 |    ~50 |     ~94s  |     ~20s  | 4.7x faster |

At MITRE scale, GPU blend would hurt auto-tune. At Amazon scale, GPU blend
is essential — CPU auto-tune exceeds the 20s timeout. An adaptive threshold
(GPU blend only when N > ~50K) would fix both cases.

### Adaptive GPU/CPU selection

Implemented in `_blend()` (bitzoom-canvas.js) and `loadGraphGPU()` (bitzoom-viewer.js).
Viewer GPU button cycles Auto → GPU → CPU. Auto uses adaptive thresholds:

| Operation  | Auto GPU when                           | Reason                                              |
| ---------- | --------------------------------------- | --------------------------------------------------- |
| Projection | N×G > 2000 and quantMode ≠ rank        | GPU crossover ~400 nodes; rank quant needs float64   |
| Blend      | N > 50,000                              | GPU has ~13ms fixed overhead; only faster at scale   |

Auto-tune always uses CPU blend (synchronous `blendAndScore`). The `blendFn`
option is available for future async GPU auto-tune but not wired up — CPU is
faster for the 50–80 blend evaluations at all but Amazon scale.

## Async discipline

All GPU operations (`gpuMinHashProject`, `gpuBlend`, `gpuUnifiedBlend`) are
async and properly awaited at every call site:

- `rebuildProjections()`: async, awaits `_blend()`
- `_finalizeLoad()`: async rAF, awaits blend and dataset settings
- `_applyDatasetSettings()`: async, awaits `rebuildProjections()`
- `_scheduleRebuild()`: async timer, awaits `rebuildProjections()`
- `applyTuneResult()`: async, awaits `rebuildProjections()`
- `setWeights()` / `setAlpha()`: fire `.then()` chain (intentional for
  interactive responsiveness; debounced at 150ms)

## Buffer management

**Projection buffers** are created per-operation and destroyed after readback.

**Blend buffers** are cached across blend calls via `getBlendCache(N, totalEdges)`. Invalidated when dataset changes (different N or edge count). The cache stores:
- **GPU buffers**: `propAnchors` (interleaved px/py), `adjOffsets`/`adjTargets` (CSR), `posA`/`posB` (ping-pong), `params` (uniform), `read` (MAP_READ)
- **Bind groups**: `bgAtoB`/`bgBtoA` — cached alongside buffers, only recreated on cache invalidation
- **CSR arrays**: `csrOffsets`/`csrTargets` — CPU-side typed arrays cached to skip the ~200ms CSR rebuild on subsequent blends with the same dataset
- **Adjacency upload flag**: `adjUploaded` — adjacency uploaded to GPU once per dataset

Minimum buffer size: 256 bytes (GPU alignment requirement — smaller buffers cause silent bind group failures).

## Testing

```sh
deno task test          # 48 CPU pipeline tests
deno task test:gpu      # 21 GPU tests (run sequentially per file)
```

GPU tests run in separate processes to avoid cross-file device state
interference (Deno's WebGPU implementation shares module-level device state
across test files in the same process).

## Performance

Benchmarked with `scripts/bench-gpu.js` on Intel integrated GPU (Arc A-series).
Median of 5 runs after 2 warmup (1 run for Amazon).

### Projection (tokenize + MinHash + project)

| Dataset        | Nodes   | Groups | CPU     | GPU    | Speedup |
| -------------- | ------: | -----: | ------: | -----: | ------: |
| Karate Club    |      34 |      4 |  1.5ms  |  18ms  |   0.08x |
| Epstein        |     364 |      5 |   20ms  |  19ms  |   1.1x  |
| BitZoom Source |     433 |     10 |   24ms  |  19ms  |   1.2x  |
| Synth Packages |   1,868 |      8 |   85ms  |  22ms  |   3.9x  |
| MITRE ATT&CK  |   4,736 |     10 |  358ms  |  61ms  |   5.9x  |
| Amazon         | 367,000 |      4 | 24.1s   |  1.7s  |  14.3x  |

GPU crossover ~400 nodes. GPU time includes CPU-side tokenization and hashing.

### Blend (α=0.5, 5 passes, gaussian)

| Dataset        | Nodes   | CPU     | GPU    | Speedup |
| -------------- | ------: | ------: | -----: | ------: |
| Karate Club    |      34 | 139µs   |  13ms  |   0.01x |
| Epstein        |     364 |  0.8ms  |  14ms  |   0.06x |
| BitZoom Source |     433 |  1.3ms  |  14ms  |   0.10x |
| Synth Packages |   1,868 |  2.4ms  |  17ms  |   0.15x |
| MITRE ATT&CK  |   4,736 |   13ms  |  34ms  |   0.40x |
| Amazon         | 367,000 |  1.88s  | 407ms  |   4.6x  |

GPU blend warm overhead: ~30ms on iGPU (anchor compute + upload + dispatch + readback). CSR build ~200ms on first call, 0ms on subsequent (cached). See [PLAN-gpu-resident.md](PLAN-gpu-resident.md) for full profiling breakdown.
Crossover between 5K and 367K nodes. Projection benefits first; blend benefits
only at large scale.

## Known limitations

- GPU projections use float32. With rank quantization, this causes visible
  layout differences (gx delta up to 5000+). Mitigated by using GPU projections
  only with gaussian quantization.
- OPH path degenerate case (all tokens identical) produces near-zero but
  non-zero variance in float32. Detected via `sd < mean*1e-5 || sd < 1.0`
  threshold and mapped to neutral [0,0].
- GPU blend uses float32 positions. Max delta vs CPU float64 is 0.000004 —
  invisible after quantization.
- WebGPU not available in Firefox (requires `dom.webgpu.enabled` in about:config)
  or older browsers. Falls back to CPU transparently.
- Large datasets (367K+ nodes) on the GPU path run CPU projection on the main
  thread when rank quant is selected, blocking the browser. Worker path is
  preferred for rank quant.
