// bitzoom-worker.js — coordinator that fans out projection to sub-workers.
// Uses shared pipeline for parsing and graph building.

import { parseEdgesFile, parseLabelsFile, buildGraph } from './bitzoom-pipeline.js';

const MAX_WORKERS = 3;

function progress(message, pct) {
  self.postMessage({ type: 'progress', message, pct });
}

self.onmessage = function(e) {
  try {
    const { edgesText, labelsText } = e.data;

    // Parse
    progress('Parsing edges...', 0);
    const parsed = parseEdgesFile(edgesText);
    const nodeCount = parsed.nodeIds.size;
    const edgeCount = parsed.edgeCount;

    progress(`Parsed ${nodeCount.toLocaleString()} nodes, ${edgeCount.toLocaleString()} edges`, 10);
    const labelResult = labelsText ? parseLabelsFile(labelsText) : null;
    const labelMap = labelResult ? labelResult.labels : null;
    const extraPropNames = labelResult ? labelResult.extraPropNames : [];

    // Build graph
    progress('Building graph...', 15);
    const graph = buildGraph(parsed, labelMap, extraPropNames);
    const { nodeArray, edges, adjGroups, groupNames, uniqueGroups, hasEdgeTypes, numericBins } = graph;

    // Rotation matrix seeds (deterministic, sub-workers rebuild from these)
    const groupRotationSeeds = groupNames.map((_, i) => 2001 + i);

    // ── Fan out to sub-workers ──
    const N = nodeArray.length;
    const G = groupNames.length;
    const MINHASH_K = 128;
    const numWorkers = Math.min(MAX_WORKERS, Math.max(1, Math.ceil(N / 500)));
    const chunkSize = Math.ceil(N / numWorkers);

    progress(`Projecting ${N.toLocaleString()} nodes across ${numWorkers} workers...`, 25);

    // Final merged buffer
    const projBuf = new Float64Array(N * G * 2);

    // Prepare lightweight node data for sub-workers
    const nodeData = nodeArray.map(n => ({
      id: n.id,
      group: n.group,
      label: n.label,
      degree: n.degree,
      edgeTypes: n.edgeTypes,
      extraProps: n.extraProps,
    }));

    let completed = 0;
    let totalProjected = 0;
    const workers = [];

    const checkDone = () => {
      if (completed < numWorkers) return;

      progress('Packing result...', 95);

      const nodeMeta = nodeArray.map(n => ({
        id: n.id,
        group: n.group,
        label: n.label,
        degree: n.degree,
        edgeTypes: n.edgeTypes,
        extraProps: n.extraProps,
        propSet: null,
      }));

      const msg = {
        type: 'done',
        result: {
          nodeMeta,
          projBuf,
          edges,
          groupNames,
          uniqueGroups,
          hasEdgeTypes,
        }
      };
      self.postMessage(msg, [projBuf.buffer]);
    };

    for (let w = 0; w < numWorkers; w++) {
      const start = w * chunkSize;
      const end = Math.min(start + chunkSize, N);
      const slice = nodeData.slice(start, end);
      const sliceAdj = adjGroups.slice(start, end);

      const worker = new Worker('bitzoom-proj-worker.js', { type: 'module' });
      workers.push(worker);

      worker.onmessage = (msg) => {
        const d = msg.data;
        if (d.type === 'progress') {
          totalProjected += d.done > 0 ? Math.floor(d.total / 20) : 0;
          const pct = 25 + Math.floor((totalProjected / N) * 65);
          progress(`Projecting... ${Math.min(totalProjected, N).toLocaleString()} / ${N.toLocaleString()}`, Math.min(pct, 90));
          return;
        }
        if (d.type === 'error') {
          for (const wk of workers) wk.terminate();
          self.postMessage({ type: 'error', message: d.message });
          return;
        }
        if (d.type === 'done') {
          projBuf.set(d.projBuf, d.startIdx * G * 2);

          worker.terminate();
          completed++;
          progress(`Workers completed: ${completed}/${numWorkers}`, 25 + Math.floor((completed / numWorkers) * 65));
          checkDone();
        }
      };

      worker.onerror = (err) => {
        for (const wk of workers) wk.terminate();
        self.postMessage({ type: 'error', message: 'Sub-worker error: ' + (err.message || 'unknown') });
      };

      worker.postMessage({
        nodes: slice,
        groupNames,
        groupRotationSeeds,
        hasEdgeTypes,
        extraPropNames,
        numericBins,
        adjGroups: sliceAdj,
        startIdx: start,
      });
    }

  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};
