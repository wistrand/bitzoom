// bitzoom-pipeline.js — Shared parsing, graph building, and tokenization/projection.
// No DOM, no Worker API. Usable from Web Workers, Deno, or browser.

import { MINHASH_K, buildGaussianRotation, computeMinHash, computeMinHashInto, _sig, projectInto } from './bitzoom-algo.js';

// ─── SNAP file parsers ───────────────────────────────────────────────────────

export function parseEdgesFile(text) {
  const edgeFrom = [];
  const edgeTo = [];
  const nodeIds = new Set();
  const edgeTypeMap = new Map();
  let hasThirdCol = false;

  let pos = 0;
  const len = text.length;
  while (pos < len) {
    let eol = text.indexOf('\n', pos);
    if (eol === -1) eol = len;
    let start = pos;
    while (start < eol && (text.charCodeAt(start) === 32 || text.charCodeAt(start) === 9 || text.charCodeAt(start) === 13)) start++;
    pos = eol + 1;
    if (start >= eol || text.charCodeAt(start) === 35) continue;

    const tab1 = text.indexOf('\t', start);
    if (tab1 < 0 || tab1 >= eol) continue;
    const from = text.slice(start, tab1);

    let tab2 = text.indexOf('\t', tab1 + 1);
    let lineEnd = eol;
    if (lineEnd > 0 && text.charCodeAt(lineEnd - 1) === 13) lineEnd--;
    const to = tab2 >= 0 && tab2 < eol ? text.slice(tab1 + 1, tab2) : text.slice(tab1 + 1, lineEnd);

    nodeIds.add(from);
    nodeIds.add(to);
    edgeFrom.push(from);
    edgeTo.push(to);

    if (tab2 >= 0 && tab2 < eol) {
      const etype = text.slice(tab2 + 1, lineEnd);
      if (etype) {
        hasThirdCol = true;
        if (!edgeTypeMap.has(from)) edgeTypeMap.set(from, new Set());
        if (!edgeTypeMap.has(to)) edgeTypeMap.set(to, new Set());
        edgeTypeMap.get(from).add(etype);
        edgeTypeMap.get(to).add(etype);
      }
    }
  }
  return { edgeFrom, edgeTo, edgeCount: edgeFrom.length, edgeTypeMap: hasThirdCol ? edgeTypeMap : null, nodeIds };
}

export function parseLabelsFile(text) {
  const labels = new Map();
  const extraPropNames = [];
  const lines = text.split('\n');

  let dataStart = 0;
  if (lines.length > 0 && lines[0].trim().startsWith('#')) {
    const headerParts = lines[0].trim().replace(/^#\s*/, '').split('\t');
    for (let i = 3; i < headerParts.length; i++) {
      extraPropNames.push(headerParts[i].trim().toLowerCase().replace(/\s+/g, '_'));
    }
    dataStart = 1;
  }

  for (let i = dataStart; i < lines.length; i++) {
    const line = lines[i].replace(/[\r\n]+$/, '');
    if (!line || line[0] === '#') continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;

    const entry = {
      label: parts[1] || parts[0],
      group: parts.length >= 3 ? parts[2] : 'unknown',
      extraProps: {},
    };

    for (let j = 3; j < parts.length; j++) {
      const name = (j - 3) < extraPropNames.length ? extraPropNames[j - 3] : `prop${j+1}`;
      entry.extraProps[name] = parts[j];
    }

    labels.set(parts[0], entry);
  }

  if (extraPropNames.length === 0) {
    for (const entry of labels.values()) {
      for (const k of Object.keys(entry.extraProps)) {
        if (!extraPropNames.includes(k)) extraPropNames.push(k);
      }
      break;
    }
  }

  return { labels, extraPropNames };
}

// ─── Graph building ──────────────────────────────────────────────────────────

export function buildGraph(parsed, labelMap, extraPropNames) {
  const nodeArray = [];
  const nodeIndex = {};
  for (const id of parsed.nodeIds) {
    const info = labelMap ? labelMap.get(id) : null;
    const group = info ? info.group : 'unknown';
    const label = info ? info.label : id;
    const edgeTypes = parsed.edgeTypeMap
      ? (parsed.edgeTypeMap.has(id) ? [...parsed.edgeTypeMap.get(id)] : [])
      : null;
    const extraProps = info ? (info.extraProps || {}) : {};
    const node = { id, group, label, degree: 0, edgeTypes, extraProps };
    nodeIndex[id] = node;
    nodeArray.push(node);
  }

  const edges = [];
  const adjList = {};
  for (let i = 0; i < nodeArray.length; i++) adjList[nodeArray[i].id] = [];

  for (let i = 0; i < parsed.edgeCount; i++) {
    const from = parsed.edgeFrom[i], to = parsed.edgeTo[i];
    if (nodeIndex[from] && nodeIndex[to]) {
      edges.push({ src: from, dst: to });
      nodeIndex[from].degree++;
      nodeIndex[to].degree++;
      adjList[from].push(to);
      adjList[to].push(from);
    }
  }

  // Determine property group names
  const groupNames = ['group', 'label', 'structure', 'neighbors'];
  for (const ep of extraPropNames) groupNames.push(ep);
  const hasEdgeTypes = !!parsed.edgeTypeMap;
  if (hasEdgeTypes) groupNames.push('edgetype');

  // Pre-compute neighbor groups
  const adjGroups = new Array(nodeArray.length);
  for (let i = 0; i < nodeArray.length; i++) {
    const nbrIds = adjList[nodeArray[i].id];
    const groups = new Array(nbrIds.length);
    for (let j = 0; j < nbrIds.length; j++) groups[j] = nodeIndex[nbrIds[j]].group;
    adjGroups[i] = groups;
  }

  // Collect unique groups
  const groupSet = new Set();
  for (let i = 0; i < nodeArray.length; i++) groupSet.add(nodeArray[i].group);
  const uniqueGroups = [...groupSet].sort();

  // Detect numeric extra property columns and compute bin boundaries
  // A column is numeric if >80% of non-empty values parse as finite numbers
  const numericBins = {}; // propName → { min, max, coarse: count, medium: count, fine: count }
  for (const ep of extraPropNames) {
    let numCount = 0, total = 0;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < nodeArray.length; i++) {
      const v = nodeArray[i].extraProps[ep];
      if (!v || v === 'unknown') continue;
      total++;
      const num = Number(v);
      if (isFinite(num)) {
        numCount++;
        if (num < min) min = num;
        if (num > max) max = num;
      }
    }
    if (total > 0 && numCount / total >= 0.8 && max > min) {
      numericBins[ep] = { min, max, coarse: 5, medium: 50, fine: 500 };
    }
  }

  return { nodeArray, nodeIndex, edges, adjList, adjGroups, groupNames, uniqueGroups, hasEdgeTypes, numericBins };
}

// ─── Tokenization helpers ────────────────────────────────────────────────────

export function degreeBucket(d) {
  if (d === 0) return '0';
  if (d === 1) return '1';
  if (d <= 3) return '2-3';
  if (d <= 7) return '4-7';
  if (d <= 15) return '8-15';
  if (d <= 31) return '16-31';
  return '32+';
}

// Tokenize a label string into words, inline (no intermediate arrays)
// Writes into tokenBuf starting at offset, returns new offset
export function tokenizeLabel(label, id, tokenBuf, offset) {
  const lbl = label.toLowerCase();
  let wordStart = -1;
  let count = 0;
  for (let ci = 0; ci <= lbl.length; ci++) {
    const ch = ci < lbl.length ? lbl.charCodeAt(ci) : 0;
    const isAlnum = (ch >= 48 && ch <= 57) || (ch >= 97 && ch <= 122);
    if (isAlnum) {
      if (wordStart < 0) wordStart = ci;
    } else {
      if (wordStart >= 0 && ci - wordStart > 1) {
        tokenBuf[offset + count] = 'label:' + lbl.slice(wordStart, ci);
        count++;
      }
      wordStart = -1;
    }
  }
  if (count === 0) { tokenBuf[offset] = 'label:' + id; count = 1; }
  return offset + count;
}

// Emit multi-resolution tokens for a numeric value.
// Writes 3 tokens into tokenBuf at offset, returns new offset.
// Empty/undefined values emit 0 tokens (returns offset unchanged).
// Non-numeric strings emit 1 categorical token.
export function tokenizeNumeric(propName, value, bins, tokenBuf, offset) {
  // Undefined: empty string or missing — emit nothing
  if (!value || value === '') return offset;

  const num = Number(value);
  if (!isFinite(num) || !bins) {
    tokenBuf[offset] = propName + ':' + value;
    return offset + 1;
  }
  const range = bins.max - bins.min;
  const levels = [
    { prefix: 'c', count: bins.coarse },
    { prefix: 'm', count: bins.medium },
    { prefix: 'f', count: bins.fine },
  ];
  for (const lv of levels) {
    const bucketSize = range / lv.count;
    const bucket = Math.min(lv.count - 1, Math.floor((num - bins.min) / bucketSize));
    const lo = bins.min + bucket * bucketSize;
    const hi = lo + bucketSize;
    tokenBuf[offset++] = propName + ':' + lv.prefix + ':' + lo.toPrecision(3) + '-' + hi.toPrecision(3);
  }
  return offset;
}

// ─── Full projection pipeline (single-threaded) ─────────────────────────────
// Computes all MinHash projections for all nodes. GC-optimized: uses
// computeMinHashInto/_sig/projectInto to avoid per-node allocations.

export function computeProjections(nodeArray, adjGroups, groupNames, hasEdgeTypes, extraPropNames, numericBins) {
  numericBins = numericBins || {};
  const groupRotations = {};
  for (let i = 0; i < groupNames.length; i++) {
    groupRotations[groupNames[i]] = buildGaussianRotation(2001 + i, 2, MINHASH_K);
  }

  const N = nodeArray.length;
  const G = groupNames.length;
  const projBuf = new Float64Array(N * G * 2);
  const sigBuf = new Float64Array(N * MINHASH_K);

  const gIdx = {};
  for (let i = 0; i < G; i++) gIdx[groupNames[i]] = i;

  const tokenBuf = new Array(200);

  for (let idx = 0; idx < N; idx++) {
    const n = nodeArray[idx];
    const baseOff = idx * G * 2;

    // group
    tokenBuf[0] = 'group:' + n.group;
    computeMinHashInto(tokenBuf, 1);
    projectInto(_sig, groupRotations.group, projBuf, baseOff + gIdx.group * 2);

    // label
    const labelEnd = tokenizeLabel(n.label, n.id, tokenBuf, 0);
    computeMinHashInto(tokenBuf, labelEnd);
    projectInto(_sig, groupRotations.label, projBuf, baseOff + gIdx.label * 2);

    // structure
    tokenBuf[0] = 'deg:' + degreeBucket(n.degree);
    tokenBuf[1] = 'leaf:' + (n.degree === 0);
    computeMinHashInto(tokenBuf, 2);
    projectInto(_sig, groupRotations.structure, projBuf, baseOff + gIdx.structure * 2);

    // neighbors
    const adj = adjGroups[idx];
    let tc = 0;
    if (adj.length > 0) {
      for (let ai = 0; ai < adj.length; ai++) tokenBuf[tc++] = 'ngroup:' + adj[ai];
    } else {
      tokenBuf[0] = 'ngroup:isolated'; tc = 1;
    }
    computeMinHashInto(tokenBuf, tc);
    projectInto(_sig, groupRotations.neighbors, projBuf, baseOff + gIdx.neighbors * 2);

    // edge types
    if (hasEdgeTypes) {
      tc = 0;
      if (n.edgeTypes && n.edgeTypes.length > 0) {
        for (let ei = 0; ei < n.edgeTypes.length; ei++) tokenBuf[tc++] = 'etype:' + n.edgeTypes[ei];
      } else {
        tokenBuf[0] = 'etype:none'; tc = 1;
      }
      computeMinHashInto(tokenBuf, tc);
      projectInto(_sig, groupRotations.edgetype, projBuf, baseOff + gIdx.edgetype * 2);
    }

    // extra props (with multi-resolution numeric tokenization)
    // Empty/undefined values emit 0 tokens → projection stays at [0,0] (neutral)
    for (let epi = 0; epi < extraPropNames.length; epi++) {
      const ep = extraPropNames[epi];
      const val = n.extraProps && n.extraProps[ep];
      const epEnd = tokenizeNumeric(ep, val, numericBins[ep], tokenBuf, 0);
      if (epEnd > 0) {
        computeMinHashInto(tokenBuf, epEnd);
        projectInto(_sig, groupRotations[ep], projBuf, baseOff + gIdx[ep] * 2);
      }
      // else: projBuf already initialized to 0,0
    }

    // combined signature (allocating — stored in sigBuf)
    tc = 0;
    tokenBuf[tc++] = 'group:' + n.group;
    tc = tokenizeLabel(n.label, n.id, tokenBuf, tc);
    tokenBuf[tc++] = 'deg:' + degreeBucket(n.degree);
    tokenBuf[tc++] = 'leaf:' + (n.degree === 0);
    const combinedSig = computeMinHash(tokenBuf, tc);
    sigBuf.set(combinedSig, idx * MINHASH_K);
  }

  return { projBuf, sigBuf, groupNames };
}

// ─── Full pipeline: parse → build → project ──────────────────────────────────

export function runPipeline(edgesText, labelsText) {
  const parsed = parseEdgesFile(edgesText);
  const labelResult = labelsText ? parseLabelsFile(labelsText) : null;
  const labelMap = labelResult ? labelResult.labels : null;
  const extraPropNames = labelResult ? labelResult.extraPropNames : [];

  const graph = buildGraph(parsed, labelMap, extraPropNames);
  const { projBuf, sigBuf } = computeProjections(
    graph.nodeArray, graph.adjGroups, graph.groupNames, graph.hasEdgeTypes, extraPropNames, graph.numericBins
  );

  return { ...graph, projBuf, sigBuf, extraPropNames };
}
