#!/usr/bin/env -S deno run --allow-read --allow-write
// Export BitZoom layout coordinates for comparison benchmarks.
// Usage: deno run --allow-read --allow-write benchmarks/export-layout.ts \
//          --edges docs/data/email-eu.edges [--nodes docs/data/email-eu.nodes] \
//          --alpha 0.75 --quant rank --out benchmarks/layouts/email-eu-a075.tsv
//
// Runs the full pipeline: parse → project → blend → quantize → export.

import { runPipeline, tokenizeLabel, tokenizeNumeric, degreeBucket } from '../docs/bitzoom-pipeline.js';
import { buildGaussianProjection, unifiedBlend, MINHASH_K } from '../docs/bitzoom-algo.js';
import { autoTuneStrengths, autoTuneBearings } from '../docs/bitzoom-utils.js';

function parseArgs() {
  const args = Deno.args;
  const opts = { edges: '', nodes: '', alpha: 0, quant: 'gaussian', out: '', strengths: {}, autotune: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--edges') opts.edges = args[++i];
    else if (args[i] === '--nodes') opts.nodes = args[++i];
    else if (args[i] === '--alpha') opts.alpha = parseFloat(args[++i]);
    else if (args[i] === '--quant') opts.quant = args[++i];
    else if (args[i] === '--out') opts.out = args[++i];
    else if (args[i] === '--autotune') opts.autotune = true;
    else if (args[i] === '--strength') {
      const [k, v] = args[++i].split('=');
      opts.strengths[k] = parseFloat(v);
    }
  }
  if (!opts.edges || !opts.out) {
    console.error('Usage: --edges <file> [--nodes <file>] [--alpha 0.75] [--quant rank|gaussian] [--strength group=5] [--autotune] --out <file>');
    Deno.exit(1);
  }
  return opts;
}

const opts = parseArgs();

const edgesText = await Deno.readTextFile(opts.edges);
const nodesText = opts.nodes ? await Deno.readTextFile(opts.nodes) : null;

const result = runPipeline(edgesText, nodesText);
const { nodeArray, groupNames, projBuf } = result;

// Build node objects with projections (same as bitzoom-canvas.js _hydrateAndLink)
const G = groupNames.length;
const groupProjections = {};
for (let i = 0; i < groupNames.length; i++) {
  groupProjections[groupNames[i]] = buildGaussianProjection(2001 + i, MINHASH_K);
}

const nodes = nodeArray.map((meta, i) => {
  const projections = {};
  for (let g = 0; g < G; g++) {
    const off = (i * G + g) * 2;
    projections[groupNames[g]] = [projBuf[off], projBuf[off + 1]];
  }
  return { ...meta, projections, px: 0, py: 0, gx: 0, gy: 0 };
});

// Build adjacency list
const adjList = Object.fromEntries(nodes.map(n => [n.id, []]));
const edges = result.edges || [];
for (const e of edges) {
  if (adjList[e.src] && adjList[e.dst]) {
    adjList[e.src].push(e.dst);
    adjList[e.dst].push(e.src);
  }
}

const nodeIndexFull = Object.fromEntries(nodes.map(n => [n.id, n]));

// Set strengths
const propStrengths = {};
for (const g of groupNames) propStrengths[g] = opts.strengths[g] ?? 0;

// Auto-tune if requested
let propBearings = null;
if (opts.autotune) {
  const t0 = performance.now();
  const tuneResult = await autoTuneStrengths(nodes, groupNames, adjList, nodeIndexFull, {
    strengths: true, alpha: true, quant: true,
  });
  for (const g of groupNames) propStrengths[g] = tuneResult.strengths[g] ?? 0;
  opts.alpha = tuneResult.alpha;
  opts.quant = tuneResult.quantMode;
  propBearings = autoTuneBearings(nodes, groupNames, propStrengths);
  console.log(`  Auto-tune: ${Math.round(performance.now() - t0)}ms, score=${tuneResult.score.toFixed(3)}`);
}

// Blend + quantize
unifiedBlend(nodes, groupNames, propStrengths, opts.alpha, adjList, nodeIndexFull, 5, opts.quant, {}, propBearings);

// Export
const lines = ['# id\tpx\tpy\tgx\tgy'];
for (const n of nodes) {
  lines.push(`${n.id}\t${n.px}\t${n.py}\t${n.gx}\t${n.gy}`);
}

await Deno.writeTextFile(opts.out, lines.join('\n') + '\n');

// Export per-node token sets for property-similarity evaluation.
// Only written once per dataset (alpha/strengths don't affect tokens).
const tokensPath = opts.out.replace(/(-a\d+.*)?\.tsv$/, '.tokens');
try {
  await Deno.stat(tokensPath);
  // Already exists — skip
} catch {
  const { adjGroups, hasEdgeTypes, extraPropNames, numericBins } = result;
  const tokenBuf = new Array(200);
  const tokenLines = ['# id\ttokens (space-separated)'];
  for (let idx = 0; idx < nodes.length; idx++) {
    const n = nodeArray[idx];
    const allTokens = [];
    // group
    allTokens.push('group:' + n.group);
    // label
    const labelEnd = tokenizeLabel(n.label, n.id, tokenBuf, 0);
    for (let t = 0; t < labelEnd; t++) allTokens.push(tokenBuf[t]);
    // structure
    allTokens.push('deg:' + degreeBucket(n.degree));
    allTokens.push('leaf:' + (n.degree === 0));
    // neighbors
    const adj = adjGroups[idx];
    if (adj.length > 0) {
      for (let ai = 0; ai < adj.length; ai++) allTokens.push('ngroup:' + adj[ai]);
    } else {
      allTokens.push('ngroup:isolated');
    }
    // edge types
    if (hasEdgeTypes) {
      if (n.edgeTypes && n.edgeTypes.length > 0) {
        for (const t of n.edgeTypes) allTokens.push('etype:' + t);
      } else {
        allTokens.push('etype:none');
      }
    }
    // extra props
    for (const ep of (extraPropNames || [])) {
      const val = n.extraProps && n.extraProps[ep];
      const epEnd = tokenizeNumeric(ep, val, (numericBins || {})[ep], tokenBuf, 0);
      for (let t = 0; t < epEnd; t++) allTokens.push(tokenBuf[t]);
    }
    tokenLines.push(n.id + '\t' + allTokens.join(' '));
  }
  await Deno.writeTextFile(tokensPath, tokenLines.join('\n') + '\n');
  console.log(`  Tokens: ${tokensPath}`);
}

console.log(`Exported ${nodes.length} nodes to ${opts.out}`);
console.log(`  Groups: ${groupNames.join(', ') || '(none)'}`);
console.log(`  Alpha: ${opts.alpha}, Quant: ${opts.quant}`);
console.log(`  Strengths: ${JSON.stringify(propStrengths)}`);
