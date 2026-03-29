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

For embedded views (`createBitZoomView` with `useGPU: true`), GPU init is
async and non-blocking. The initial render uses CPU; GPU kicks in for
subsequent interactive changes once initialization completes.

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

WGSL shader (`WGSL` constant in bitzoom-gpu.js):
- `mulMod(a, b)`: overflow-safe `(a*b) mod P` via 16-bit half splitting with
  per-addition `mersMod` reduction. Matches CPU `hashSlot` exactly.
- Standard MinHash for <12 tokens (k hash evaluations per token)
- OPH+DOPH for ≥12 tokens (single hash per token + densification)
- Degenerate signature detection (`sd < mean*1e-5 || sd < 1.0` → neutral [0,0])
- 5 storage buffers: tokens, taskMeta (packed offset+count+group), hashParams
  (A+B concatenated), projMatrix, output

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

WGSL shader (`BLEND_WGSL`):
- Reads property anchors (propPx, propPy), adjacency (CSR), current positions
- Writes blended positions to separate output buffer (no read-write race)
- Host dispatches one pass per `submit()`, awaits `onSubmittedWorkDone()`
  between passes for global synchronization
- 7 bindings: propPx, propPy, adjOffsets, adjTargets, posIn, posOut, params(uniform)

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
runPipeline (CPU) → _finalize:
  CPU blend + quantize → create view → return immediately
  async: initGPU() → set view._useGPU = true
  (subsequent interactive changes use GPU blend)
```

## GPU toggle (viewer)

**On → Off:**
```
_useGPU = false, v._useGPU = false
→ _reloadCPU() → loadGraph (workers) → _finalizeLoad (CPU blend)
```

**Off → On:**
```
await initGPU()
→ _useGPU = true, v._useGPU = true
→ _applyGPUToCurrentData() → GPU re-project → await rebuildProjections()
```

**New dataset load while GPU on:**
```
loadGraphGPU (GPU projection if gaussian) → _finalizeLoad → GPU blend
```

## Auto-tune integration

`autoTuneWeights` accepts optional `blendFn` parameter:

```javascript
autoTuneWeights(nodes, groupNames, adjList, nodeIndexFull, {
  blendFn: this._useGPU ? gpuUnifiedBlend : undefined,
  quant: false,  // don't search quant modes (preserves gaussian for GPU)
});
```

When GPU is active:
- Each evaluation uses `gpuUnifiedBlend` (GPU compute)
- `blendAndScore` is async, properly awaited
- quant search disabled (keeps gaussian, avoids switching to rank)

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

All GPU buffers are created per-operation and destroyed after readback.
No persistent GPU state between operations (except the device and compiled
pipelines). Minimum buffer size: 256 bytes (GPU alignment requirement discovered
during testing — smaller buffers cause silent bind group failures).

## Testing

```sh
deno task test          # 48 CPU pipeline tests
deno task test:gpu      # 21 GPU tests (run sequentially per file)
```

GPU tests run in separate processes to avoid cross-file device state
interference (Deno's WebGPU implementation shares module-level device state
across test files in the same process).

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
