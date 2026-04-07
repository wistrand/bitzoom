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

**Implemented then reverted.** Phases A, B, and C were fully implemented and profiled. The findings below show that the GPU compute dispatch itself — not readback — is the bottleneck on integrated GPUs. The phases were reverted because net savings were marginal (~120ms from skipping unpack, but the 241ms GPU kernel is irreducible). Interactive drag responsiveness was instead solved via **adaptive fast mode**: spatial subsampling (>50K nodes), adaptive blend passes (0-2), and edge suppression during drag. See `rebuildProjections(fast)` in `bitzoom-viewer.js`.

Key findings from profiling on Amazon (367K nodes, 988K edges, Intel integrated GPU):

### Profiled breakdown (2 topology passes)

| Component | Time |
|-----------|-----:|
| Anchor computation (CPU, O(N×G)) | 31ms |
| GPU blend dispatch + fence wait | 241ms |
| GPU quantize + uint16 readback | 18ms |
| Float32 readback (eliminated by Phase C) | ~15ms |
| Node unpack loop (367K × 4 writes) | 108ms |

### Key finding: GPU compute dispatch is the bottleneck

The `device.queue.submit` call blocks until GPU compute finishes. The readback (`mapAsync`) adds only ~15ms on top — not the 180ms originally estimated. The 241ms is dominated by the GPU topology smoothing kernel itself on integrated graphics.

Phase C's fast path (skip float32 readback, cached μ/σ) saves ~15ms readback + eliminates the need for the 108ms unpack loop if the renderer reads from the packed array directly. Net: ~120ms saved on the unpack, minimal saving on readback.

### Actual performance

| Config | Time | FPS |
|--------|-----:|----:|
| CPU 2-pass | 460ms | 2.2 |
| GPU full path (first blend) | 423ms | 2.4 |
| GPU fast path (cached μ/σ) | 248ms | 4.0 |
| GPU fast path theoretical (skip unpack) | ~140ms | ~7 |

### Concurrency bug discovered

Multiple `_blend()` calls can overlap when the rAF gate fires a new blend while the previous `mapAsync` is still pending, causing "Buffer mapping is already pending" errors. Fixed with a `_blending` guard flag in `BitZoomCanvas._blend()`.

### Shadow DOM event leak

Native `input` events from `<input type="range">` inside `<bz-controls>` shadow DOM bubble up to the host without `e.detail`, crashing the viewer's input handler. Fixed with `if (!e.detail) return` guard.

### Conclusion

16fps at 367K nodes is not achievable on integrated GPUs with the current topology smoothing approach. The GPU compute kernel itself takes 241ms for 2 passes. Options for further improvement:
- Discrete GPU (would reduce compute time proportionally)
- Subsample during drag (blend a subset, full blend on release)
- Skip topology entirely during drag (α=0, property-only, instant)
- WebGPU→WebGL buffer interop (when browser support lands, eliminates readback + unpack entirely)

## Dependencies

- Phase A requires WebGPU compute (already available)
- Phase B requires Phase A
- Phase C requires Phase A, uses cached μ/σ from first blend
- All phases require `device` and `blendPipeline` from existing [bitzoom-gpu.js](../docs/bitzoom-gpu.js)

## Testing

All GPU compute work must be testable via `deno test --unstable-webgpu` (no browser, no DOM). The existing `tests/gpu_blend_test.ts` pattern is the template: run both CPU and GPU paths on the same input, assert output matches within float32 tolerance.

New tests to add to `deno task test:gpu`:

**Phase A — GPU quantization:**
- `gpuGaussianQuantize` matches CPU `gaussianQuantize` on Karate, Epstein, MITRE (uint16 output, exact match expected)
- Edge cases: all nodes at same position (degenerate σ), single node, empty dataset
- μ/σ uniforms match CPU-computed values

**Phase B — GPU cell assignment:**
- `gpuCellAssign` matches CPU `cellIdAtLevel` for all nodes at levels 3, 5, 7
- Cell IDs are consistent with `(gx >> shift) * gridK + (gy >> shift)` computed from Phase A output

**Phase C — Direct buffer feed:**
- Round-trip: GPU blend → GPU quantize → readback uint16 → compare against CPU `unifiedBlend` + `gaussianQuantize` chain
- Position buffer format matches what the GL renderer expects (interleaved vs separate, byte alignment)

Each phase's tests run independently. Phase A tests don't require Phase B. All tests compare GPU output against CPU reference output — no visual assertions, pure numeric comparison.

## Risks

| Risk | Mitigation |
|------|-----------|
| GL renderer buffer split adds complexity | Position-only updates are a clean separation; attribute updates are infrequent |
| Rank quantization needs GPU radix sort | Keep CPU fallback; gaussian is default and more common |
| Hit testing needs CPU positions | Read back on click only (single node lookup, not full array) |
| Not all browsers support WebGPU | Existing CPU + WebGL2 paths remain as fallback |
