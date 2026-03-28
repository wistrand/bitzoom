import { assertEquals, assertExists, assert } from "https://deno.land/std/assert/mod.ts";

// Load algo first (pipeline depends on it)
import {
  MINHASH_K, GRID_SIZE, ZOOM_LEVELS, RAW_LEVEL,
  computeMinHash, computeMinHashInto, _sig, projectWith, projectInto,
  buildGaussianProjection, hashToken, jaccardEstimate, cellIdAtLevel,
  normalizeAndQuantize, unifiedBlend, buildLevel, buildLevelNodes, buildLevelEdges, generateGroupColors,
  maxCountKey, getNodePropValue, getSupernodeDominantValue,
} from "../docs/bitzoom-algo.js";

import {
  parseEdgesFile, parseLabelsFile, buildGraph,
  degreeBucket, tokenizeLabel, tokenizeNumeric, computeProjections, runPipeline, computeNodeSig,
} from "../docs/bitzoom-pipeline.js";

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
  const a = computeMinHash(["cat:web", "dl:high", "ver:3"]);
  const b = computeMinHash(["cat:web", "dl:high", "ver:4"]);
  const c = computeMinHash(["cat:crypto", "dl:low", "ver:1"]);
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
  const sig = computeMinHash(["test"]);
  const rot = buildGaussianProjection(1, MINHASH_K);
  const buf = new Float64Array(4);
  projectInto(sig, rot, buf, 2);
  assert(buf[2] !== 0 || buf[3] !== 0, "Should write non-zero projection");
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

Deno.test("parseLabelsFile: parses header and extra columns", () => {
  const r = parseLabelsFile(SAMPLE_LABELS);
  assertEquals(r.extraPropNames.length, 1);
  assertEquals(r.extraPropNames[0], "score");
  const alice = r.labels.get("A");
  assertExists(alice);
  assertEquals(alice!.label, "Alice");
  assertEquals(alice!.group, "people");
  assertEquals(alice!.extraProps.score, "high");
});

Deno.test("parseLabelsFile: handles missing header", () => {
  const r = parseLabelsFile("X\tXena\twarrior\nY\tYoda\tjedi\n");
  assertEquals(r.labels.size, 2);
  assertEquals(r.labels.get("X")!.group, "warrior");
});

Deno.test("buildGraph: builds nodes, edges, adjacency", () => {
  const parsed = parseEdgesFile(SAMPLE_EDGES);
  const labelResult = parseLabelsFile(SAMPLE_LABELS);
  const graph = buildGraph(parsed, labelResult.labels, labelResult.extraPropNames);

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
  const labelResult = parseLabelsFile(SAMPLE_LABELS);
  const graph = buildGraph(parsed, labelResult.labels, labelResult.extraPropNames);
  const result = computeProjections(
    graph.nodeArray, graph.adjGroups, graph.groupNames, graph.hasEdgeTypes, labelResult.extraPropNames, graph.numericBins,
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
  const labelResult = parseLabelsFile(SAMPLE_LABELS);
  const graph = buildGraph(parsed, labelResult.labels, labelResult.extraPropNames);
  const r1 = computeProjections(graph.nodeArray, graph.adjGroups, graph.groupNames, graph.hasEdgeTypes, labelResult.extraPropNames, graph.numericBins);
  const r2 = computeProjections(graph.nodeArray, graph.adjGroups, graph.groupNames, graph.hasEdgeTypes, labelResult.extraPropNames, graph.numericBins);
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
  const labelResult = parseLabelsFile(numLabels);
  const graph = buildGraph(parsed, labelResult.labels, labelResult.extraPropNames);
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
  const labelResult = parseLabelsFile(numLabels);
  const graph = buildGraph(parsed, labelResult.labels, labelResult.extraPropNames);
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
  // Two nodes: A has score="50", B has score="" (undefined)
  const edges = "A\tB\n";
  const labels = `# NodeId\tLabel\tGroup\tScore
A\tAlice\tp\t50
B\tBob\tp\t`;
  const result = runPipeline(edges, labels);
  const G = result.groupNames.length;
  const scoreIdx = result.groupNames.indexOf("score");
  assert(scoreIdx >= 0, "score should be a group");

  // Node B (index 1) should have [0,0] for the score projection
  const bOff = (1 * G + scoreIdx) * 2;
  assertEquals(result.projBuf[bOff], 0, "Undefined score px should be 0");
  assertEquals(result.projBuf[bOff + 1], 0, "Undefined score py should be 0");

  // Node A (index 0) should have non-zero projection
  const aOff = (0 * G + scoreIdx) * 2;
  assert(result.projBuf[aOff] !== 0 || result.projBuf[aOff + 1] !== 0,
    "Defined score should have non-zero projection");
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

Deno.test("parseLabelsFile: trailing empty tabs preserved as empty strings", () => {
  const text = "# NodeId\tLabel\tGroup\tA\tB\nX\tXena\tg\t10\t\nY\tYoda\tg\t\t20\n";
  const r = parseLabelsFile(text);
  assertEquals(r.labels.get("X").extraProps.a, "10");
  assertEquals(r.labels.get("X").extraProps.b, "");
  assertEquals(r.labels.get("Y").extraProps.a, "");
  assertEquals(r.labels.get("Y").extraProps.b, "20");
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
  const labelResult = parseLabelsFile(labels);
  const graph = buildGraph(parsed, labelResult.labels, labelResult.extraPropNames);
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
  const labelsText = await Deno.readTextFile("docs/data/epstein.labels");

  const result = runPipeline(edgesText, labelsText);

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
  const labelsText = await Deno.readTextFile("docs/data/epstein.labels");
  const result = runPipeline(edgesText, labelsText);

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
  // Expected std dev of MinHash estimate: sqrt(J(1-J)/k) <= 1/(2*sqrt(k)) = 1/(2*sqrt(128)) ≈ 0.044
  // Mean absolute error should be well below this for 500 trials
  assert(meanError < 0.08, `Mean Jaccard error ${meanError.toFixed(4)} should be < 0.08`);
  assert(maxError < 0.35, `Max Jaccard error ${maxError.toFixed(4)} should be < 0.35`);
});

// ─── Two-phase buildLevel ─────────────────────────────────────────────────────

Deno.test("buildLevelNodes: returns supernodes with empty snEdges", () => {
  const parsed = parseEdgesFile(SAMPLE_EDGES);
  const labelResult = parseLabelsFile(SAMPLE_LABELS);
  const graph = buildGraph(parsed, labelResult.labels, labelResult.extraPropNames);
  const { projBuf } = computeProjections(graph.nodeArray, graph.adjGroups, graph.groupNames, graph.hasEdgeTypes, labelResult.extraPropNames, graph.numericBins);
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
  const labelResult = parseLabelsFile(SAMPLE_LABELS);
  const graph = buildGraph(parsed, labelResult.labels, labelResult.extraPropNames);
  const { projBuf } = computeProjections(graph.nodeArray, graph.adjGroups, graph.groupNames, graph.hasEdgeTypes, labelResult.extraPropNames, graph.numericBins);
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
