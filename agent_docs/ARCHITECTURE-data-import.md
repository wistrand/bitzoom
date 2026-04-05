# Data Import Architecture

BitZoom accepts data in multiple formats through a unified detection-and-dispatch layer. A single drop or URL handles CSV, D3 force JSON, JGF, GraphML, GEXF, Cytoscape JSON, STIX 2.1 bundles, and SNAP text — the parser module detects the format from content and routes it through one of two pipeline paths.

## Design principles

- **Property-first**: the pipeline supports zero-edge graphs. Property similarity via MinHash is the primary layout signal; topology (edges) is an optional blend via the `α` parameter. A `.csv` or `.nodes` file alone produces a useful layout.
- **Single entry point**: `parseAny(text, filenameHint?)` detects format, dispatches to the right parser, and returns a unified `{nodes, edges, extraPropNames, format}` shape consumable by `runPipelineFromObjects`.
- **Capability-driven dispatch**: the parser module exports `OBJECT_FORMATS`, `isObjectFormat(fmt)`, `FILE_EXTENSIONS`, `FILE_ACCEPT_ATTR`. The viewer asks the parser what it can handle — no hardcoded format lists in UI code.
- **Two pipelines, same downstream**: object-pipeline formats go through `runPipelineFromObjects(nodes, edges, extraPropNames)`; SNAP two-file workflow still uses `runPipeline(edgesText, nodesText)` via the worker. Both call into the same `buildGraph` → `computeProjections` → blend → quantize chain.
- **Determinism**: the whole pipeline is deterministic. Same input → same pixels forever. This is a load-bearing property — shared URLs, bookmarks, and `replaceState` hash updates only work because the layout is reproducible. The guarantees come from seeded Gaussian projection (fixed PRNG seed per group) + bit-prefix quantization (integer-valued `gx`/`gy` derived from sorted ranks or Gaussian CDFs). No force-directed relaxation, no randomized t-SNE/UMAP iterations.

## Format worldviews

Each format we accept encodes a different ontology about what a graph is. Understanding this explains why the parsers look the way they do:

| Format | Worldview | Implication for parser |
|---|---|---|
| **SNAP** (`.edges` + optional `.nodes`) | Graph is connectivity; metadata is annotation | Two-file workflow; edges required historically, now made optional |
| **D3 force JSON** | Nodes are flat property bags, links are peers | Node's top-level keys flatten directly into `extraProps`; closest to BitZoom's internal shape |
| **JGF** | Identity separate from attributes; edges have typed relations | Must flatten `metadata: {}` into extras; dict-form `nodes` keyed by id (v1) |
| **Cytoscape JSON** | Graph is a database record | `data` wrapping on every element; flat-array and grouped forms both exist |
| **GraphML / GEXF** | Graph is tool interchange with typed schemas | Two-pass XML parsing: resolve `<key>`/`<attribute>` registry, then data references |
| **CSV** | There is no graph, just rows with columns | Header sniffing maps columns to roles; edges are absent |
| **STIX 2.1** | Security observables with explicit relationships | Node types drive grouping; SROs become edges; implicit refs also expand |

BitZoom's internal shape (`{nodes: Map, edges: Array, extraPropNames: string[]}`) is closest to D3's flat-node convention, which is why `parseD3` is the smallest adapter and why the other parsers do more work to translate.

## Module layout

### [`docs/bitzoom-parsers.js`](../docs/bitzoom-parsers.js)

The authoritative source for format support. All parsers return the uniform shape:

```js
{ nodes: Map<id, {label, group, extraProps}>, edges: Array<{src, dst, type?}>|null, extraPropNames: string[] }
```

| Export | Purpose |
|---|---|
| `parseCSV(text, opts)` | State-machine CSV parser: auto-detects delimiter (`,` / `\t` / `;` / `|`), handles quoted fields with embedded delimiters/newlines, escaped quotes (`""`), UTF-8 BOM, CRLF. Returns `{headers, rows, delimiter}`. |
| `csvRowsToNodes(headers, rows)` | Header sniffing into `{nodes, extraPropNames}`. Role matching: `id` ← `id`/`node_id`/`nodeid`/`uuid`/`key`; `label` ← `label`/`name`/`title`; `group` ← `group`/`category`/`type`/`class`/`kind`. Positional fallback only when NO role matches by name. Rejects first-column as id when duplicates exist, promoting it to `group` instead. Sequential `row_N` ids for empty id fields. |
| `parseCSVToNodes(text, opts)` | Convenience = `parseCSV` + `csvRowsToNodes`. |
| `parseD3(data)` | D3 force JSON: `{nodes, links}` or `{nodes, edges}`. Falls back to `name` as id (Miserables convention). Resolves numeric link endpoints as both string-id matches and array indices. Handles object-form endpoints (post d3-force mutation). |
| `parseJGF(data)` | JSON Graph Format: `{graph: {...}}` or `{graphs: [...]}` (picks first). Accepts `graph.nodes` as either array or dict keyed by id (JGF v1 both forms). Flattens `metadata: {group, ...}` into `group` + extra props. |
| `parseCytoscape(data)` | Cytoscape.js JSON: grouped form `{elements: {nodes, edges}}` and flat-array form `{elements: [{group, data}]}`. Flattens `data.{id, label, group, ...}`. |
| `parseXML(text)` | Hand-rolled SAX-style XML parser. ~120 lines, zero dependencies. Handles element tags (incl. self-closing), attributes, text, XML declarations, comments, CDATA, DOCTYPE, standard entities (`&amp;` `&lt;` `&gt;` `&quot;` `&apos;` `&#N;` `&#xN;`), namespace prefix stripping. Sufficient for the GraphML/GEXF subset; not a full XML 1.0 implementation. |
| `parseGraphML(text)` | Resolves `<key>` registry, extracts `<node id>` with `<data key>` children and `<edge source target>`. Recognizes common key names (`name` → label, `group`/`category`/`type`/`class` → group). |
| `parseGEXF(text)` | Resolves `<attributes class="node">` registry, extracts `<node id label>` with `<attvalues><attvalue for value/>`, and `<edge source target label?>`. |
| `parseSTIX(input)` | STIX 2.1 bundle (object or JSON string). Lives in [`docs/stix2snap.js`](../docs/stix2snap.js), re-imported by `parseAny`. Builds nodes from SDOs/SCOs with metadata packed as `{subtype, killchain, aliases, level, platforms}`; edges from SROs (relationship/sighting) and implicit refs. Browser-compatible, no file I/O. |
| `detectFormat(text, filenameHint?)` | Content-based sniffer. Filename hint is authoritative for SNAP variants (`.edges`, `.nodes`, `.labels`, with `.gz` variants). Otherwise strips BOM+whitespace, peeks first char: `<` → XML variant (`graphml`/`gexf`/generic `xml`), `{`/`[` → JSON variant via `detectJsonVariant` (JGF > STIX > Cytoscape > D3 > bare array), `#`/digit → SNAP header, else CSV/TSV via delimiter counting. Scans past comment lines to find the first data line. |
| `parseAny(text, filenameHint?)` | Unified dispatcher. Returns `{nodes, edges, extraPropNames, format}` on supported formats. Throws descriptive errors for SNAP edges (use two-file workflow), XML of unknown root, or unknown formats. |
| `OBJECT_FORMATS` (Set) | Formats returning parsed objects: `csv`, `d3`, `d3-bare`, `jgf`, `graphml`, `gexf`, `cytoscape`, `stix`, `snap-nodes`. |
| `TEXT_FORMATS` (Set) | Formats using the SNAP text-worker pipeline: `snap-edges`, `snap`. |
| `SPECIAL_FORMATS` (Set) | Empty after STIX was inlined into OBJECT_FORMATS. Reserved for future. |
| `FILE_EXTENSIONS` / `FILE_ACCEPT_ATTR` | Extension list + pre-joined accept attribute for HTML file inputs. |
| `isObjectFormat(fmt)` / `isTextFormat(fmt)` / `isSpecialFormat(fmt)` | Classification helpers the viewer uses instead of inline format lists. |

### [`docs/bitzoom-pipeline.js`](../docs/bitzoom-pipeline.js)

| Export | Purpose |
|---|---|
| `parseEdgesFile(text)` | SNAP `.edges` parser. Returns empty result structure for null/empty input. |
| `parseNodesFile(text)` | SNAP `.nodes` parser. Header line defines extra property columns. |
| `buildGraph(parsed, nodesMap, extraPropNames)` | Unions node ids from `parsed.nodeIds` AND `nodesMap.keys()` — so nodes-only inputs (empty parsed) AND orphaned metadata rows (nodes in the file but no edges) are preserved. Downstream invariants (degree, adjList, adjGroups) work for edgeless graphs. |
| `runPipeline(edgesText, nodesText)` | Text-based pipeline. Accepts null `edgesText` (nodes-only graphs). |
| `runPipelineGPU(...)` | GPU-accelerated variant with the same semantics. |
| `edgesToParsed(edges)` | Private helper: converts an edge objects array to the `parseEdgesFile`-shape structure so `buildGraph` can consume either source uniformly. |
| `runPipelineFromObjects(nodesMap, edges, extraPropNames)` | Object-pipeline entry point. Used by CSV/D3/JGF/GraphML/GEXF/Cytoscape/STIX loads. Bypasses text parsing entirely — takes the Map+array shape that parsers return. |
| `runPipelineFromObjectsGPU(...)` | GPU variant of the above. |

### [`docs/bitzoom-viewer.js`](../docs/bitzoom-viewer.js)

The viewer integrates parsers via `parseAny` and the capability-classification helpers. Key methods:

| Method | Purpose |
|---|---|
| `_readFileText(file)` | Gzip-aware file reader used by all load paths (loader panel, canvas drop, STIX). |
| `_stageDroppedFiles(files)` | Routes dropped files. SNAP `.edges`/`.nodes` get explicit role routing (two-file workflow); everything else dispatches through `_handleFileSelect` → `detectFormat`. |
| `_handleFileSelect(file, hintType?)` | Reads file, calls `detectFormat`. Dispatches via `isSpecialFormat`/snap checks/`isObjectFormat`. Populates one of `pendingEdgesText`/`pendingNodesText`/`pendingParsed`. |
| `loadFromParsed(parsed)` | Executes the object pipeline: calls `runPipelineFromObjects(GPU)` based on current GPU mode, feeds result into `_applyWorkerResult`. Stores `_lastParsed` for rebuild paths. |
| `_executeCanvasLoad()` | Shared finalizer for canvas-drop loads (both SNAP pair and non-SNAP single-file). Calls the right pipeline, fires `_finalizeLoad(null)`. |
| `loadDataset(dataset)` | URL-preset load. Fetches primary URL (`dataset.stix || dataset.edges`), detects format, uses `isObjectFormat` to route — any object-pipeline format goes through `parseAny`+`loadFromParsed`; SNAP path fetches the companion `.nodes` URL. |
| `_finalizeLoad(dataset)` | Post-load sequence: apply dataset settings or initial blend, **pick initial level from actual cell distribution** (`pickInitialLevel`), restore URL hash state, update stepper/overview/algo UI, schedule hash update, then auto-tune if conditions met. |
| `_autoTuneFresh()` | Runs `autoTuneWeights` on fresh loads without preset settings or hash strengths. Uses the shared `this._tuneAbort` controller so the Stop button works identically for manual and on-load invocations. Applies result via `this._applyTuneResult` (shared with manual Auto button). |
| `pickInitialLevel(nodes, zoomLevels, rawLevel)` | Data-aware initial-level selector. Inspects actual `gx/gy` cell distribution at each level, returns the coarsest level where distinct cells ≥ 25, ≤ 400, and at least one multi-member cell exists. Falls through to RAW for datasets too small to aggregate. Called from `_finalizeLoad` AFTER blending populates coordinates. |

## End-to-end flows

### Flow A: Drop a CSV

```
user drops penguins.csv
  → canvas drop handler (or loader panel drop zone)
  → _stageDroppedFiles([file])
  → _handleFileSelect(file)
  → _readFileText → string
  → detectFormat(text, "penguins.csv") → "csv"
  → parseAny(text) → parseCSVToNodes → {nodes: Map, edges: null, extraPropNames, format: "csv"}
  → pendingParsed set
  → _executeCanvasLoad (or Load button click)
  → loadFromParsed(pendingParsed)
  → runPipelineFromObjects(nodes, null, extraPropNames)  // nodes-only pipeline
  → _applyWorkerResult({nodeMeta, projBuf, edges: [], groupNames, hasEdgeTypes: false})
  → _finalizeLoad(null)
    → v._blend() populates gx/gy
    → pickInitialLevel(v.nodes, ZOOM_LEVELS, RAW_LEVEL) → computes from actual distribution
    → no preset settings → _autoTuneFresh() runs
  → render
```

### Flow B: Drop a GEXF file

```
user drops miserables.gexf
  → _stageDroppedFiles → _handleFileSelect(file)
  → detectFormat → "gexf" (via <gexf> root)
  → parseAny → parseXML → parseGEXF
  → {nodes: Map<"1", {label: "Myriel", group: "unknown", extraProps: {Gender: "M"}}>, edges: [...], extraPropNames: ["Gender"]}
  → pendingParsed set, load button enabled
  → user clicks Load → loadFromParsed → runPipelineFromObjects → auto-tune → render
```

### Flow C: Load SNAP preset with `settings`

```
user picks "Epstein" from dropdown
  → loadDataset({id: "epstein", edges: "data/epstein.edges", nodes: "data/epstein.nodes", settings: {...}})
  → _fetchText(edges)
  → detectFormat(edgesText, "data/epstein.edges") → "snap-edges" (filename hint)
  → isObjectFormat("snap-edges") = false → SNAP text path
  → _fetchText(nodes)
  → loadGraph(edgesText, nodesText) or loadGraphGPU(...)
  → worker: parseEdgesFile + parseNodesFile + buildGraph + projections
  → _applyWorkerResult
  → _finalizeLoad({settings: {...}})
    → _applyDatasetSettings(settings) — applies preset weights, skips auto-tune
    → pickInitialLevel (unless settings.initialLevel is set)
  → render
```

### Flow D: Canvas drop during active session

```
user drops data.edges + data.nodes simultaneously (or sequentially within 600ms)
  → canvas drop handler
  → classify as SNAP-only → stage each file via _handleFileSelect(..., "edges"|"labels")
  → _canvasDropTimer debounces
  → timer fires → _executeCanvasLoad
  → both files staged → loadGraph(pendingEdgesText, pendingNodesText)
  → _finalizeLoad(null) → auto-tune (no preset settings)
```

## Why nodes-only graphs work

With α=0 (or no edges at all) the pipeline is:

```
tokenize(properties) → MinHash → project → blend(strengths only) → quantize → zoom
```

Edges are only referenced in five places, all of which degrade cleanly when empty:

| Edge use site | Zero-edge behavior |
|---|---|
| Topology blending (α > 0 neighbor smoothing in `unifiedBlend`) | Skipped — the `smoothAlpha === 0 \|\| passes === 0` guard returns early |
| Degree as a MinHash token (`degree:4-7`) | Every node produces `degree:0` — no differentiation, no breakage |
| Edge rendering in canvas/WebGL | Empty `v.edges` array — render loops just exit |
| Adjacency list for keyboard nav (arrow keys, N key) | Empty adjList → nav methods report "no connections" and fall back to nearest-by-cursor |
| `neighbors` and `edgetype` property groups | Produce empty tokens; `hasEdgeTypes` is false so `edgetype` is dropped entirely |

This is why CSV, nodes-only SNAP, and any object-pipeline format without an `edges` array all produce useful layouts — the property signal alone is enough to arrange nodes meaningfully via MinHash similarity.

## Format detection heuristics

### Primary dispatch order in `detectJsonVariant`

The order matters because some formats overlap structurally:

1. **Array** → `d3-bare`
2. **STIX bundle** — `{type: "bundle", objects: [...]}` or `{objects: [{type, ...}]}`
3. **JGF** — `{graph: {nodes}}` or `{graphs: [{nodes}]}` with nodes as array OR dict (JGF v1)
4. **Cytoscape** — `{elements: {nodes, edges}}` (grouped) or `{elements: [{data}]}` (flat)
5. **D3** — `{nodes: [...]}` with optional `links` or `edges`

### SNAP vs CSV disambiguation

Filename hint wins for SNAP. Without a hint, content inspection:

- `#` comment prefix → scan past comment to first data line, then count delimiters on that line
- Tab-dominant with no commas/semicolons/pipes → `snap`
- Any comma/semicolon/pipe → `csv`
- Tab + another delimiter → `csv` (parseCSV auto-detects inside)

### XML root detection

- `<graphml` anywhere in first 500 chars → `graphml`
- `<gexf` → `gexf`
- Neither → generic `xml` (throws in `parseAny`)

### Known detection gotchas

The heuristic covers the happy path (~95% of real inputs) but has known blind spots:

- **NDJSON / JSON Lines** — starts with `{` per line but is not a single JSON document. A file beginning with `{"type":"bundle"` could be either a complete STIX bundle or the first line of a streaming log. `JSON.parse` will fail on NDJSON and the detector falls through to `'unknown'`. Users with NDJSON must split lines first.
- **HTML files starting with `<!DOCTYPE`** — detected as generic `xml`, throws with "Unknown XML format" in `parseAny`. This is the correct behavior (we don't support HTML) but the error message could be clearer.
- **CSV with quoted first cell** — a file starting with `"Smith, John",eng,Go` begins with `"`, which matches none of the first-char checks and falls through to the comma-delimiter count. Works in practice but depends on the delimiter being visible in the first line.
- **Leading whitespace / BOM** — BOM (`\uFEFF`) is stripped; leading whitespace is skipped. A file that's pure whitespace returns `'unknown'`.
- **Comment-only preamble** — SNAP detection looks past `#`-prefixed lines to find the first data line. A malformed file where every line starts with `#` produces `'snap'` (via the comment-only fallback) but will produce zero edges when parsed.
- **Filename hint wins for SNAP** — a file named `.edges` but containing CSV will be parsed as SNAP tab-delimited and produce garbage. This is accepted because `.edges` is a BitZoom-specific extension that users who rename files to it deserve the consequences.

## Conventions the parsers honor

| Convention | Source | Where |
|---|---|---|
| `name` as id fallback | D3 (Miserables) | `parseD3` |
| Numeric link endpoints as array indices | D3 | `parseD3.resolveEndpoint` |
| Object-form link endpoints | D3 post-force | `parseD3.resolveEndpoint` |
| Dict-form `graph.nodes` | JGF v1 | `parseJGF` |
| Metadata flattening | JGF | `parseJGF` |
| Namespace prefix stripping | XML | `parseXML.stripNs` |
| `<key>` registry resolution | GraphML | `parseGraphML` |
| `<attributes class="node">` registry | GEXF | `parseGEXF` |
| Flat + grouped element forms | Cytoscape | `parseCytoscape` |
| Category promotion on duplicate ids | CSV generic | `csvRowsToNodes` |
| `label` always included if distinct | label selection | `autoTuneWeights` |

## State reset on fresh load

`_applyWorkerResult` clears per-dataset state so nothing leaks across loads:

- Selection: `selectedId`, `selectedIds`, `hoveredId`, `zoomTargetId`
- View: `pan`, `zoom`, cached `levels` array
- ColorBy: `colorBy = null` (previous group name may not exist in new data)
- Nav state: `_navNeighbors`, `_navAnchorId`, `_navIndex`, `_lastMouseX/Y`
- Dataset identity: `_currentDatasetId`, `_currentEdgesUrl`, `_currentNodesUrl`
- Pending state: cleared in drop handlers before staging

Preserved (user preferences):
- `_colorScheme`, `useWebGL`, `_gpuMode`, `showFps`, `showLegend`, theme class, sidebar state

## Testing

Tests live in [`tests/pipeline_test.ts`](../tests/pipeline_test.ts). The parser module is exercised with 60+ tests covering:

- CSV: delimiters, quoting, BOM, CRLF, empty input, header sniffing, positional fallback, uniqueness rejection
- D3: basic, `edges` alias, extras, edge types, numeric ids, object endpoints, Miserables-style `name` fallback
- JGF: array form, dict form, multi-graph, metadata flattening
- GraphML: key registry, `<data>` resolution, missing root
- GEXF: attribute registry, `<attvalue>`, edge labels
- Cytoscape: grouped + flat forms, edge relation
- STIX: bundle format, relationship SROs, metadata fields
- XML parser: entities, comments, CDATA, namespaces
- `detectFormat`: every format variant, filename-hint precedence, BOM, malformed JSON
- `parseAny` dispatch: correct format routing for all cases + error paths
- End-to-end: `parseAny → runPipelineFromObjects → buildGraph` for each format

Real downloaded samples in [`docs/data/`](../docs/data/):
- `miserables.json` (D3), `miserables.jgf.json` (JGF), `miserables.gexf` (GEXF), `miserables.cyjs.json` (Cytoscape)
- `karate.graphml`, `graphml-sample.xml`
- `penguins.csv`
- `ics-attack.json.gz`, `mobile-attack.json.gz` (STIX)

## Known limitations

These are current constraints worth knowing about, not bugs:

- **Large CSV files block the main thread** — `File.text()` / `FileReader.readAsText()` are synchronous from a user-perception standpoint (they return a promise but the underlying read is not streamed). Current tested ceiling is ~200K rows; beyond that, the browser may freeze during read or the parser may hit memory pressure. Streaming parse for large CSVs is deferred.
- **Column role inference is heuristic** — if a CSV has no headers matching `id`/`label`/`group` and the first column has duplicates (e.g. `species` with 3 values), the sniffer promotes that column to `group` and generates sequential row ids. This works for well-formed data but can surprise users whose convention differs. Manual column-role override in the URL hash is not supported — a fresh CSV drop re-sniffs each time.
- **JGF multi-graph picks the first graph** — files with `{graphs: [...]}` drop all but the first graph silently. No picker UI.
- **XML parser is a subset** — `parseXML` handles the GraphML/GEXF feature surface (elements, attributes, text, comments, CDATA, DOCTYPE skip, standard entities, namespace prefix stripping). It does NOT handle: entity references to custom DTDs, XSLT, attribute values containing `>`, or deeply-nested mixed content in non-trivial ways. Input that exercises these would need a real DOM parser.
- **STIX ingestion uses curated fields only** — `parseSTIX` extracts `subtype`, `killchain`, `aliases`, `level`, `platforms` from STIX objects. Other STIX extension fields are dropped. This keeps the property-group count manageable but loses information that a specialized STIX tool would show.
- **Auto-tune on fresh load is synchronous in wall-clock** — for large datasets (e.g., Amazon 367K), auto-tune runs for 10-30 seconds after the initial blend. The progress bar is visible but the user can't interact with the layout until tune completes (aside from pressing Stop). Dataset presets with explicit `settings` skip auto-tune to avoid this delay.

## Extending: adding a new format

To add a format (e.g., `gml` or `pajek`):

1. Add a `parseX(data)` function to `bitzoom-parsers.js` returning `{nodes, edges, extraPropNames}`
2. Add a case to `parseAny`'s switch dispatching to the new parser
3. Add detection logic to `detectFormat` (or `detectJsonVariant` for JSON variants)
4. Add `'x'` to `OBJECT_FORMATS`
5. Add extensions to `FILE_EXTENSIONS`
6. Add tests

The viewer needs **zero changes** — it asks the parser via `isObjectFormat(fmt)` and `FILE_ACCEPT_ATTR`.
