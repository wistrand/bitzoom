# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BitZoom is a deterministic layout and hierarchical aggregation viewer for large property graphs. Nodes are positioned by property similarity (MinHash + Gaussian projection), with stable zoom levels derived from uint16 grid coordinates via bit shifts.

- [`agent_docs/SPEC.md`](agent_docs/SPEC.md) — algorithm theory, tradeoffs, complexity analysis
- [`agent_docs/ARCHITECTURE.md`](agent_docs/ARCHITECTURE.md) — implementation details, module responsibilities, data flow, caching, design rationale

## Running

```sh
deno task serve       # dev server at http://localhost:8000
deno task test        # run pipeline tests (45 tests)
deno task stix2snap   # STIX 2.1 JSON → SNAP converter
deno task csv2snap    # OpenCTI CSV → SNAP converter
deno task src2snap    # source code → SNAP call graph
```

## File Structure

```
htdocs/                    Web app (ES modules, no build step)
  index.html               HTML shell (96 lines)
  bitzoom.css              Styles (619 lines)
  bitzoom-algo.js          Pure algorithm functions and constants (340 lines)
  bitzoom-pipeline.js      Parsers, graph building, tokenization, projection (345 lines)
  bitzoom-renderer.js      Canvas rendering, heatmaps, hit testing (665 lines)
  bitzoom.js               BitZoom class — state, UI, events, data loading (1308 lines)
  bitzoom-worker.js        Web Worker coordinator (145 lines)
  bitzoom-proj-worker.js   Web Worker projection (105 lines)

data/                      9 SNAP-format datasets (.edges + .labels)
tests/pipeline_test.ts     45 tests: unit, numeric, undefined values, E2E
scripts/
  serve.ts                 Deno HTTP server (no-cache headers)
  stix2snap.ts             STIX 2.1 → SNAP converter (extracts platforms, kill chains)
  csv2snap.ts              OpenCTI CSV → SNAP converter (Jaccard co-reference edges)
  src2snap.ts              Source code → SNAP call graph (functions, methods, calls)
```

## Data Format (SNAP)

- `.edges` (required): tab-delimited, `#` comments. `From\tTo` or `From\tTo\tEdgeType`.
- `.labels` (optional): tab-delimited. `# NodeId\tLabel\tGroup[\tExtra1\tExtra2...]`.
  - Extra columns become MinHash property groups.
  - Numeric columns auto-detected (>=80% parseable) → 3-level tokenization (coarse/medium/fine).
  - Empty fields = undefined → 0 tokens, neutral projection, no false clustering.

## Datasets

| Name | Nodes | Edges | Properties |
|---|---|---|---|
| Karate Club | 34 | 78 | group |
| Epstein | ~500 | ~500 | type, edge types |
| Melker src | 305 | 1,433 | module groups |
| Synth Packages | 2,000 | 4,050 | downloads, license, version, depcount |
| Amazon | 367K | 988K | product category |
| CERT Polska STIX | 93 | 417 | STIX types, platforms |
| OpenCTI PAP | 107 | 2,879 | source, marking, tags, confidence |
| BitZoom Source | 144 | 401 | kind, file, lines, bytes, age |
| MITRE ATT&CK | 4,736 | 25,856 | kill chain, platforms, aliases |

## Key Design Decisions

- **ES modules** — `import`/`export` everywhere. Module workers. Single `<script type="module">`.
- **No code duplication** — GC-optimized MinHash/projection (`computeMinHashInto`, `_sig`, `projectInto`, typed-array HASH_PARAMS) in `bitzoom-algo.js`, imported by pipeline and workers.
- **Web Workers** — coordinator fans out to up to 3 projection sub-workers. Transferable Float64Array buffers.
- **Supernode color/label cached at build time** — not recomputed per frame. `_refreshPropCache()` invalidates level cache.
- **Two-zoom system** — logical zoom triggers level changes; `renderZoom = max(1, zoom * 2^levelOffset)` keeps visual scale continuous.
- **Multi-select** — Ctrl+click toggles; `selectedIds` Set; edges highlight for all selected.
- **Adaptive rendering** — edge sampling scales with visible nodes; labels/counts hide at high density, appear on zoom-in; node opacity scales with importance.
- **5-layer render order** — edges → heatmap → highlighted edges → circles → labels.
- **URL hash state** — dataset + zoom + pan + level + selection. `replaceState` on render.

## Important Invariants

- Per-node projections computed once at load, never change.
- Weight changes trigger blend + quantize only (no re-projection).
- Bit-prefix containment: level L cell is always a sub-cell of level L-1.
- Renderer never mutates BitZoom state (except `n.x`/`n.y` in layoutAll).
- `_refreshPropCache()` must be called when weights or label selection change.
- `getLevel()` calls `layoutAll()` when building a new level.
- `switchLevel()` adjusts zoom to preserve renderZoom across level changes.
- Empty/undefined property values emit 0 tokens — no false clustering.
