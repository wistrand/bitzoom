# Plan: GPU-Resident Positions (Zero-Readback Blend)

## Problem

At 367K nodes (Amazon), GPU blend takes ~230ms per slider drag. The GPU compute itself is fast (~30ms for anchors, ~20ms for topology passes). The bottleneck is **`mapAsync` readback** — copying 2.9MB of blended positions from GPU to CPU takes ~180ms due to the GPU→CPU sync point.

Current pipeline:
```
CPU: compute anchors (30ms) → upload to GPU
GPU: topology smoothing (2-5 passes, ~20ms)
GPU→CPU: readback 2.9MB float32 (mapAsync, ~180ms) ← bottleneck
CPU: quantize → build levels → render
```

## Goal

Eliminate or minimize readback by keeping positions on GPU. Target: 16fps (62ms) interactive blend at 367K nodes.

## Phases

### Phase A — GPU quantization (~150ms, ~7fps)

**Keep blend on GPU, add a quantize compute shader, read back uint16 instead of float32.**

New compute shader (`quantize.wgsl`):
- Input: storage buffer of blended `(px, py)` float32 pairs (output of blend passes)
- Uniforms: μ_x, σ_x, μ_y, σ_y (recomputed each blend, same as CPU)
- Output: storage buffer of `(gx, gy)` uint16 pairs
- Math: `gx = clamp(Φ((px - μ_x) / σ_x) × 65536, 0, 65535)` (gaussian mode)
- Rank mode: requires GPU radix sort — defer to Phase B or keep CPU fallback

Readback: 367K × 4 bytes (2 × uint16) = 1.5MB instead of 2.9MB. ~50% bandwidth reduction.

Changes:
- New WGSL shader for gaussian quantization
- `gpuBlend` returns quantized uint16 buffer instead of float32
- `gpuUnifiedBlend` skips CPU quantization when GPU did it
- CPU quantize remains as fallback for rank mode

### Phase B — GPU cell assignment (~120ms, ~8fps)

**Add a cell-ID compute shader. CPU reads compact cell assignments, not positions.**

New compute shader (`cellassign.wgsl`):
- Input: quantized `(gx, gy)` uint16 from Phase A
- Uniform: `shift` (16 - level)
- Output: `cellId` uint32 per node = `(gx >> shift) * gridK + (gy >> shift)`

Readback: 367K × 4 bytes (uint32 cell IDs) = 1.5MB. Same size as Phase A but the CPU work is simpler — just bucket nodes by cell ID to build supernodes.

Changes:
- New WGSL shader for cell assignment
- `buildLevelNodes` accepts pre-computed cell IDs instead of reading `n.gx/gy`
- Blend → quantize → cell-assign pipeline runs as 3 compute passes in one command buffer

### Phase C — Direct GL buffer feed (~50ms, ~20fps)

**Minimal readback. Blend → quantize on GPU → readback quantized uint16 → feed directly to WebGL2 instanced buffer.**

The existing WebGL2 renderer ([bitzoom-gl-renderer.js](../docs/bitzoom-gl-renderer.js)) already does instanced circles, edges, heatmap, and text overlay. It doesn't need replacing. The bottleneck is the **data-packing loop** where the renderer reads `node.gx`, `node.gy`, `node.color`, `node.size` one by one into a Float32Array, then uploads to GL.

Phase C shortcuts this:

1. **GPU quantize** (Phase A) produces a compact `uint16` position buffer
2. **Readback** the uint16 buffer (1.5MB, fast)
3. **Feed directly** to the WebGL2 renderer's instanced attribute buffer via `gl.bufferSubData`, skipping:
   - The per-node JS property access loop (`for (const n of nodes) { data[off] = n.gx; ... }`)
   - The node object intermediary entirely for position data
4. Colors, sizes, and other per-node attributes are packed separately (they change rarely — only on colorBy/sizeBy change, not on every blend)

Changes:
- Split the GL renderer's data-packing into **position-only** (changes every blend) and **attribute** (changes on colorBy/sizeBy) uploads
- Add a `setPositionBuffer(uint16Array)` method to the GL renderer that writes positions directly without per-node iteration
- The blend path calls `setPositionBuffer` with the GPU-quantized readback
- ~100 lines of changes to the existing renderer, no new renderer needed

**Alternative (full zero-readback):** Use WebGPU↔WebGL buffer interop where available (`GPUExternalTexture` or shared `ArrayBuffer`). This is browser-dependent and not yet widely supported. When it lands, the readback step disappears entirely — the GL renderer reads from the WebGPU storage buffer. No code changes to the renderer beyond the buffer source.

### What each phase preserves

| Capability | Phase A | Phase B | Phase C |
|-----------|---------|---------|---------|
| Canvas 2D renderer | ✓ | ✓ | ✓ |
| WebGL2 renderer | ✓ | ✓ | ✓ (direct buffer feed) |
| CPU fallback | ✓ | ✓ | ✓ |
| Rank quantization | CPU fallback | CPU fallback | CPU fallback or GPU sort |
| Level building | CPU | CPU (faster input) | CPU or GPU |
| Node labels/text | ✓ | ✓ | Canvas 2D overlay |
| Hit testing | CPU | CPU | CPU (readback on click only) |
| SVG export | ✓ | ✓ | ✓ (readback on export only) |

## Implementation status

**Phases A-C: implemented then reverted.** Net savings were marginal at the time.

**Optimization round 2 (implemented):** Profiling infrastructure, interleaved anchor buffer, bind group cache, CSR adjacency cache. These changes reduced Amazon warm-blend from ~290ms to ~51ms in Deno tests. See details below.

Interactive drag responsiveness solved via **adaptive fast mode**: spatial subsampling (>50K nodes), adaptive blend passes (0-2), and edge suppression during drag. See `rebuildProjections(fast)` in `bitzoom-viewer.js`.

### Phase A-C findings (historical, 2 topology passes)

| Component | Time |
|-----------|-----:|
| Anchor computation (CPU, O(N×G)) | 31ms |
| GPU blend dispatch + fence wait | 241ms |
| GPU quantize + uint16 readback | 18ms |
| Float32 readback (eliminated by Phase C) | ~15ms |
| Node unpack loop (367K × 4 writes) | 108ms |

The 241ms was measured before buffer caching and `_blending` guard. See revised analysis below.

### Bugs discovered during Phase A-C

- **Concurrent blend stalls**: Multiple `_blend()` calls overlapped when rAF fired while `mapAsync` was pending. Fixed with `_blending` guard in `BitZoomCanvas._blend()`.
- **Shadow DOM event leak**: Native `input` events from `<input type="range">` inside `<bz-controls>` shadow DOM bubble without `e.detail`. Fixed with `if (!e.detail) return`.

### Optimization round 2: profiling + caching (implemented)

Fine-grained profiling added to `gpuBlend` (`setGpuBlendProfiling(true)`) with per-phase timing: anchor compute, CSR build, buffer upload, bind group creation, GPU dispatch, GPU fence (`onSubmittedWorkDone`), map (DMA readback), deinterleave.

**Optimizations applied:**
1. **Interleaved anchor buffer** — single `propAnchors` replaces `propPx`+`propPy`. One `writeBuffer` instead of two, better GPU cache locality. WGSL shader updated (6 bindings instead of 7).
2. **Bind group cache** — `bgAtoB`/`bgBtoA` stored in blend cache, only recreated on dataset change.
3. **CSR adjacency cache** — `adjOffsetsArr`/`adjTargetsArr` cached; skipped when N unchanged. Eliminates the 170-250ms CSR rebuild that dominated warm blends.

### Deno test results (Amazon, 367K nodes, 988K edges, 5 passes, Intel iGPU)

| Component | Cold | Warm |
|-----------|-----:|-----:|
| Anchor compute | 32ms | 30ms |
| CSR build | 246ms | **0ms** |
| Buffer upload | 7ms | 4ms |
| Bind group create | 0.1ms | **0ms** |
| GPU dispatch | 4ms | 2ms |
| GPU fence | 15ms | 14ms |
| Map (DMA) | 17ms | 16ms |
| Deinterleave | 1ms | 1ms |
| **Total** | **309ms** | **53ms** |

### Browser results (Amazon, Firefox, Intel iGPU, Canvas 2D rendering)

Browser `mapAsync` is significantly slower than Deno due to driver overhead:

| Component | Typical | GPU stall | Best case |
|-----------|--------:|----------:|----------:|
| Anchor compute | 20-40ms | 20-40ms | 20ms |
| CSR build | **0ms** | **0ms** | **0ms** |
| GPU fence | 40-90ms | 451-482ms | 19ms |
| Map (DMA) | **~104ms** | 15-28ms | **104ms** |
| **Total** | 160-260ms | 490-540ms | 130ms |

**Key finding: browser `mapAsync` has a ~104ms floor** regardless of GPU kernel time. When the fence wait is long (GPU backed up), map is fast (work already done). When fence is fast, map is slow. The fence+map sum is roughly constant at ~130-170ms in typical cases, with spikes to 500ms during GPU contention. This 104ms floor does not exist in Deno (15ms) — it's browser WebGPU driver overhead (likely an extra DMA synchronization step).

**The GPU kernel itself is fast**: fence time of 14-19ms in Deno, 19-90ms typical in browser (5 passes over 367K nodes). This confirms the GPU architect's prediction of 5-20ms for the kernel alone.

### Practical implications

| Scale | GPU blend (browser) | CPU fast mode | Winner |
|-------|--------------------:|--------------:|--------|
| <50K nodes | ~130ms | ~22ms (full 5-pass) | CPU — fast mode not needed |
| 50-200K | ~150ms | ~22ms (subsample) | CPU fast mode for drag, GPU for release |
| 367K (Amazon) | 160-540ms | ~22ms (subsample) | CPU fast mode for drag, GPU for release |

The 104ms `mapAsync` floor makes GPU blend non-competitive for interactive drag at any scale in current browsers. GPU blend is best used for the final full-quality blend on mouse release.

### Recommended next steps
| 4 | Read buffer ring (2-deep) | ~40 lines | Eliminates `mapAsync` stall, 1-frame latency |

**Medium effort:**

| # | Change | Effort | Expected impact |
|---|--------|--------|----------------|
**Remaining optimizations (not yet implemented):**

| # | Change | Effort | Expected impact |
|---|--------|--------|----------------|
| 5 | `GPUQuerySet` timestamp profiling | ~50 lines | Hardware-level kernel timing, more precise than `onSubmittedWorkDone` |
| 6 | Degree-sorted CSR | ~50 lines | Better cache locality for scatter-gather |
| 7 | CSR-Adaptive (two pipelines) | ~150 lines | Warp-level reduction for hub nodes; needs `subgroups` (Chrome 128+) |
| 8 | GPU anchor computation | ~100 lines | Move 20-40ms CPU anchor loop to GPU compute shader |
| 9 | Single WebGPU render + compute pipeline | ~1200 lines | Zero readback; eliminates the 104ms `mapAsync` floor entirely |

Item 9 is the only way to eliminate the browser `mapAsync` bottleneck. All other optimizations are bounded by the ~104ms DMA floor.

### Current shipping solution

Adaptive fast mode for interactive drag (correct approach given browser WebGPU overhead):
- Spatial subsampling (>50K nodes): 16×16 grid, degree-weighted, ~20-50K sample
- Adaptive blend passes: 0-2, budget system with ceiling lock
- Edge suppression: `_skipEdgeBuild` stays true for entire drag session
- Full 5-pass blend + layout + edge build on mouse release
- Below 50K: always full blend, no fast mode
- GPU blend used for final quality blend on release, not interactive drag

## Risks

| Risk | Mitigation |
|------|-----------|
| Browser `mapAsync` overhead (~104ms floor) | CPU fast mode for interactive drag; GPU only on release |
| Not all browsers support WebGPU | Existing CPU + WebGL2 paths remain as fallback |
| `subgroups` not universally available | CSR-Adaptive (#7) is optional; basic kernel works without it |
