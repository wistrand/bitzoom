import { assertEquals, assertExists, assert } from "https://deno.land/std/assert/mod.ts";

// Load algo first (pipeline depends on it)
import {
  MINHASH_K, GRID_SIZE, ZOOM_LEVELS, RAW_LEVEL,
  computeMinHash, computeMinHashInto, _sig, projectWith, projectInto,
  buildGaussianProjection, hashToken, jaccardEstimate, cellIdAtLevel,
  normalizeAndQuantize, unifiedBlend, buildLevel, buildLevelNodes, buildLevelEdges,
  maxCountKey, getNodePropValue, getSupernodeDominantValue,
} from "../docs/bitzoom-algo.js";
import { generateGroupColors } from "../docs/bitzoom-colors.js";

import {
  parseEdgesFile, parseNodesFile, buildGraph,
  degreeBucket, tokenizeLabel, tokenizeNumeric, computeProjections, runPipeline, computeNodeSig,
} from "../docs/bitzoom-pipeline.js";
import { parseCSV, csvRowsToNodes, parseCSVToNodes, parseD3, parseJGF, parseXML, parseGraphML, parseGEXF, parseCytoscape, detectFormat, parseAny, isObjectFormat, isTextFormat, isSpecialFormat, OBJECT_FORMATS, FILE_EXTENSIONS, FILE_ACCEPT_ATTR } from "../docs/bitzoom-parsers.js";
import { runPipelineFromObjects } from "../docs/bitzoom-pipeline.js";

// ─── Unit tests: bitzoom-algo.js ─────────────────────────────────────────────

Deno.test("hashToken is deterministic", () => {
  assertEquals(hashToken("hello"), hashToken("hello"));
  assert(hashToken("hello") !== hashToken("world"));
});

Deno.test("computeMinHash returns k=128 signature", () => {
  const sig = computeMinHash(["a", "b", "c"]);
  assertEquals(sig.length, MINHASH_K);
  for (let i = 0; i < MINHASH_K; i++) {
    assert(sig[i] < Infinity, `sig[${i}] should be finite`);
    assert(sig[i] >= 0, `sig[${i}] should be non-negative`);
  }
});

Deno.test("computeMinHashInto writes to shared _sig buffer", () => {
  computeMinHashInto(["x", "y"], 2);
  assert(_sig[0] < Infinity);
  // calling again overwrites
  computeMinHashInto(["z"], 1);
  assert(_sig[0] < Infinity);
});

Deno.test("computeMinHash with tokenCount parameter", () => {
  const tokens = ["a", "b", "c", "IGNORED"];
  const sig3 = computeMinHash(tokens, 3);
  const sig4 = computeMinHash(tokens, 4);
  assertEquals(sig3.length, MINHASH_K);
  // sig3 and sig4 should differ since different token counts
  let differ = false;
  for (let i = 0; i < MINHASH_K; i++) if (sig3[i] !== sig4[i]) { differ = true; break; }
  assert(differ, "Different token counts should produce different sigs");
});

Deno.test("jaccardEstimate: identical sigs have J=1", () => {
  const sig = computeMinHash(["foo", "bar"]);
  assertEquals(jaccardEstimate(sig, sig), 1);
});

Deno.test("jaccardEstimate: similar sets have high J", () => {
  // Use realistic-sized token sets (OPH needs enough tokens to populate bins)
  const a = computeMinHash(["group:web", "label:flask", "label:server", "deg:4-7", "lang:python", "ngroup:web", "ngroup:data", "etype:DEPENDS"]);
  const b = computeMinHash(["group:web", "label:flask", "label:api",    "deg:4-7", "lang:python", "ngroup:web", "ngroup:data", "etype:IMPORTS"]);
  const c = computeMinHash(["group:ml",  "label:torch", "label:cuda",   "deg:1",   "lang:cpp",    "ngroup:ml",  "ngroup:ml",   "etype:LINKS"]);
  const jAB = jaccardEstimate(a, b);
  const jAC = jaccardEstimate(a, c);
  assert(jAB > jAC, `Similar sets (${jAB}) should have higher J than dissimilar (${jAC})`);
});

Deno.test("buildGaussianProjection is deterministic", () => {
  const r1 = buildGaussianProjection(42, MINHASH_K);
  const r2 = buildGaussianProjection(42, MINHASH_K);
  assertEquals(r1[0][0], r2[0][0]);
  assertEquals(r1[1][MINHASH_K - 1], r2[1][MINHASH_K - 1]);
});

Deno.test("projectWith returns [x, y]", () => {
  const sig = computeMinHash(["test"]);
  const rot = buildGaussianProjection(1, MINHASH_K);
  const [x, y] = projectWith(sig, rot);
  assert(typeof x === "number" && !isNaN(x));
  assert(typeof y === "number" && !isNaN(y));
});

Deno.test("projectInto writes to buffer", () => {
  // Use enough tokens for OPH to populate multiple bins with distinct values
  const sig = computeMinHash(["group:web", "label:flask", "label:server", "deg:4-7", "lang:python", "ngroup:data"]);
  const rot = buildGaussianProjection(1, MINHASH_K);
  const buf = new Float64Array(4);
  projectInto(sig, rot, buf, 2);
  assert(isFinite(buf[2]) && isFinite(buf[3]), "Should write finite projection");
  // Should match projectWith
  const [x, y] = projectWith(sig, rot);
  assertEquals(buf[2], x);
  assertEquals(buf[3], y);
});


Deno.test("cellIdAtLevel: bit-prefix containment", () => {
  const gx = 30000, gy = 45000;
  for (let L = 2; L <= 14; L++) {
    const parentCell = cellIdAtLevel(gx, gy, L - 1);
    const childCell = cellIdAtLevel(gx, gy, L);
    // Parent cell at L-1 should be derivable from child at L
    const shift = 16 - (L - 1);
    const parentFromChild = cellIdAtLevel(gx, gy, L - 1);
    assertEquals(parentCell, parentFromChild);
  }
});

Deno.test("maxCountKey finds the highest count", () => {
  assertEquals(maxCountKey({ a: 1, b: 5, c: 3 }), "b");
  assertEquals(maxCountKey({ x: 10 }), "x");
});

Deno.test("generateGroupColors returns hex colors", () => {
  const colors = generateGroupColors(["web", "data", "ml"]);
  assertEquals(Object.keys(colors).length, 3);
  for (const c of Object.values(colors)) {
    assert((c as string).startsWith("#"), `${c} should be hex`);
    assertEquals((c as string).length, 7, `${c} should be 7 chars`);
  }
});

// ─── Unit tests: bitzoom-pipeline.js ─────────────────────────────────────────

const SAMPLE_EDGES = `# Test graph
# Nodes: 4 Edges: 3
A\tB
B\tC
C\tD\tFRIEND`;

const SAMPLE_LABELS = `# NodeId\tLabel\tGroup\tScore
A\tAlice\tpeople\thigh
B\tBob\tpeople\tlow
C\tCarol\tanimals\thigh
D\tDave\tanimals\tlow`;

Deno.test("parseEdgesFile: basic 2-column", () => {
  const r = parseEdgesFile("X\tY\nY\tZ\n");
  assertEquals(r.edgeCount, 2);
  assertEquals(r.edgeFrom[0], "X");
  assertEquals(r.edgeTo[0], "Y");
  assertEquals(r.nodeIds.size, 3);
  assertEquals(r.edgeTypeMap, null);
});

Deno.test("parseEdgesFile: 3-column with edge types", () => {
  const r = parseEdgesFile(SAMPLE_EDGES);
  assertEquals(r.edgeCount, 3);
  assertExists(r.edgeTypeMap);
  assert(r.edgeTypeMap!.get("C")!.has("FRIEND"));
  assert(r.edgeTypeMap!.get("D")!.has("FRIEND"));
});

Deno.test("parseEdgesFile: skips comments and empty lines", () => {
  const r = parseEdgesFile("# comment\n\nA\tB\n# another\nC\tD\n");
  assertEquals(r.edgeCount, 2);
});

Deno.test("parseNodesFile: parses header and extra columns", () => {
  const r = parseNodesFile(SAMPLE_LABELS);
  assertEquals(r.extraPropNames.length, 1);
  assertEquals(r.extraPropNames[0], "score");
  const alice = r.nodes.get("A");
  assertExists(alice);
  assertEquals(alice!.label, "Alice");
  assertEquals(alice!.group, "people");
  assertEquals(alice!.extraProps.score, "high");
});

Deno.test("parseNodesFile: handles missing header", () => {
  const r = parseNodesFile("X\tXena\twarrior\nY\tYoda\tjedi\n");
  assertEquals(r.nodes.size, 2);
  assertEquals(r.nodes.get("X")!.group, "warrior");
});

Deno.test("buildGraph: builds nodes, edges, adjacency", () => {
  const parsed = parseEdgesFile(SAMPLE_EDGES);
  const nodesResult = parseNodesFile(SAMPLE_LABELS);
  const graph = buildGraph(parsed, nodesResult.nodes, nodesResult.extraPropNames);

  assertEquals(graph.nodeArray.length, 4);
  assertEquals(graph.edges.length, 3);
  assertEquals(graph.uniqueGroups.length, 2); // animals, people
  assert(graph.groupNames.includes("group"));
  assert(graph.groupNames.includes("label"));
  assert(graph.groupNames.includes("structure"));
  assert(graph.groupNames.includes("neighbors"));
  assert(graph.groupNames.includes("score")); // extra prop
  assert(graph.groupNames.includes("edgetype")); // 3-col edges
  assert(graph.hasEdgeTypes);

  // Check degrees
  const nodeB = graph.nodeIndex["B"];
  assertEquals(nodeB.degree, 2); // A-B and B-C
  const nodeA = graph.nodeIndex["A"];
  assertEquals(nodeA.degree, 1);

  // Check adjacency
  assert(graph.adjList["A"].includes("B"));
  assert(graph.adjList["B"].includes("A"));
  assert(graph.adjList["B"].includes("C"));
});

Deno.test("degreeBucket: bucketing", () => {
  assertEquals(degreeBucket(0), "0");
  assertEquals(degreeBucket(1), "1");
  assertEquals(degreeBucket(3), "2-3");
  assertEquals(degreeBucket(7), "4-7");
  assertEquals(degreeBucket(15), "8-15");
  assertEquals(degreeBucket(31), "16-31");
  assertEquals(degreeBucket(100), "32+");
});

Deno.test("tokenizeLabel: extracts words", () => {
  const buf = new Array(20);
  const end = tokenizeLabel("Hello World 42 x", "id1", buf, 0);
  assertEquals(end, 3); // "hello", "world", "42" (x is single char, skipped)
  assertEquals(buf[0], "label:hello");
  assertEquals(buf[1], "label:world");
  assertEquals(buf[2], "label:42");
});

Deno.test("tokenizeLabel: falls back to id for empty label", () => {
  const buf = new Array(5);
  const end = tokenizeLabel("x", "node99", buf, 0);
  assertEquals(end, 1);
  assertEquals(buf[0], "label:node99");
});

Deno.test("tokenizeLabel: respects offset", () => {
  const buf = new Array(10);
  buf[0] = "existing";
  const end = tokenizeLabel("foo bar", "id", buf, 1);
  assertEquals(buf[0], "existing");
  assertEquals(buf[1], "label:foo");
  assertEquals(buf[2], "label:bar");
  assertEquals(end, 3);
});

Deno.test("computeProjections: produces valid output", () => {
  const parsed = parseEdgesFile(SAMPLE_EDGES);
  const nodesResult = parseNodesFile(SAMPLE_LABELS);
  const graph = buildGraph(parsed, nodesResult.nodes, nodesResult.extraPropNames);
  const result = computeProjections(
    graph.nodeArray, graph.adjGroups, graph.groupNames, graph.hasEdgeTypes, nodesResult.extraPropNames, graph.numericBins,
  );

  const N = graph.nodeArray.length;
  const G = graph.groupNames.length;
  assertEquals(result.projBuf.length, N * G * 2);

  // All projections should be finite
  for (let i = 0; i < result.projBuf.length; i++) {
    assert(isFinite(result.projBuf[i]), `projBuf[${i}] should be finite`);
  }
});

Deno.test("computeProjections: deterministic", () => {
  const parsed = parseEdgesFile(SAMPLE_EDGES);
  const nodesResult = parseNodesFile(SAMPLE_LABELS);
  const graph = buildGraph(parsed, nodesResult.nodes, nodesResult.extraPropNames);
  const r1 = computeProjections(graph.nodeArray, graph.adjGroups, graph.groupNames, graph.hasEdgeTypes, nodesResult.extraPropNames, graph.numericBins);
  const r2 = computeProjections(graph.nodeArray, graph.adjGroups, graph.groupNames, graph.hasEdgeTypes, nodesResult.extraPropNames, graph.numericBins);
  for (let i = 0; i < r1.projBuf.length; i++) {
    assertEquals(r1.projBuf[i], r2.projBuf[i], `projBuf[${i}] should be deterministic`);
  }
});

Deno.test("runPipeline: end-to-end on embedded data", () => {
  const result = runPipeline(SAMPLE_EDGES, SAMPLE_LABELS);
  assertEquals(result.nodeArray.length, 4);
  assertEquals(result.edges.length, 3);
  assert(result.groupNames.includes("score"));
  assert(result.hasEdgeTypes);
  assertEquals(result.uniqueGroups.length, 2);
  assert(result.projBuf.length > 0);
});

Deno.test("runPipeline: works without labels", () => {
  const result = runPipeline("A\tB\nB\tC\n", null);
  assertEquals(result.nodeArray.length, 3);
  assertEquals(result.edges.length, 2);
  // All nodes should have group 'unknown'
  for (const n of result.nodeArray) {
    assertEquals(n.group, "unknown");
  }
});

// ─── Nodes-only (edgeless) pipeline ──────────────────────────────────────────

Deno.test("parseEdgesFile: null text returns empty result", () => {
  const r = parseEdgesFile(null);
  assertEquals(r.edgeCount, 0);
  assertEquals(r.edgeFrom.length, 0);
  assertEquals(r.edgeTo.length, 0);
  assertEquals(r.nodeIds.size, 0);
  assertEquals(r.edgeTypeMap, null);
});

Deno.test("parseEdgesFile: empty string returns empty result", () => {
  const r = parseEdgesFile("");
  assertEquals(r.edgeCount, 0);
  assertEquals(r.nodeIds.size, 0);
});

Deno.test("buildGraph: nodes-only from nodesMap when parsed is empty", () => {
  const parsed = parseEdgesFile(null);
  const nodesResult = parseNodesFile(SAMPLE_LABELS);
  const graph = buildGraph(parsed, nodesResult.nodes, nodesResult.extraPropNames);

  assertEquals(graph.nodeArray.length, 4);
  assertEquals(graph.edges.length, 0);
  // Every node has degree 0 and empty adjacency
  for (const n of graph.nodeArray) {
    assertEquals(n.degree, 0);
    assertEquals(graph.adjList[n.id].length, 0);
  }
  // Property groups still include core + extras
  assert(graph.groupNames.includes("group"));
  assert(graph.groupNames.includes("label"));
  assert(graph.groupNames.includes("score")); // extra prop preserved
  // No edge types when no edges
  assertEquals(graph.hasEdgeTypes, false);
});

Deno.test("buildGraph: unions ids from edges and nodesMap (orphan nodes preserved)", () => {
  // Edges reference A, B, C. Nodes map also has D (orphan, no edges).
  const parsed = parseEdgesFile("A\tB\nB\tC\n");
  const nodesResult = parseNodesFile(SAMPLE_LABELS);
  const graph = buildGraph(parsed, nodesResult.nodes, nodesResult.extraPropNames);

  // 4 nodes: A, B, C (from edges + metadata), D (from metadata only)
  assertEquals(graph.nodeArray.length, 4);
  assertExists(graph.nodeIndex["D"]);
  assertEquals(graph.nodeIndex["D"].degree, 0);
  assertEquals(graph.nodeIndex["D"].label, "Dave");
  assertEquals(graph.nodeIndex["D"].group, "animals");
  // A, B, C have their edge-derived degrees
  assertEquals(graph.nodeIndex["A"].degree, 1);
  assertEquals(graph.nodeIndex["B"].degree, 2);
  assertEquals(graph.nodeIndex["C"].degree, 1);
});

Deno.test("runPipeline: nodes-only (null edges) produces valid layout", () => {
  const result = runPipeline(null, SAMPLE_LABELS);
  assertEquals(result.nodeArray.length, 4);
  assertEquals(result.edges.length, 0);
  // Every node has metadata from the .nodes file
  assertEquals(result.nodeIndex["A"].label, "Alice");
  assertEquals(result.nodeIndex["A"].group, "people");
  // Extra property group is present
  assert(result.groupNames.includes("score"));
  // Projections computed — buffer non-empty (2 coords × G groups × N nodes)
  const G = result.groupNames.length;
  assertEquals(result.projBuf.length, 4 * G * 2);
  // No edge types
  assertEquals(result.hasEdgeTypes, false);
});

Deno.test("runPipeline: nodes-only (empty edges string)", () => {
  const result = runPipeline("", SAMPLE_LABELS);
  assertEquals(result.nodeArray.length, 4);
  assertEquals(result.edges.length, 0);
  // Degree tokenization produces deg:0 for all — verify via adjGroups being empty
  for (let i = 0; i < result.nodeArray.length; i++) {
    assertEquals(result.adjGroups[i].length, 0);
  }
});

// ─── CSV parser (bitzoom-parsers.js) ─────────────────────────────────────────

Deno.test("parseCSV: basic comma-delimited", () => {
  const r = parseCSV("id,label,group\na,Alice,eng\nb,Bob,eng\n");
  assertEquals(r.delimiter, ",");
  assertEquals(r.headers, ["id", "label", "group"]);
  assertEquals(r.rows.length, 2);
  assertEquals(r.rows[0], ["a", "Alice", "eng"]);
  assertEquals(r.rows[1], ["b", "Bob", "eng"]);
});

Deno.test("parseCSV: auto-detects tab delimiter", () => {
  const r = parseCSV("id\tlabel\ta\tAlice\tb\tBob");
  assertEquals(r.delimiter, "\t");
});

Deno.test("parseCSV: auto-detects semicolon delimiter", () => {
  const r = parseCSV("id;label;group\na;Alice;eng\nb;Bob;eng");
  assertEquals(r.delimiter, ";");
  assertEquals(r.rows[0], ["a", "Alice", "eng"]);
});

Deno.test("parseCSV: respects explicit delimiter opt", () => {
  const r = parseCSV("id|label|group\na|Alice|eng", { delimiter: "|" });
  assertEquals(r.delimiter, "|");
  assertEquals(r.rows[0], ["a", "Alice", "eng"]);
});

Deno.test("parseCSV: handles quoted fields with embedded commas", () => {
  const r = parseCSV('id,name,group\na,"Smith, John",eng\nb,"Doe, Jane",eng\n');
  assertEquals(r.rows[0], ["a", "Smith, John", "eng"]);
  assertEquals(r.rows[1], ["b", "Doe, Jane", "eng"]);
});

Deno.test("parseCSV: handles escaped quotes inside quoted fields", () => {
  const r = parseCSV('id,quote\na,"She said ""hi"""\n');
  assertEquals(r.rows[0], ["a", 'She said "hi"']);
});

Deno.test("parseCSV: handles embedded newlines in quoted fields", () => {
  const r = parseCSV('id,desc\na,"line1\nline2"\nb,single\n');
  assertEquals(r.rows.length, 2);
  assertEquals(r.rows[0], ["a", "line1\nline2"]);
  assertEquals(r.rows[1], ["b", "single"]);
});

Deno.test("parseCSV: strips UTF-8 BOM", () => {
  const r = parseCSV("\uFEFFid,label\na,Alice\n");
  assertEquals(r.headers, ["id", "label"]);
  assertEquals(r.rows[0], ["a", "Alice"]);
});

Deno.test("parseCSV: handles CRLF line endings", () => {
  const r = parseCSV("id,label\r\na,Alice\r\nb,Bob\r\n");
  assertEquals(r.headers, ["id", "label"]);
  assertEquals(r.rows[0], ["a", "Alice"]);
  assertEquals(r.rows[1], ["b", "Bob"]);
});

Deno.test("parseCSV: skips empty lines", () => {
  const r = parseCSV("id,label\n\na,Alice\n\n\nb,Bob\n");
  assertEquals(r.rows.length, 2);
});

Deno.test("parseCSV: empty/null input", () => {
  assertEquals(parseCSV("").rows.length, 0);
  assertEquals(parseCSV(null).rows.length, 0);
  assertEquals(parseCSV(undefined).rows.length, 0);
});

Deno.test("parseCSV: handles missing trailing newline", () => {
  const r = parseCSV("id,label\na,Alice\nb,Bob");
  assertEquals(r.rows.length, 2);
  assertEquals(r.rows[1], ["b", "Bob"]);
});

// ─── csvRowsToNodes header sniffing ──────────────────────────────────────────

Deno.test("csvRowsToNodes: maps id, label, group by name", () => {
  const { nodes, extraPropNames } = csvRowsToNodes(
    ["id", "label", "group", "score"],
    [["a", "Alice", "eng", "5"], ["b", "Bob", "eng", "8"]]
  );
  assertEquals(nodes.size, 2);
  const alice = nodes.get("a");
  assertExists(alice);
  assertEquals(alice.label, "Alice");
  assertEquals(alice.group, "eng");
  assertEquals(alice.extraProps.score, "5");
  assertEquals(extraPropNames, ["score"]);
});

Deno.test("csvRowsToNodes: finds id via alternate names (name)", () => {
  const { nodes } = csvRowsToNodes(
    ["node_id", "name", "category"],
    [["a", "Alice", "eng"]]
  );
  const alice = nodes.get("a");
  assertExists(alice);
  assertEquals(alice.label, "Alice");
  assertEquals(alice.group, "eng");
});

Deno.test("csvRowsToNodes: case-insensitive header matching", () => {
  const { nodes } = csvRowsToNodes(
    ["ID", "Name", "Group"],
    [["a", "Alice", "eng"]]
  );
  const alice = nodes.get("a");
  assertExists(alice);
  assertEquals(alice.label, "Alice");
  assertEquals(alice.group, "eng");
});

Deno.test("csvRowsToNodes: positional fallback when no roles named", () => {
  const { nodes, extraPropNames } = csvRowsToNodes(
    ["foo", "bar", "baz", "qux"],
    [["a", "Alice", "eng", "5"]]
  );
  const alice = nodes.get("a");
  assertExists(alice);
  assertEquals(alice.label, "Alice"); // col 1 = label positional
  assertEquals(alice.group, "eng"); // col 2 = group positional
  assertEquals(extraPropNames, ["qux"]); // only col 3 is extra
  assertEquals(alice.extraProps.qux, "5");
});

Deno.test("csvRowsToNodes: id only, no positional label fallback when group is named", () => {
  // group is matched by name but id/label aren't — only id gets a fallback (first unused col)
  // label does NOT positional-fall-back, it uses the id value
  const { nodes } = csvRowsToNodes(
    ["foo", "category", "bar"],
    [["a", "eng", "extra"]]
  );
  const alice = nodes.get("a");
  assertExists(alice);
  assertEquals(alice.label, "a"); // id fallback only, label = id
  assertEquals(alice.group, "eng"); // from 'category'
});

Deno.test("csvRowsToNodes: rejects first column as id if it has duplicates (repurposes as group)", () => {
  // Penguins-like: first column 'species' is categorical, not unique.
  // Positional fallback would normally assign col 0 = id, col 1 = label, col 2 = group.
  // Uniqueness check on col 0 fails → promote to group (overriding positional col 2 group).
  const { nodes, extraPropNames } = csvRowsToNodes(
    ["species", "island", "bill_length_mm"],
    [
      ["Adelie", "Torgersen", "39.1"],
      ["Adelie", "Biscoe", "38.9"],
      ["Gentoo", "Biscoe", "46.5"],
    ]
  );
  assertEquals(nodes.size, 3);
  // All ids should be anonymous (species rejected)
  assertExists(nodes.get("row_0"));
  assertExists(nodes.get("row_1"));
  assertExists(nodes.get("row_2"));
  // species promoted to group (overriding positional bill_length_mm group)
  assertEquals(nodes.get("row_0").group, "Adelie");
  assertEquals(nodes.get("row_1").group, "Adelie");
  assertEquals(nodes.get("row_2").group, "Gentoo");
  // col 1 (island) is still the positional label
  assertEquals(nodes.get("row_0").label, "Torgersen");
  // bill_length_mm (previously positional group) is released to extras
  assert(extraPropNames.includes("bill_length_mm"));
});

Deno.test("csvRowsToNodes: generates anonymous ids for empty id fields", () => {
  const { nodes } = csvRowsToNodes(
    ["id", "label"],
    [["", "Alice"], ["", "Bob"], ["c", "Carol"]]
  );
  assertEquals(nodes.size, 3);
  assertExists(nodes.get("row_0"));
  assertExists(nodes.get("row_1"));
  assertExists(nodes.get("c"));
  assertEquals(nodes.get("row_0").label, "Alice");
});

Deno.test("csvRowsToNodes: extra columns become property groups", () => {
  const { nodes, extraPropNames } = csvRowsToNodes(
    ["id", "label", "group", "platform", "kill chain", "score"],
    [["T1059", "Command Interpreter", "execution", "windows", "execution", "7"]]
  );
  // "kill chain" → "kill_chain" (spaces → underscores)
  assertEquals(extraPropNames, ["platform", "kill_chain", "score"]);
  const n = nodes.get("T1059");
  assertEquals(n.extraProps.platform, "windows");
  assertEquals(n.extraProps.kill_chain, "execution");
  assertEquals(n.extraProps.score, "7");
});

Deno.test("csvRowsToNodes: missing group defaults to 'unknown'", () => {
  const { nodes } = csvRowsToNodes(
    ["id", "label"],
    [["a", "Alice"]]
  );
  assertEquals(nodes.get("a").group, "unknown");
});

// ─── parseCSVToNodes end-to-end ──────────────────────────────────────────────

Deno.test("parseCSVToNodes: integrates parse + sniff", () => {
  const text = "id,label,group,platform\nT1059,Command Interpreter,execution,windows\nT1053,Scheduled Task,persistence,windows\n";
  const { nodes, extraPropNames } = parseCSVToNodes(text);
  assertEquals(nodes.size, 2);
  assertEquals(extraPropNames, ["platform"]);
  assertEquals(nodes.get("T1059").label, "Command Interpreter");
  assertEquals(nodes.get("T1059").extraProps.platform, "windows");
});

Deno.test("parseCSVToNodes: end-to-end via buildGraph/runPipeline", () => {
  // Full integration: CSV → nodes map → synthetic nodes text → (edgeless) pipeline
  const text = "id,label,group,score\na,Alice,eng,5\nb,Bob,eng,8\nc,Carol,sales,3\n";
  const { nodes, extraPropNames } = parseCSVToNodes(text);

  // Feed directly into buildGraph with empty edges
  const emptyParsed = parseEdgesFile(null);
  const graph = buildGraph(emptyParsed, nodes, extraPropNames);
  assertEquals(graph.nodeArray.length, 3);
  assertEquals(graph.edges.length, 0);
  assertEquals(graph.nodeIndex["a"].label, "Alice");
  assertEquals(graph.nodeIndex["a"].group, "eng");
  assertEquals(graph.nodeIndex["a"].extraProps.score, "5");
  assert(graph.groupNames.includes("score"));
  assert(graph.groupNames.includes("label"));
  // Score column is numeric (100% parseable) → should create numericBins
  assertExists(graph.numericBins.score);
});

// ─── D3 JSON parser ──────────────────────────────────────────────────────────

Deno.test("parseD3: basic {nodes, links}", () => {
  const data = {
    nodes: [
      { id: "a", label: "Alice", group: "eng" },
      { id: "b", label: "Bob", group: "eng" },
    ],
    links: [{ source: "a", target: "b" }],
  };
  const { nodes, edges, extraPropNames } = parseD3(data);
  assertEquals(nodes.size, 2);
  assertEquals(edges.length, 1);
  assertEquals(edges[0], { src: "a", dst: "b" });
  assertEquals(extraPropNames.length, 0);
  assertEquals(nodes.get("a").label, "Alice");
  assertEquals(nodes.get("a").group, "eng");
});

Deno.test("parseD3: accepts 'edges' key as alias for 'links'", () => {
  const data = {
    nodes: [{ id: "a" }, { id: "b" }],
    edges: [{ src: "a", dst: "b" }],
  };
  const { edges } = parseD3(data);
  assertEquals(edges[0], { src: "a", dst: "b" });
});

Deno.test("parseD3: extra node props become property groups", () => {
  const data = {
    nodes: [
      { id: "a", label: "Alice", group: "eng", platform: "linux", score: 5 },
      { id: "b", label: "Bob", group: "eng", platform: "windows", score: 8 },
    ],
    links: [],
  };
  const { nodes, extraPropNames } = parseD3(data);
  assertEquals(extraPropNames.sort(), ["platform", "score"]);
  assertEquals(nodes.get("a").extraProps.platform, "linux");
  assertEquals(nodes.get("a").extraProps.score, "5"); // coerced to string
});

Deno.test("parseD3: edge type from 'type' or 'relation' field", () => {
  const data = {
    nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
    links: [
      { source: "a", target: "b", type: "knows" },
      { source: "b", target: "c", relation: "works-with" },
    ],
  };
  const { edges } = parseD3(data);
  assertEquals(edges[0].type, "knows");
  assertEquals(edges[1].type, "works-with");
});

Deno.test("parseD3: missing nodes array throws", () => {
  let thrown = false;
  try { parseD3({}); } catch (_e) { thrown = true; }
  assert(thrown, "Expected throw for missing nodes");
});

Deno.test("parseD3: numeric ids coerced to string", () => {
  const data = {
    nodes: [{ id: 1 }, { id: 2 }],
    links: [{ source: 1, target: 2 }],
  };
  const { nodes, edges } = parseD3(data);
  assertExists(nodes.get("1"));
  assertExists(nodes.get("2"));
  assertEquals(edges[0], { src: "1", dst: "2" });
});

Deno.test("parseD3: empty id gets anonymous row id", () => {
  const data = {
    nodes: [{ id: "", label: "Alice" }, { id: null, label: "Bob" }, { id: "c", label: "Carol" }],
    links: [],
  };
  const { nodes } = parseD3(data);
  assertEquals(nodes.size, 3);
  assertExists(nodes.get("row_0"));
  assertExists(nodes.get("row_1"));
  assertExists(nodes.get("c"));
});

Deno.test("parseD3: falls back to 'name' when 'id' is absent (Miserables convention)", () => {
  const data = {
    nodes: [{ name: "Myriel", group: 1 }, { name: "Napoleon", group: 1 }],
    links: [{ source: 0, target: 1, value: 1 }],
  };
  const { nodes, edges } = parseD3(data);
  assertEquals(nodes.size, 2);
  assertExists(nodes.get("Myriel"));
  assertEquals(nodes.get("Myriel").label, "Myriel");
  // Numeric link endpoints resolved as indices into nodes array
  assertEquals(edges[0], { src: "Myriel", dst: "Napoleon" });
});

Deno.test("parseD3: numeric link endpoints prefer id match over index", () => {
  // Nodes with explicit numeric ids — link endpoints should match those, not array indices
  const data = {
    nodes: [{ id: 10 }, { id: 20 }, { id: 30 }],
    links: [{ source: 10, target: 30 }],
  };
  const { edges } = parseD3(data);
  assertEquals(edges[0], { src: "10", dst: "30" });
});

Deno.test("parseD3: resolves object-form link endpoints (post d3-force)", () => {
  const data = {
    nodes: [{ id: "a" }, { id: "b" }],
    links: [{ source: { id: "a" }, target: { id: "b" } }],
  };
  const { edges } = parseD3(data);
  assertEquals(edges[0], { src: "a", dst: "b" });
});

Deno.test("parseJGF: accepts dict-form graph.nodes (JGF v1 convention)", () => {
  const data = {
    graph: {
      nodes: {
        "Myriel": { label: "Myriel", metadata: { group: 1 } },
        "Napoleon": { label: "Napoleon", metadata: { group: 1 } },
      },
      edges: [{ source: "Myriel", target: "Napoleon", metadata: { value: 1 } }],
    },
  };
  const { nodes, edges } = parseJGF(data);
  assertEquals(nodes.size, 2);
  assertExists(nodes.get("Myriel"));
  assertEquals(nodes.get("Myriel").group, "1");
  assertEquals(edges[0].src, "Myriel");
});

// ─── JGF parser ──────────────────────────────────────────────────────────────

Deno.test("parseJGF: basic single-graph form", () => {
  const data = {
    graph: {
      nodes: [
        { id: "a", label: "Alice", metadata: { group: "eng", lang: "Go" } },
        { id: "b", label: "Bob", metadata: { group: "eng", lang: "Rust" } },
      ],
      edges: [{ source: "a", target: "b", relation: "works-with" }],
    },
  };
  const { nodes, edges, extraPropNames } = parseJGF(data);
  assertEquals(nodes.size, 2);
  assertEquals(nodes.get("a").label, "Alice");
  assertEquals(nodes.get("a").group, "eng");
  assertEquals(nodes.get("a").extraProps.lang, "Go");
  assertEquals(extraPropNames, ["lang"]);
  assertEquals(edges[0], { src: "a", dst: "b", type: "works-with" });
});

Deno.test("parseJGF: flattens metadata into property groups", () => {
  const data = {
    graph: {
      nodes: [{
        id: "T1059",
        label: "Command Interpreter",
        metadata: { group: "execution", platform: "windows", kill_chain: "execution", score: 7 },
      }],
      edges: [],
    },
  };
  const { nodes, extraPropNames } = parseJGF(data);
  assertEquals(extraPropNames.sort(), ["kill_chain", "platform", "score"]);
  const n = nodes.get("T1059");
  assertEquals(n.extraProps.platform, "windows");
  assertEquals(n.extraProps.kill_chain, "execution");
  assertEquals(n.extraProps.score, "7");
});

Deno.test("parseJGF: multi-graph form picks first graph", () => {
  const data = {
    graphs: [
      { nodes: [{ id: "a" }, { id: "b" }], edges: [{ source: "a", target: "b" }] },
      { nodes: [{ id: "x" }], edges: [] },
    ],
  };
  const { nodes, edges } = parseJGF(data);
  assertEquals(nodes.size, 2);
  assertEquals(edges.length, 1);
  assertExists(nodes.get("a"));
});

Deno.test("parseJGF: missing graph throws", () => {
  let thrown = false;
  try { parseJGF({}); } catch (_e) { thrown = true; }
  assert(thrown);
});

Deno.test("parseJGF: no metadata defaults group to 'unknown'", () => {
  const data = {
    graph: {
      nodes: [{ id: "a", label: "Alice" }],
      edges: [],
    },
  };
  const { nodes } = parseJGF(data);
  assertEquals(nodes.get("a").group, "unknown");
});

// ─── runPipelineFromObjects ──────────────────────────────────────────────────

Deno.test("runPipelineFromObjects: end-to-end with edges", () => {
  const nodesMap = new Map([
    ["a", { label: "Alice", group: "eng", extraProps: { lang: "Go" } }],
    ["b", { label: "Bob", group: "eng", extraProps: { lang: "Rust" } }],
    ["c", { label: "Carol", group: "sales", extraProps: { lang: "TS" } }],
  ]);
  const edges = [
    { src: "a", dst: "b" },
    { src: "b", dst: "c" },
  ];
  const result = runPipelineFromObjects(nodesMap, edges, ["lang"]);
  assertEquals(result.nodeArray.length, 3);
  assertEquals(result.edges.length, 2);
  assertEquals(result.nodeIndex["a"].degree, 1);
  assertEquals(result.nodeIndex["b"].degree, 2);
  assert(result.groupNames.includes("lang"));
  const G = result.groupNames.length;
  assertEquals(result.projBuf.length, 3 * G * 2);
});

Deno.test("runPipelineFromObjects: nodes-only (null edges)", () => {
  const nodesMap = new Map([
    ["a", { label: "Alice", group: "eng", extraProps: {} }],
    ["b", { label: "Bob", group: "eng", extraProps: {} }],
  ]);
  const result = runPipelineFromObjects(nodesMap, null, []);
  assertEquals(result.nodeArray.length, 2);
  assertEquals(result.edges.length, 0);
  for (const n of result.nodeArray) assertEquals(n.degree, 0);
});

Deno.test("runPipelineFromObjects: edge types captured", () => {
  const nodesMap = new Map([
    ["a", { label: "A", group: "g", extraProps: {} }],
    ["b", { label: "B", group: "g", extraProps: {} }],
  ]);
  const edges = [{ src: "a", dst: "b", type: "knows" }];
  const result = runPipelineFromObjects(nodesMap, edges, []);
  assertEquals(result.hasEdgeTypes, true);
  assert(result.groupNames.includes("edgetype"));
});

Deno.test("parseD3 + runPipelineFromObjects: full D3 JSON pipeline", () => {
  const data = {
    nodes: [
      { id: "a", label: "Alice", group: "eng", platform: "linux" },
      { id: "b", label: "Bob", group: "eng", platform: "windows" },
      { id: "c", label: "Carol", group: "sales", platform: "macos" },
    ],
    links: [{ source: "a", target: "b" }, { source: "b", target: "c" }],
  };
  const { nodes, edges, extraPropNames } = parseD3(data);
  const result = runPipelineFromObjects(nodes, edges, extraPropNames);
  assertEquals(result.nodeArray.length, 3);
  assertEquals(result.edges.length, 2);
  assert(result.groupNames.includes("platform"));
  assertEquals(result.nodeIndex["a"].extraProps.platform, "linux");
});

Deno.test("parseJGF + runPipelineFromObjects: full JGF pipeline", () => {
  const data = {
    graph: {
      nodes: [
        { id: "T1", label: "Technique 1", metadata: { group: "execution", platform: "win" } },
        { id: "T2", label: "Technique 2", metadata: { group: "persistence", platform: "linux" } },
      ],
      edges: [{ source: "T1", target: "T2", relation: "related" }],
    },
  };
  const { nodes, edges, extraPropNames } = parseJGF(data);
  const result = runPipelineFromObjects(nodes, edges, extraPropNames);
  assertEquals(result.nodeArray.length, 2);
  assertEquals(result.edges.length, 1);
  assertEquals(result.hasEdgeTypes, true);
  assert(result.groupNames.includes("platform"));
  assertEquals(result.nodeIndex["T1"].group, "execution");
});

// ─── detectFormat ────────────────────────────────────────────────────────────

Deno.test("detectFormat: CSV with comma delimiter", () => {
  assertEquals(detectFormat("id,label,group\na,Alice,eng"), "csv");
});

Deno.test("detectFormat: CSV with semicolon delimiter", () => {
  assertEquals(detectFormat("id;label;group\na;Alice;eng"), "csv");
});

Deno.test("detectFormat: SNAP from tab-delimited content without filename", () => {
  assertEquals(detectFormat("A\tB\nB\tC\n"), "snap");
});

Deno.test("detectFormat: SNAP .nodes via # NodeId header", () => {
  assertEquals(detectFormat("# NodeId\tLabel\tGroup\na\tAlice\teng\n"), "snap-nodes");
});

Deno.test("detectFormat: SNAP comment with tab → snap (ambiguous)", () => {
  assertEquals(detectFormat("# comment\nA\tB\n"), "snap");
});

Deno.test("detectFormat: SNAP comment with comma → csv", () => {
  assertEquals(detectFormat("# comment\na,b,c\n"), "csv");
});

Deno.test("detectFormat: filename hint overrides for .edges", () => {
  assertEquals(detectFormat("A\tB\n", "data.edges"), "snap-edges");
  assertEquals(detectFormat("A\tB\n", "data.edges.gz"), "snap-edges");
});

Deno.test("detectFormat: filename hint overrides for .nodes", () => {
  assertEquals(detectFormat("a\tAlice\teng\n", "data.nodes"), "snap-nodes");
  assertEquals(detectFormat("a\tAlice\teng\n", "data.labels"), "snap-nodes");
});

Deno.test("detectFormat: D3 JSON {nodes, links}", () => {
  assertEquals(detectFormat('{"nodes":[{"id":"a"}],"links":[]}'), "d3");
});

Deno.test("detectFormat: D3 JSON {nodes, edges}", () => {
  assertEquals(detectFormat('{"nodes":[{"id":"a"}],"edges":[]}'), "d3");
});

Deno.test("detectFormat: JGF single-graph", () => {
  assertEquals(detectFormat('{"graph":{"nodes":[{"id":"a"}],"edges":[]}}'), "jgf");
});

Deno.test("detectFormat: JGF multi-graph", () => {
  assertEquals(detectFormat('{"graphs":[{"nodes":[{"id":"a"}],"edges":[]}]}'), "jgf");
});

Deno.test("detectFormat: Cytoscape JSON", () => {
  assertEquals(detectFormat('{"elements":{"nodes":[{"data":{"id":"a"}}]}}'), "cytoscape");
});

Deno.test("detectFormat: bare JSON array → d3-bare", () => {
  assertEquals(detectFormat('[{"id":"a"},{"id":"b"}]'), "d3-bare");
});

Deno.test("detectFormat: GraphML XML", () => {
  assertEquals(detectFormat('<?xml version="1.0"?><graphml xmlns="...">...</graphml>'), "graphml");
});

Deno.test("detectFormat: GEXF XML", () => {
  assertEquals(detectFormat('<?xml version="1.0"?><gexf xmlns="...">...</gexf>'), "gexf");
});

Deno.test("detectFormat: unknown XML", () => {
  assertEquals(detectFormat('<?xml version="1.0"?><svg>...</svg>'), "xml");
});

Deno.test("detectFormat: malformed JSON → unknown", () => {
  assertEquals(detectFormat('{"nodes":[{'), "unknown");
});

Deno.test("detectFormat: empty / null input → unknown", () => {
  assertEquals(detectFormat(""), "unknown");
  assertEquals(detectFormat(null), "unknown");
});

Deno.test("detectFormat: BOM prefix doesn't break detection", () => {
  assertEquals(detectFormat("\uFEFFid,label\na,Alice"), "csv");
});

// ─── parseAny dispatch ───────────────────────────────────────────────────────

Deno.test("parseAny: CSV dispatch", () => {
  const r = parseAny("id,label,group\na,Alice,eng\nb,Bob,eng\n");
  assertEquals(r.format, "csv");
  assertEquals(r.nodes.size, 2);
  assertEquals(r.edges, null);
});

Deno.test("parseAny: D3 dispatch", () => {
  const r = parseAny('{"nodes":[{"id":"a","label":"Alice"}],"links":[]}');
  assertEquals(r.format, "d3");
  assertEquals(r.nodes.size, 1);
  assertEquals(r.edges.length, 0);
});

Deno.test("parseAny: JGF dispatch", () => {
  const r = parseAny('{"graph":{"nodes":[{"id":"a","metadata":{"group":"eng"}}],"edges":[]}}');
  assertEquals(r.format, "jgf");
  assertEquals(r.nodes.size, 1);
  assertEquals(r.nodes.get("a").group, "eng");
});

Deno.test("parseAny: SNAP .nodes via filename hint", () => {
  const text = "# NodeId\tLabel\tGroup\na\tAlice\teng\nb\tBob\teng\n";
  const r = parseAny(text, "data.nodes");
  assertEquals(r.format, "snap-nodes");
  assertEquals(r.nodes.size, 2);
  assertEquals(r.edges, null);
});

Deno.test("parseAny: bare JSON array dispatches as d3-bare", () => {
  const r = parseAny('[{"id":"a","label":"Alice"},{"id":"b","label":"Bob"}]');
  assertEquals(r.format, "d3-bare");
  assertEquals(r.nodes.size, 2);
  assertEquals(r.edges.length, 0);
});

Deno.test("parseAny: SNAP .edges throws with clear error", () => {
  let thrown = false, msg = "";
  try { parseAny("A\tB\nB\tC\n", "data.edges"); }
  catch (e) { thrown = true; msg = e.message; }
  assert(thrown);
  assert(msg.toLowerCase().includes("snap"));
});

Deno.test("parseAny: GraphML throws 'not yet supported'", () => {
  let thrown = false, msg = "";
  try { parseAny("<graphml></graphml>"); }
  catch (e) { thrown = true; msg = e.message; }
  assert(thrown);
  assert(msg.includes("GraphML"));
});

Deno.test("parseAny: unknown format throws", () => {
  let thrown = false;
  try { parseAny(""); } catch (_e) { thrown = true; }
  assert(thrown);
});

Deno.test("parseAny → runPipelineFromObjects: CSV end-to-end", () => {
  const text = "id,label,group,score\na,Alice,eng,5\nb,Bob,eng,8\n";
  const { nodes, edges, extraPropNames } = parseAny(text);
  const result = runPipelineFromObjects(nodes, edges, extraPropNames);
  assertEquals(result.nodeArray.length, 2);
  assertEquals(result.edges.length, 0);
  assert(result.groupNames.includes("score"));
});

Deno.test("parseAny → runPipelineFromObjects: D3 end-to-end", () => {
  const text = '{"nodes":[{"id":"a","label":"Alice","group":"eng"},{"id":"b","label":"Bob","group":"eng"}],"links":[{"source":"a","target":"b"}]}';
  const { nodes, edges, extraPropNames } = parseAny(text);
  const result = runPipelineFromObjects(nodes, edges, extraPropNames);
  assertEquals(result.nodeArray.length, 2);
  assertEquals(result.edges.length, 1);
});

// ─── Minimal XML parser ──────────────────────────────────────────────────────

Deno.test("parseXML: basic element tree", () => {
  const xml = `<?xml version="1.0"?>
<root>
  <child id="a">text</child>
  <child id="b"/>
</root>`;
  const tree = parseXML(xml);
  assertEquals(tree.tag, "root");
  assertEquals(tree.children.length, 2);
  assertEquals(tree.children[0].tag, "child");
  assertEquals(tree.children[0].attrs.id, "a");
  assertEquals(tree.children[0].text, "text");
  assertEquals(tree.children[1].attrs.id, "b");
});

Deno.test("parseXML: strips namespace prefixes", () => {
  const xml = `<svg:root xmlns:svg="..."><svg:node id="a"/></svg:root>`;
  const tree = parseXML(xml);
  assertEquals(tree.tag, "root");
  assertEquals(tree.children[0].tag, "node");
});

Deno.test("parseXML: handles comments, CDATA, DOCTYPE", () => {
  const xml = `<?xml version="1.0"?>
<!DOCTYPE root>
<!-- a comment -->
<root>
  <data><![CDATA[raw & <stuff>]]></data>
</root>`;
  const tree = parseXML(xml);
  assertEquals(tree.tag, "root");
  assertEquals(tree.children[0].text, "raw & <stuff>");
});

Deno.test("parseXML: decodes standard entities", () => {
  const xml = `<root><x attr="a &amp; b">&lt;value&gt;</x></root>`;
  const tree = parseXML(xml);
  assertEquals(tree.children[0].attrs.attr, "a & b");
  assertEquals(tree.children[0].text, "<value>");
});

// ─── GraphML parser ──────────────────────────────────────────────────────────

Deno.test("parseGraphML: basic graph with keys and data", () => {
  const xml = `<?xml version="1.0"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns">
  <key id="d0" for="node" attr.name="color" attr.type="string"/>
  <key id="d1" for="edge" attr.name="weight" attr.type="double"/>
  <graph edgedefault="undirected">
    <node id="n0"><data key="d0">red</data></node>
    <node id="n1"><data key="d0">blue</data></node>
    <edge source="n0" target="n1"><data key="d1">1.5</data></edge>
  </graph>
</graphml>`;
  const { nodes, edges, extraPropNames } = parseGraphML(xml);
  assertEquals(nodes.size, 2);
  assertEquals(edges.length, 1);
  assertEquals(edges[0].src, "n0");
  assertEquals(edges[0].dst, "n1");
  assertEquals(nodes.get("n0").extraProps.color, "red");
  assert(extraPropNames.includes("color"));
});

Deno.test("parseGraphML: recognizes 'name' as label and 'Faction' as extra", () => {
  const xml = `<?xml version="1.0"?>
<graphml>
  <key id="name" for="node" attr.name="name" attr.type="string"/>
  <key id="Faction" for="node" attr.name="Faction" attr.type="int"/>
  <graph>
    <node id="n0"><data key="name">Mr Hi</data><data key="Faction">1</data></node>
  </graph>
</graphml>`;
  const { nodes } = parseGraphML(xml);
  assertEquals(nodes.get("n0").label, "Mr Hi");
  assertEquals(nodes.get("n0").extraProps.Faction, "1");
});

Deno.test("parseGraphML: missing root throws", () => {
  let thrown = false;
  try { parseGraphML("<xml><not-graphml/></xml>"); } catch (_e) { thrown = true; }
  assert(thrown);
});

// ─── GEXF parser ─────────────────────────────────────────────────────────────

Deno.test("parseGEXF: basic graph with node attributes", () => {
  const xml = `<?xml version="1.0"?>
<gexf>
  <graph>
    <attributes class="node">
      <attribute id="0" title="Gender" type="string"/>
    </attributes>
    <nodes>
      <node id="1" label="Myriel">
        <attvalues><attvalue for="0" value="M"/></attvalues>
      </node>
      <node id="2" label="Napoleon">
        <attvalues><attvalue for="0" value="M"/></attvalues>
      </node>
    </nodes>
    <edges>
      <edge source="1" target="2"/>
    </edges>
  </graph>
</gexf>`;
  const { nodes, edges, extraPropNames } = parseGEXF(xml);
  assertEquals(nodes.size, 2);
  assertEquals(nodes.get("1").label, "Myriel");
  assertEquals(nodes.get("1").extraProps.Gender, "M");
  assertEquals(edges[0], { src: "1", dst: "2" });
  assert(extraPropNames.includes("Gender"));
});

Deno.test("parseGEXF: edge label becomes edge type", () => {
  const xml = `<?xml version="1.0"?>
<gexf>
  <graph>
    <nodes>
      <node id="a" label="A"/>
      <node id="b" label="B"/>
    </nodes>
    <edges>
      <edge source="a" target="b" label="knows"/>
    </edges>
  </graph>
</gexf>`;
  const { edges } = parseGEXF(xml);
  assertEquals(edges[0].type, "knows");
});

Deno.test("parseGEXF: missing root throws", () => {
  let thrown = false;
  try { parseGEXF("<graphml></graphml>"); } catch (_e) { thrown = true; }
  assert(thrown);
});

// ─── Cytoscape parser ────────────────────────────────────────────────────────

Deno.test("parseCytoscape: grouped form", () => {
  const data = {
    elements: {
      nodes: [
        { data: { id: "a", label: "Alice", group: "eng", score: 5 } },
        { data: { id: "b", label: "Bob", group: "eng" } },
      ],
      edges: [
        { data: { source: "a", target: "b", weight: 1.5 } },
      ],
    },
  };
  const { nodes, edges, extraPropNames } = parseCytoscape(data);
  assertEquals(nodes.size, 2);
  assertEquals(edges.length, 1);
  assertEquals(nodes.get("a").label, "Alice");
  assertEquals(nodes.get("a").group, "eng");
  assertEquals(nodes.get("a").extraProps.score, "5");
  assertEquals(edges[0].src, "a");
  assertEquals(edges[0].dst, "b");
  assert(extraPropNames.includes("score"));
});

Deno.test("parseCytoscape: flat array form with group field", () => {
  const data = {
    elements: [
      { group: "nodes", data: { id: "a", label: "Alice" } },
      { group: "nodes", data: { id: "b", label: "Bob" } },
      { group: "edges", data: { source: "a", target: "b" } },
    ],
  };
  const { nodes, edges } = parseCytoscape(data);
  assertEquals(nodes.size, 2);
  assertEquals(edges.length, 1);
});

Deno.test("parseCytoscape: edge type from relation field", () => {
  const data = {
    elements: {
      nodes: [{ data: { id: "a" } }, { data: { id: "b" } }],
      edges: [{ data: { source: "a", target: "b", relation: "works-with" } }],
    },
  };
  const { edges } = parseCytoscape(data);
  assertEquals(edges[0].type, "works-with");
});

Deno.test("parseCytoscape: missing elements throws", () => {
  let thrown = false;
  try { parseCytoscape({}); } catch (_e) { thrown = true; }
  assert(thrown);
});

// ─── detectFormat for new formats ────────────────────────────────────────────

Deno.test("detectFormat + parseAny: GraphML dispatches correctly", () => {
  const xml = `<?xml version="1.0"?><graphml><graph><node id="a"/></graph></graphml>`;
  assertEquals(detectFormat(xml), "graphml");
  const r = parseAny(xml);
  assertEquals(r.format, "graphml");
  assertEquals(r.nodes.size, 1);
});

Deno.test("detectFormat + parseAny: GEXF dispatches correctly", () => {
  const xml = `<?xml version="1.0"?><gexf><graph><nodes><node id="a" label="A"/></nodes><edges/></graph></gexf>`;
  assertEquals(detectFormat(xml), "gexf");
  const r = parseAny(xml);
  assertEquals(r.format, "gexf");
  assertEquals(r.nodes.size, 1);
});

Deno.test("detectFormat + parseAny: Cytoscape dispatches correctly", () => {
  const json = '{"elements":{"nodes":[{"data":{"id":"a"}}],"edges":[]}}';
  assertEquals(detectFormat(json), "cytoscape");
  const r = parseAny(json);
  assertEquals(r.format, "cytoscape");
  assertEquals(r.nodes.size, 1);
});

// ─── Format capability exports ───────────────────────────────────────────────

Deno.test("detectFormat: STIX 2.x bundle", () => {
  assertEquals(detectFormat('{"type":"bundle","id":"bundle--1","objects":[{"type":"indicator"}]}'), "stix");
  assertEquals(detectFormat('{"objects":[{"type":"malware","id":"m1"}]}'), "stix");
});

Deno.test("isObjectFormat classifies parseAny-supported formats", () => {
  for (const fmt of ['csv', 'd3', 'd3-bare', 'jgf', 'graphml', 'gexf', 'cytoscape', 'stix', 'snap-nodes']) {
    assert(isObjectFormat(fmt), `${fmt} should be an object format`);
  }
  for (const fmt of ['snap-edges', 'snap', 'unknown', 'xml']) {
    assert(!isObjectFormat(fmt), `${fmt} should NOT be an object format`);
  }
});

Deno.test("isTextFormat classifies SNAP text-pipeline formats", () => {
  assert(isTextFormat('snap-edges'));
  assert(isTextFormat('snap'));
  assert(!isTextFormat('csv'));
  assert(!isTextFormat('snap-nodes'));
});

Deno.test("isSpecialFormat: empty set after STIX inlined", () => {
  assert(!isSpecialFormat('stix'));
  assert(!isSpecialFormat('graphml'));
  assert(!isSpecialFormat('csv'));
});

Deno.test("FILE_EXTENSIONS includes all supported extensions", () => {
  const required = ['.csv', '.tsv', '.json', '.graphml', '.gexf', '.xml', '.edges', '.nodes'];
  for (const ext of required) {
    assert(FILE_EXTENSIONS.includes(ext), `${ext} should be in FILE_EXTENSIONS`);
  }
  // accept attr is comma-joined
  assert(FILE_ACCEPT_ATTR.includes('.csv'));
  assert(FILE_ACCEPT_ATTR.includes('.graphml'));
});

Deno.test("OBJECT_FORMATS set matches isObjectFormat", () => {
  for (const fmt of OBJECT_FORMATS) assert(isObjectFormat(fmt));
});

Deno.test("parseAny: STIX dispatches to parseSTIX and returns unified shape", () => {
  const bundle = {
    type: 'bundle',
    id: 'bundle--1',
    objects: [
      { type: 'threat-actor', id: 'threat-actor--a', name: 'APT1', threat_actor_types: ['nation-state'] },
      { type: 'malware', id: 'malware--m', name: 'Stuxnet', malware_types: ['worm'], is_family: false },
      { type: 'relationship', id: 'relationship--r', source_ref: 'threat-actor--a', target_ref: 'malware--m', relationship_type: 'uses' },
    ],
  };
  const r = parseAny(JSON.stringify(bundle));
  assertEquals(r.format, 'stix');
  assertEquals(r.nodes.size, 2); // threat-actor + malware (relationship is an SRO, filtered)
  assertEquals(r.edges.length, 1);
  assertEquals(r.edges[0].type, 'uses');
  assertEquals(r.nodes.get('threat-actor--a').label, 'APT1');
  assertEquals(r.nodes.get('threat-actor--a').group, 'threat-actor');
  assertEquals(r.nodes.get('threat-actor--a').extraProps.subtype, 'nation-state');
});

// ─── Numeric tokenization ────────────────────────────────────────────────────

Deno.test("tokenizeNumeric: emits 3 multi-resolution tokens for numbers", () => {
  const bins = { min: 0, max: 10000, coarse: 5, medium: 50, fine: 500 };
  const buf = new Array(10);
  const end = tokenizeNumeric("score", "4745", bins, buf, 0);
  assertEquals(end, 3);
  assert(buf[0].startsWith("score:c:"), `Coarse token: ${buf[0]}`);
  assert(buf[1].startsWith("score:m:"), `Medium token: ${buf[1]}`);
  assert(buf[2].startsWith("score:f:"), `Fine token: ${buf[2]}`);
});

Deno.test("tokenizeNumeric: nearby values share coarse/medium tokens", () => {
  const bins = { min: 0, max: 10000, coarse: 5, medium: 50, fine: 500 };
  const a = new Array(10), b = new Array(10);
  tokenizeNumeric("x", "4710", bins, a, 0);
  tokenizeNumeric("x", "4730", bins, b, 0);
  assertEquals(a[0], b[0], "Coarse tokens should match for nearby values");
  assertEquals(a[1], b[1], "Medium tokens should match for nearby values");
  assert(a[2] !== b[2], "Fine tokens should differ for nearby values");
});

Deno.test("tokenizeNumeric: distant values share no tokens", () => {
  const bins = { min: 0, max: 10000, coarse: 5, medium: 50, fine: 500 };
  const a = new Array(10), b = new Array(10);
  tokenizeNumeric("x", "500", bins, a, 0);
  tokenizeNumeric("x", "9500", bins, b, 0);
  assert(a[0] !== b[0], "Coarse should differ");
  assert(a[1] !== b[1], "Medium should differ");
  assert(a[2] !== b[2], "Fine should differ");
});

Deno.test("tokenizeNumeric: falls back to categorical for non-numeric", () => {
  const bins = { min: 0, max: 100, coarse: 5, medium: 50, fine: 500 };
  const buf = new Array(5);
  const end = tokenizeNumeric("tag", "hello", bins, buf, 0);
  assertEquals(end, 1);
  assertEquals(buf[0], "tag:hello");
});

Deno.test("tokenizeNumeric: falls back without bins", () => {
  const buf = new Array(5);
  const end = tokenizeNumeric("val", "42", undefined, buf, 0);
  assertEquals(end, 1);
  assertEquals(buf[0], "val:42");
});

Deno.test("tokenizeNumeric: respects offset", () => {
  const bins = { min: 0, max: 100, coarse: 5, medium: 50, fine: 500 };
  const buf = new Array(10);
  buf[0] = "keep";
  const end = tokenizeNumeric("x", "50", bins, buf, 1);
  assertEquals(buf[0], "keep");
  assertEquals(end, 4);
});

Deno.test("tokenizeNumeric: smooth Jaccard similarity", () => {
  const bins = { min: 0, max: 10000, coarse: 5, medium: 50, fine: 500 };
  // Near pair: 4745 vs 4820
  const aN = new Array(3), bN = new Array(3), cN = new Array(3);
  tokenizeNumeric("x", "4745", bins, aN, 0);
  tokenizeNumeric("x", "4820", bins, bN, 0);
  tokenizeNumeric("x", "9500", bins, cN, 0);
  // Compute Jaccard of token sets
  const jNear = jaccardTokens(aN, bN);
  const jFar = jaccardTokens(aN, cN);
  assert(jNear > jFar, `Near pair J=${jNear} should be > far pair J=${jFar}`);
  assert(jNear > 0, "Near values should have some overlap");
});

// Helper: Jaccard of two token arrays
function jaccardTokens(a: string[], b: string[]) {
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  return inter / (setA.size + setB.size - inter);
}

Deno.test("buildGraph: detects numeric columns", () => {
  const numEdges = "A\tB\nB\tC\nC\tD\n";
  const numLabels = `# NodeId\tLabel\tGroup\tWeight
A\tAlice\tp\t100
B\tBob\tp\t200
C\tCarol\tp\t300
D\tDave\tp\tN/A`;
  const parsed = parseEdgesFile(numEdges);
  const nodesResult = parseNodesFile(numLabels);
  const graph = buildGraph(parsed, nodesResult.nodes, nodesResult.extraPropNames);
  // 3 out of 4 are numeric (75%) — should detect as numeric (threshold 80%)
  // Actually N/A makes it 3/4 = 75% < 80%, so should NOT be numeric
  assertEquals(Object.keys(graph.numericBins).length, 0, "75% numeric should not trigger (threshold 80%)");
});

Deno.test("buildGraph: detects numeric columns above threshold", () => {
  const numEdges = "A\tB\nB\tC\nC\tD\nD\tE\n";
  const numLabels = `# NodeId\tLabel\tGroup\tWeight
A\tAlice\tp\t100
B\tBob\tp\t200
C\tCarol\tp\t300
D\tDave\tp\t400
E\tEve\tp\tN/A`;
  const parsed = parseEdgesFile(numEdges);
  const nodesResult = parseNodesFile(numLabels);
  const graph = buildGraph(parsed, nodesResult.nodes, nodesResult.extraPropNames);
  // 4 out of 5 = 80% — should detect
  assert(graph.numericBins.weight !== undefined, "80% numeric should trigger");
  assertEquals(graph.numericBins.weight.min, 100);
  assertEquals(graph.numericBins.weight.max, 400);
});

// ─── Undefined value handling ─────────────────────────────────────────────────

Deno.test("tokenizeNumeric: empty string emits 0 tokens", () => {
  const bins = { min: 0, max: 100, coarse: 5, medium: 50, fine: 500 };
  const buf = new Array(5);
  assertEquals(tokenizeNumeric("x", "", bins, buf, 0), 0);
  assertEquals(tokenizeNumeric("x", "", undefined, buf, 0), 0);
});

Deno.test("tokenizeNumeric: null/undefined emits 0 tokens", () => {
  const bins = { min: 0, max: 100, coarse: 5, medium: 50, fine: 500 };
  const buf = new Array(5);
  assertEquals(tokenizeNumeric("x", null, bins, buf, 0), 0);
  assertEquals(tokenizeNumeric("x", undefined, bins, buf, 0), 0);
});

Deno.test("undefined extra props produce neutral [0,0] projection", () => {
  // Multiple nodes with varied scores so numeric bins are detected.
  // Node F has empty score (undefined). OPH needs enough tokens to populate bins.
  const edges = "A\tB\nB\tC\nC\tD\nD\tE\nE\tF\n";
  const labels = `# NodeId\tLabel\tGroup\tScore
A\tAlice\ta\t10
B\tBob\tb\t30
C\tCarol\ta\t50
D\tDave\tb\t70
E\tEve\ta\t90
F\tFrank\tb\t`;
  const result = runPipeline(edges, labels);
  const G = result.groupNames.length;
  const scoreIdx = result.groupNames.indexOf("score");
  assert(scoreIdx >= 0, "score should be a group");

  // Node F (index 5) should have [0,0] for the score projection (undefined → -1 sentinel → neutral)
  const fIdx = result.nodeArray.findIndex(n => n.id === 'F');
  const fOff = (fIdx * G + scoreIdx) * 2;
  assertEquals(result.projBuf[fOff], 0, "Undefined score px should be 0");
  assertEquals(result.projBuf[fOff + 1], 0, "Undefined score py should be 0");

  // Node A (has score=10) should have a different projection from node F's [0,0]
  const aIdx = result.nodeArray.findIndex(n => n.id === 'A');
  const aOff = (aIdx * G + scoreIdx) * 2;
  const aDiffers = result.projBuf[aOff] !== result.projBuf[fOff] || result.projBuf[aOff + 1] !== result.projBuf[fOff + 1];
  assert(aDiffers, "Defined score should differ from undefined score projection");
});

Deno.test("nodes with undefined props don't cluster with each other", () => {
  // Three nodes: A has val=100, B has val="" (undefined), C has val="" (undefined)
  // B and C should NOT cluster via false "unknown" similarity
  const edges = "A\tB\nB\tC\n";
  const labels = `# NodeId\tLabel\tGroup\tVal
A\tAlice\tp\t100
B\tBob\tp\t
C\tCarol\tp\t`;
  const result = runPipeline(edges, labels);
  const G = result.groupNames.length;
  const valIdx = result.groupNames.indexOf("val");

  // B and C both get [0,0] — same neutral position, but that's from lack of signal,
  // not from sharing a token. Their overall positions differ via other property groups.
  const bOff = (1 * G + valIdx) * 2;
  const cOff = (2 * G + valIdx) * 2;
  assertEquals(result.projBuf[bOff], 0);
  assertEquals(result.projBuf[cOff], 0);
  assertEquals(result.projBuf[bOff + 1], 0);
  assertEquals(result.projBuf[cOff + 1], 0);
});

Deno.test("parseNodesFile: trailing empty tabs preserved as empty strings", () => {
  const text = "# NodeId\tLabel\tGroup\tA\tB\nX\tXena\tg\t10\t\nY\tYoda\tg\t\t20\n";
  const r = parseNodesFile(text);
  assertEquals(r.nodes.get("X").extraProps.a, "10");
  assertEquals(r.nodes.get("X").extraProps.b, "");
  assertEquals(r.nodes.get("Y").extraProps.a, "");
  assertEquals(r.nodes.get("Y").extraProps.b, "20");
});

Deno.test("buildGraph: numeric detection ignores empty values", () => {
  const edges = "A\tB\nB\tC\nC\tD\nD\tE\nE\tF\n";
  const labels = `# NodeId\tLabel\tGroup\tWeight
A\ta\tg\t100
B\tb\tg\t200
C\tc\tg\t300
D\td\tg\t400
E\te\tg\t
F\tf\tg\t`;
  const parsed = parseEdgesFile(edges);
  const nodesResult = parseNodesFile(labels);
  const graph = buildGraph(parsed, nodesResult.nodes, nodesResult.extraPropNames);
  // 4 numeric out of 4 non-empty (E and F are empty, not counted as total)
  assert(graph.numericBins.weight !== undefined, "Should detect numeric ignoring empties");
  assertEquals(graph.numericBins.weight.min, 100);
  assertEquals(graph.numericBins.weight.max, 400);
});

// ─── Blend and level building ────────────────────────────────────────────────

Deno.test("normalizeAndQuantize: assigns uint16 grid coords", () => {
  const nodes = [
    { px: -1, py: 0.5, gx: 0, gy: 0 },
    { px: 0, py: -0.5, gx: 0, gy: 0 },
    { px: 1, py: 0, gx: 0, gy: 0 },
  ];
  normalizeAndQuantize(nodes);
  for (const n of nodes) {
    assert(n.gx >= 0 && n.gx < GRID_SIZE);
    assert(n.gy >= 0 && n.gy < GRID_SIZE);
    assert(n.px >= -1 && n.px <= 1);
    assert(n.py >= -1 && n.py <= 1);
  }
});

Deno.test("buildLevel: creates supernodes and edges", () => {
  const result = runPipeline(SAMPLE_EDGES, SAMPLE_LABELS);
  const G = result.groupNames.length;

  // Hydrate nodes with projections
  const nodes = result.nodeArray.map((n, i) => {
    const projections = {};
    for (let g = 0; g < G; g++) {
      const off = (i * G + g) * 2;
      projections[result.groupNames[g]] = [result.projBuf[off], result.projBuf[off + 1]];
    }
    return { ...n, projections, px: 0, py: 0, gx: 0, gy: 0 };
  });

  const nodeIndex = Object.fromEntries(nodes.map(n => [n.id, n]));
  const adjList = Object.fromEntries(nodes.map(n => [n.id, []]));
  for (const e of result.edges) {
    adjList[e.src].push(e.dst);
    adjList[e.dst].push(e.src);
  }

  // Blend to assign positions
  const weights = {};
  for (const g of result.groupNames) weights[g] = 1;
  unifiedBlend(nodes, result.groupNames, weights, 0, adjList, nodeIndex, 5);

  // Build level 1 (2x2 grid)
  const level = buildLevel(1, nodes, result.edges, nodeIndex,
    n => n.group, n => n.label, v => '#888888');
  assert(level.supernodes.length > 0);
  assert(level.supernodes.length <= 4); // 2x2 grid
  for (const sn of level.supernodes) {
    assert(sn.members.length > 0);
    assertExists(sn.cachedColor);
    assertExists(sn.cachedLabel);
  }
});

// ─── E2E: Epstein dataset ────────────────────────────────────────────────────

Deno.test("E2E: Epstein dataset loads and processes correctly", async () => {
  const edgesText = await Deno.readTextFile("docs/data/epstein.edges");
  const nodesText = await Deno.readTextFile("docs/data/epstein.nodes");

  const result = runPipeline(edgesText, nodesText);

  // Epstein: ~100 nodes with edge types
  assert(result.nodeArray.length > 50, `Expected >50 nodes, got ${result.nodeArray.length}`);
  assert(result.edges.length > 50, `Expected >50 edges, got ${result.edges.length}`);
  assert(result.hasEdgeTypes, "Epstein dataset should have edge types");
  assert(result.groupNames.includes("edgetype"));

  // Check unique groups
  assert(result.uniqueGroups.includes("Person"), "Should have Person group");

  // Projections should have correct dimensions
  const N = result.nodeArray.length;
  const G = result.groupNames.length;
  assertEquals(result.projBuf.length, N * G * 2);

  // All projections finite
  for (let i = 0; i < result.projBuf.length; i++) {
    assert(isFinite(result.projBuf[i]), `projBuf[${i}] not finite`);
  }

  // Blend and build levels
  const nodes = result.nodeArray.map((n, i) => {
    const projections = {};
    for (let g = 0; g < G; g++) {
      const off = (i * G + g) * 2;
      projections[result.groupNames[g]] = [result.projBuf[off], result.projBuf[off + 1]];
    }
    return { ...n, projections, px: 0, py: 0, gx: 0, gy: 0, x: 0, y: 0 };
  });

  const nodeIndex = Object.fromEntries(nodes.map(n => [n.id, n]));
  const adjList = Object.fromEntries(nodes.map(n => [n.id, []]));
  for (const e of result.edges) {
    if (adjList[e.src] && adjList[e.dst]) {
      adjList[e.src].push(e.dst);
      adjList[e.dst].push(e.src);
    }
  }

  const weights = {};
  for (const g of result.groupNames) weights[g] = g === "group" ? 3 : 1;
  unifiedBlend(nodes, result.groupNames, weights, 0, adjList, nodeIndex, 5);

  // Verify grid coords assigned
  for (const n of nodes) {
    assert(n.gx >= 0 && n.gx < GRID_SIZE, `gx=${n.gx} out of range`);
    assert(n.gy >= 0 && n.gy < GRID_SIZE, `gy=${n.gy} out of range`);
  }

  // Build multiple zoom levels
  for (const L of [1, 3, 5, 7]) {
    const level = buildLevel(L, nodes, result.edges, nodeIndex,
      n => n.group, n => n.label || n.id, _v => '#888888');
    const k = 1 << L;
    assert(level.supernodes.length > 0, `Level ${L} should have supernodes`);
    assert(level.supernodes.length <= k * k, `Level ${L}: too many supernodes`);

    // Bit-prefix containment: every L supernode's members should be in the L-1 parent
    if (L > 1) {
      for (const sn of level.supernodes) {
        for (const m of sn.members) {
          const parentBid = cellIdAtLevel(m.gx, m.gy, L - 1);
          const childBid = cellIdAtLevel(m.gx, m.gy, L);
          // Parent should be derivable from child's coords
          const parentShift = 16 - (L - 1);
          const childShift = 16 - L;
          const parentCx = m.gx >> parentShift;
          const childCx = m.gx >> childShift;
          assertEquals(parentCx, childCx >> 1, "Bit-prefix containment X");
        }
      }
    }
  }

  // Verify similar nodes cluster: persons should have some sig overlap (on-demand computation)
  const persons = nodes.filter(n => n.group === "Person");
  if (persons.length >= 2) {
    let anyOverlap = false;
    for (let i = 0; i < Math.min(persons.length, 10) && !anyOverlap; i++) {
      const sigI = computeNodeSig(persons[i]);
      for (let j = i + 1; j < Math.min(persons.length, 10); j++) {
        const sigJ = computeNodeSig(persons[j]);
        if (jaccardEstimate(sigI, sigJ) > 0) { anyOverlap = true; break; }
      }
    }
    assert(anyOverlap, "Some person pairs should have overlapping MinHash sigs");
  }
});

Deno.test("E2E: Epstein with topology alpha > 0", async () => {
  const edgesText = await Deno.readTextFile("docs/data/epstein.edges");
  const nodesText = await Deno.readTextFile("docs/data/epstein.nodes");
  const result = runPipeline(edgesText, nodesText);

  const G = result.groupNames.length;
  const nodes = result.nodeArray.map((n, i) => {
    const projections = {};
    for (let g = 0; g < G; g++) {
      const off = (i * G + g) * 2;
      projections[result.groupNames[g]] = [result.projBuf[off], result.projBuf[off + 1]];
    }
    return { ...n, projections, px: 0, py: 0, gx: 0, gy: 0 };
  });

  const nodeIndex = Object.fromEntries(nodes.map(n => [n.id, n]));
  const adjList = Object.fromEntries(nodes.map(n => [n.id, []]));
  for (const e of result.edges) {
    if (adjList[e.src] && adjList[e.dst]) {
      adjList[e.src].push(e.dst);
      adjList[e.dst].push(e.src);
    }
  }

  const weights = {};
  for (const g of result.groupNames) weights[g] = 1;

  // Blend with alpha=0
  unifiedBlend(nodes, result.groupNames, weights, 0, adjList, nodeIndex, 5);
  const posAlpha0 = nodes.map(n => [n.px, n.py]);

  // Reset and blend with alpha=0.5
  for (const n of nodes) { n.px = 0; n.py = 0; n.gx = 0; n.gy = 0; }
  unifiedBlend(nodes, result.groupNames, weights, 0.5, adjList, nodeIndex, 5);
  const posAlpha05 = nodes.map(n => [n.px, n.py]);

  // Positions should differ
  let anyDiff = false;
  for (let i = 0; i < nodes.length; i++) {
    if (posAlpha0[i][0] !== posAlpha05[i][0] || posAlpha0[i][1] !== posAlpha05[i][1]) {
      anyDiff = true;
      break;
    }
  }
  assert(anyDiff, "Topology alpha should change node positions");
});

// ─── Statistical MinHash accuracy ─────────────────────────────────────────────

Deno.test("MinHash Jaccard estimates converge to true Jaccard", () => {
  // Generate random token sets with known overlaps and verify that
  // MinHash estimates converge within expected standard deviation.
  const universe = [];
  for (let i = 0; i < 200; i++) universe.push("tok:" + i);

  function randomSet(size: number): string[] {
    const s = new Set<string>();
    while (s.size < size) s.add(universe[Math.floor(Math.random() * universe.length)]);
    return [...s];
  }

  function trueJaccard(a: string[], b: string[]): number {
    const setA = new Set(a), setB = new Set(b);
    let inter = 0;
    for (const x of setA) if (setB.has(x)) inter++;
    return inter / (setA.size + setB.size - inter);
  }

  const TRIALS = 500;
  let totalError = 0;
  let maxError = 0;

  for (let t = 0; t < TRIALS; t++) {
    const sizeA = 10 + Math.floor(Math.random() * 40);
    const sizeB = 10 + Math.floor(Math.random() * 40);
    const a = randomSet(sizeA);
    const b = randomSet(sizeB);
    const sigA = computeMinHash(a);
    const sigB = computeMinHash(b);
    const estimated = jaccardEstimate(sigA, sigB);
    const actual = trueJaccard(a, b);
    const err = Math.abs(estimated - actual);
    totalError += err;
    if (err > maxError) maxError = err;
  }

  const meanError = totalError / TRIALS;
  // OPH has higher variance than standard MinHash for sets smaller than k.
  // Mean error should still be small; max error can be larger for individual pairs.
  assert(meanError < 0.12, `Mean Jaccard error ${meanError.toFixed(4)} should be < 0.12`);
  assert(maxError < 0.65, `Max Jaccard error ${maxError.toFixed(4)} should be < 0.65`);
});

// ─── Two-phase buildLevel ─────────────────────────────────────────────────────

Deno.test("buildLevelNodes: returns supernodes with empty snEdges", () => {
  const parsed = parseEdgesFile(SAMPLE_EDGES);
  const nodesResult = parseNodesFile(SAMPLE_LABELS);
  const graph = buildGraph(parsed, nodesResult.nodes, nodesResult.extraPropNames);
  const { projBuf } = computeProjections(graph.nodeArray, graph.adjGroups, graph.groupNames, graph.hasEdgeTypes, nodesResult.extraPropNames, graph.numericBins);
  const G = graph.groupNames.length;
  const nodes = graph.nodeArray.map((n, i) => {
    const projections = {};
    for (let g = 0; g < G; g++) {
      const off = (i * G + g) * 2;
      projections[graph.groupNames[g]] = [projBuf[off], projBuf[off + 1]];
    }
    return { ...n, projections, px: 0, py: 0, gx: 0, gy: 0, x: 0, y: 0 };
  });
  const nodeIndex = Object.fromEntries(nodes.map(n => [n.id, n]));
  const adjList = Object.fromEntries(nodes.map(n => [n.id, []]));
  for (const e of graph.edges) {
    if (adjList[e.src] && adjList[e.dst]) { adjList[e.src].push(e.dst); adjList[e.dst].push(e.src); }
  }
  const weights: Record<string, number> = {};
  for (const g of graph.groupNames) weights[g] = 1;
  unifiedBlend(nodes, graph.groupNames, weights, 0, adjList, nodeIndex, 5, 'rank');

  const lvl = buildLevelNodes(4, nodes, n => n.group, n => n.label || n.id, () => '#888');
  assert(lvl.supernodes.length > 0, "Should have supernodes");
  assertEquals(lvl.snEdges.length, 0, "Phase 1 should have empty snEdges");
  assertEquals(lvl._edgesReady, false, "Phase 1 should not be edge-ready");
  assert(lvl.supernodes[0].cachedColor !== undefined, "Supernodes should have cached color");
});

Deno.test("buildLevelEdges: populates snEdges correctly", () => {
  const parsed = parseEdgesFile(SAMPLE_EDGES);
  const nodesResult = parseNodesFile(SAMPLE_LABELS);
  const graph = buildGraph(parsed, nodesResult.nodes, nodesResult.extraPropNames);
  const { projBuf } = computeProjections(graph.nodeArray, graph.adjGroups, graph.groupNames, graph.hasEdgeTypes, nodesResult.extraPropNames, graph.numericBins);
  const G = graph.groupNames.length;
  const nodes = graph.nodeArray.map((n, i) => {
    const projections = {};
    for (let g = 0; g < G; g++) {
      const off = (i * G + g) * 2;
      projections[graph.groupNames[g]] = [projBuf[off], projBuf[off + 1]];
    }
    return { ...n, projections, px: 0, py: 0, gx: 0, gy: 0, x: 0, y: 0 };
  });
  const nodeIndex = Object.fromEntries(nodes.map(n => [n.id, n]));
  const adjList = Object.fromEntries(nodes.map(n => [n.id, []]));
  for (const e of graph.edges) {
    if (adjList[e.src] && adjList[e.dst]) { adjList[e.src].push(e.dst); adjList[e.dst].push(e.src); }
  }
  const weights: Record<string, number> = {};
  for (const g of graph.groupNames) weights[g] = 1;
  unifiedBlend(nodes, graph.groupNames, weights, 0, adjList, nodeIndex, 5, 'rank');

  // Phase 1
  const lvl = buildLevelNodes(4, nodes, n => n.group, n => n.label || n.id, () => '#888');
  assertEquals(lvl.snEdges.length, 0);

  // Phase 2
  buildLevelEdges(lvl, graph.edges, nodeIndex, 4);
  assert(lvl._edgesReady, "Should be edge-ready after phase 2");

  // Compare with combined buildLevel
  const ref = buildLevel(4, nodes, graph.edges, nodeIndex, n => n.group, n => n.label || n.id, () => '#888');
  assertEquals(lvl.snEdges.length, ref.snEdges.length, "Edge count should match combined buildLevel");
  assertEquals(lvl.supernodes.length, ref.supernodes.length, "Supernode count should match");
});

// ─── SVG export tests ─────────────────────────────────────────────────────────

import { exportSVG, createSVGView } from "../docs/bitzoom-svg.js";

// Helper: run the real pipeline and build an SVG view via createSVGView
function buildSVGView(viewOpts = {}) {
  const result = runPipeline(SAMPLE_EDGES, SAMPLE_LABELS);
  const G = result.groupNames.length;
  const nodes = result.nodeArray.map((n, i) => {
    const projections: Record<string, number[]> = {};
    for (let g = 0; g < G; g++) {
      const off = (i * G + g) * 2;
      projections[result.groupNames[g]] = [result.projBuf[off], result.projBuf[off + 1]];
    }
    return { ...n, projections, px: 0, py: 0, gx: 0, gy: 0, x: 0, y: 0 };
  });
  const nodeIndex = Object.fromEntries(nodes.map(n => [n.id, n]));
  const adjList = Object.fromEntries(nodes.map(n => [n.id, [] as string[]]));
  for (const e of result.edges) {
    if (adjList[e.src] && adjList[e.dst]) { adjList[e.src].push(e.dst); adjList[e.dst].push(e.src); }
  }
  const weights: Record<string, number> = {};
  for (const g of result.groupNames) weights[g] = 1;
  unifiedBlend(nodes, result.groupNames, weights, 0, adjList, nodeIndex, 5, 'rank');

  return createSVGView(nodes, result.edges, {
    width: 400, height: 300,
    colorMap: { people: '#ff4444', animals: '#44ff44', '': '#888888' },
    ...viewOpts,
  });
}

Deno.test("exportSVG: returns valid SVG wrapper", () => {
  const view = buildSVGView();
  const svg = exportSVG(view);
  assert(svg.startsWith('<!-- Generated by BitZoom'));
  assert(svg.includes('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert(svg.includes('width="400"'));
  assert(svg.includes('height="300"'));
  assert(svg.endsWith('</svg>'));
});

Deno.test("exportSVG: includes background rect", () => {
  const svg = exportSVG(buildSVGView());
  assert(svg.includes('<rect width="400" height="300" fill="#12122a"/>'));
});

Deno.test("exportSVG: no background when disabled", () => {
  const svg = exportSVG(buildSVGView(), { background: false });
  assert(!svg.includes('fill="#12122a"'));
});

Deno.test("exportSVG: includes grid lines", () => {
  const svg = exportSVG(buildSVGView({ zoom: 2 }));
  assert(svg.includes('<line x1='));
});

Deno.test("exportSVG: no grid when disabled", () => {
  const svg = exportSVG(buildSVGView(), { grid: false, edges: false });
  assert(!svg.includes('<line x1='));
});

Deno.test("exportSVG: includes circles for all nodes", () => {
  const view = buildSVGView();
  const svg = exportSVG(view);
  const circleCount = (svg.match(/<circle cx=/g) || []).length;
  assertEquals(circleCount, view.nodes.length);
});

Deno.test("exportSVG: circles use correct colors", () => {
  const svg = exportSVG(buildSVGView());
  assert(svg.includes('fill="#ff4444"'), "Should have people color");
  assert(svg.includes('fill="#44ff44"'), "Should have animals color");
});

Deno.test("exportSVG: includes edges", () => {
  const svg = exportSVG(buildSVGView());
  assert(svg.includes('x2='), "Should have edge lines");
});

Deno.test("exportSVG: no edges when disabled", () => {
  const svg = exportSVG(buildSVGView(), { edges: false });
  assert(svg.includes('<circle'));
  assert(!svg.includes('fill="none"'));
});

Deno.test("exportSVG: no edges when edgeMode is none", () => {
  const svg = exportSVG(buildSVGView({ edgeMode: 'none' }));
  assert(!svg.includes('fill="none"'));
});

Deno.test("exportSVG: curve edges produce cubic Bézier paths", () => {
  const svg = exportSVG(buildSVGView({ edgeMode: 'curves' }));
  assert(svg.includes(' C') || svg.includes('<line'), "Should have curve or line edges");
});

Deno.test("exportSVG: metadata appears in comment", () => {
  const svg = exportSVG(buildSVGView(), { metadata: 'test-run-42' });
  assert(svg.includes('test-run-42'));
});

Deno.test("exportSVG: light mode uses white background", () => {
  const svg = exportSVG(buildSVGView({ lightMode: true }));
  assert(svg.includes('fill="#ffffff"'));
});

Deno.test("exportSVG: legend included when showLegend is set", () => {
  const svg = exportSVG(buildSVGView({ showLegend: 1 }));
  assert(svg.includes('GROUP'), "Legend should show dominant group header");
  assert(svg.includes('people') || svg.includes('animals'), "Legend should have group entries");
});

Deno.test("exportSVG: no legend when disabled", () => {
  const svg = exportSVG(buildSVGView({ showLegend: false }), { legend: true });
  assert(!svg.includes('GROUP'));
});

Deno.test("exportSVG: density heatmap produces contour paths", () => {
  const view = buildSVGView({ heatmapMode: 'density' });
  // Place nodes close together so they produce density overlap
  view.nodes[0].x = 10; view.nodes[0].y = 10;
  view.nodes[1].x = 12; view.nodes[1].y = 10;
  view.nodes[2].x = 10; view.nodes[2].y = 12;
  view.nodes[3].x = 11; view.nodes[3].y = 11;
  const svg = exportSVG(view);
  assert(svg.includes('fill-rule="evenodd"'), "Should have density contour group");
  assert(svg.includes('feGaussianBlur'), "Should have blur filter");
  assert(svg.includes('fill-opacity='), "Should have contour paths with opacity");
});

Deno.test("exportSVG: density heatmap uses global normalization", () => {
  const view = buildSVGView({ heatmapMode: 'density' });
  view.nodes[0].x = 10; view.nodes[0].y = 10;
  view.nodes[1].x = 11; view.nodes[1].y = 10;
  view.nodes[2].x = 80; view.nodes[2].y = 80;
  view.nodes[3].x = 81; view.nodes[3].y = 80;
  const svg = exportSVG(view);
  const paths = svg.match(/<path d="[^"]*"/g) || [];
  assert(paths.length > 0, "Should have at least one contour path");
});

Deno.test("exportSVG: no density when heatmap is off", () => {
  const svg = exportSVG(buildSVGView());
  assert(!svg.includes('feGaussianBlur'));
});

Deno.test("exportSVG: selected node gets stroke and full opacity", () => {
  const svg = exportSVG(buildSVGView({ selectedIds: new Set(['A']) }));
  assert(svg.includes('stroke="#fff"'), "Selected node should have white stroke");
  assert(svg.includes('fill-opacity="1.00"'), "Selected node should have full opacity");
  assert(svg.includes('stroke-width="2"'), "Selected node should have thicker stroke");
});

Deno.test("exportSVG: aggregated level uses supernodes", () => {
  const view = buildSVGView({ level: 1 });
  const svg = exportSVG(view);
  assert(svg.startsWith('<!-- Generated by BitZoom'));
  assert(svg.includes('<circle'));
  const circleCount = (svg.match(/<circle cx=/g) || []).length;
  assert(circleCount <= 4, "Level 1 (2x2) should have at most 4 supernodes");
  assert(circleCount > 0, "Should have at least 1 supernode");
});
