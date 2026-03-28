// bitzoom-proj-worker.js — computes MinHash projections for a slice of nodes.
// Imports all algo functions from shared modules — no duplication.

import { degreeBucket, tokenizeLabel, tokenizeNumeric } from './bitzoom-pipeline.js';
import {
  MINHASH_K, buildGaussianProjection,
  computeMinHashInto, _sig, projectInto,
} from './bitzoom-algo.js';

self.onmessage = function(e) {
  try {
    const { nodes, groupNames, groupRotationSeeds, hasEdgeTypes, extraPropNames, numericBins, adjGroups, startIdx } = e.data;

    const gIdx = {};
    for (let i = 0; i < groupNames.length; i++) gIdx[groupNames[i]] = i;

    const groupRotations = {};
    for (let i = 0; i < groupNames.length; i++) {
      groupRotations[groupNames[i]] = buildGaussianProjection(groupRotationSeeds[i], MINHASH_K);
    }

    const N = nodes.length;
    const G = groupNames.length;
    const projBuf = new Float64Array(N * G * 2);

    const tokenBuf = new Array(200);
    const progressInterval = Math.max(1, (N / 20) | 0);

    for (let idx = 0; idx < N; idx++) {
      const n = nodes[idx];
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
      for (let epi = 0; epi < extraPropNames.length; epi++) {
        const ep = extraPropNames[epi];
        const val = n.extraProps && n.extraProps[ep];
        const epEnd = tokenizeNumeric(ep, val, numericBins ? numericBins[ep] : undefined, tokenBuf, 0);
        if (epEnd > 0) {
          computeMinHashInto(tokenBuf, epEnd);
          projectInto(_sig, groupRotations[ep], projBuf, baseOff + gIdx[ep] * 2);
        }
      }

      if (idx % progressInterval === 0) {
        self.postMessage({ type: 'progress', done: idx, total: N });
      }
    }

    self.postMessage(
      { type: 'done', projBuf, startIdx, count: N },
      [projBuf.buffer]
    );
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};
