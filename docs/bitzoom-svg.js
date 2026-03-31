// bitzoom-svg.js — SVG export for BitZoom.

import { RAW_LEVEL, ZOOM_LEVELS, buildLevel } from './bitzoom-algo.js';
import { generateGroupColors } from './bitzoom-colors.js';

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function scaleSize(val, bz) {
  return bz.sizeLog ? Math.log2(val + 1) : val;
}

function edgeHash(i) {
  let h = (i * 2654435761) >>> 0;
  return (h & 0x7fffffff) / 0x80000000;
}

function maxEdgesToDraw(nodeCount) {
  return Math.min(5000, Math.max(200, nodeCount * 3));
}

// ─── Density heatmap as SVG contour bands ─────────────────────────────────────

// Marching squares: trace iso-contours on a scalar grid.
// Uses a simple bitmap flood-fill approach: for each threshold, find all cells
// above threshold, trace the boundary, simplify, and smooth.

function traceThresholdRegions(grid, gw, gh, threshold) {
  // Trace boundaries of connected regions above threshold using Moore neighborhood
  // contour tracing. Produces properly ordered closed polygons without spikes.
  const above = new Uint8Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) above[i] = grid[i] >= threshold ? 1 : 0;

  const isAbove = (x, y) => x >= 0 && x < gw && y >= 0 && y < gh && above[y * gw + x];
  const traced = new Uint8Array(gw * gh); // marks cells that have been part of a traced boundary
  const polys = [];

  // Moore neighborhood: 8 directions clockwise from left
  //   5 6 7
  //   4 . 0
  //   3 2 1
  const dx = [1, 1, 0, -1, -1, -1, 0, 1];
  const dy = [0, 1, 1, 1, 0, -1, -1, -1];

  for (let sy = 0; sy < gh; sy++) {
    for (let sx = 0; sx < gw; sx++) {
      // Find boundary cell: above threshold with a non-above neighbor to the left (or at edge)
      if (!above[sy * gw + sx]) continue;
      if (sx > 0 && above[sy * gw + sx - 1]) continue; // not a left-edge boundary
      if (traced[sy * gw + sx]) continue;

      // Trace boundary clockwise using Moore neighbor tracing
      const poly = [];
      let cx = sx, cy = sy;
      let dir = 6; // start looking up-left (came from left)
      const maxSteps = gw * gh * 4; // must accommodate large complex contours
      let steps = 0;

      do {
        // Avoid adding duplicate consecutive points
        const last = poly.length > 0 ? poly[poly.length - 1] : null;
        if (!last || last.x !== cx || last.y !== cy) {
          poly.push({ x: cx, y: cy });
        }
        traced[cy * gw + cx] = 1;

        // Search clockwise for next boundary cell
        let found = false;
        for (let i = 0; i < 8; i++) {
          const nd = (dir + i) % 8;
          const nx = cx + dx[nd], ny = cy + dy[nd];
          if (isAbove(nx, ny)) {
            cx = nx; cy = ny;
            dir = (nd + 5) % 8;
            found = true;
            break;
          }
        }
        if (!found) break;
        if (++steps > maxSteps) break;
      } while (cx !== sx || cy !== sy);

      if (poly.length >= 4) polys.push(poly);
    }
  }
  return polys;
}

// Ramer-Douglas-Peucker simplification
function simplifyRDP(pts, epsilon) {
  if (pts.length <= 2) return pts;
  let maxDist = 0, maxIdx = 0;
  const a = pts[0], b = pts[pts.length - 1];
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  for (let i = 1; i < pts.length - 1; i++) {
    let dist;
    if (lenSq === 0) {
      const ex = pts[i].x - a.x, ey = pts[i].y - a.y;
      dist = Math.sqrt(ex * ex + ey * ey);
    } else {
      const t = Math.max(0, Math.min(1, ((pts[i].x - a.x) * dx + (pts[i].y - a.y) * dy) / lenSq));
      const px = a.x + t * dx, py = a.y + t * dy;
      const ex = pts[i].x - px, ey = pts[i].y - py;
      dist = Math.sqrt(ex * ex + ey * ey);
    }
    if (dist > maxDist) { maxDist = dist; maxIdx = i; }
  }
  if (maxDist > epsilon) {
    const left = simplifyRDP(pts.slice(0, maxIdx + 1), epsilon);
    const right = simplifyRDP(pts.slice(maxIdx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

// Chaikin corner-cutting (2 iterations for smooth curves)
function smoothChaikin(pts, iterations = 2) {
  let p = pts;
  for (let iter = 0; iter < iterations; iter++) {
    const out = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    p = out;
  }
  return p;
}

function polyToSVGPath(pts, scale) {
  if (pts.length < 3) return '';
  const p = pts.map(pt => ({ x: pt.x * scale, y: pt.y * scale }));
  let d = `M${p[0].x.toFixed(1)},${p[0].y.toFixed(1)}`;
  for (let i = 1; i < p.length; i++) d += ` L${p[i].x.toFixed(1)},${p[i].y.toFixed(1)}`;
  return d + ' Z';
}

function buildDensityContours(bz, scale) {
  const rz = bz.renderZoom;
  const W = bz.W, H = bz.H;
  const isRaw = bz.currentLevel === RAW_LEVEL;
  const allNodes = isRaw ? bz.nodes : bz.getLevel(bz.currentLevel).supernodes;
  const gw = Math.ceil(W / scale);
  const gh = Math.ceil(H / scale);
  const kernelR = Math.max(8, Math.min(40, Math.min(gw, gh) / 8));
  const kernelRSq = kernelR * kernelR;
  const totalCells = gw * gh;
  const light = bz._lightMode;

  // Group nodes by hex color
  const colorGroups = new Map(); // hex → [{gx, gy, weight}, ...]
  for (const n of allNodes) {
    const gx = (n.x * rz + bz.pan.x) / scale;
    const gy = (n.y * rz + bz.pan.y) / scale;
    if (gx < -kernelR || gx > gw + kernelR || gy < -kernelR || gy > gh + kernelR) continue;

    let weight;
    if (isRaw) {
      weight = scaleSize(bz.sizeBy === 'edges' ? (n.degree + 1) : 1, bz);
    } else {
      weight = scaleSize(bz.sizeBy === 'edges' ? (n.totalDegree + 1) : n.members.length, bz);
    }
    const hex = isRaw ? bz._nodeColor(n) : n.cachedColor;
    if (!colorGroups.has(hex)) colorGroups.set(hex, []);
    colorGroups.get(hex).push({ gx, gy, weight });
  }

  if (colorGroups.size === 0) return '';

  const thresholds = [0.08, 0.25, 0.5];
  const parts = [];
  parts.push('<defs><filter id="hblur"><feGaussianBlur stdDeviation="6"/></filter></defs>');
  parts.push('<g fill-rule="evenodd" filter="url(#hblur)">');

  // First pass: compute global density (all nodes) to find global maxW,
  // matching the canvas renderer which normalizes all colors together.
  const globalGrid = new Float32Array(totalCells);
  for (const [, nodes] of colorGroups) {
    for (const { gx, gy, weight } of nodes) {
      const x0 = Math.max(0, gx - kernelR | 0);
      const x1 = Math.min(gw - 1, gx + kernelR + 1 | 0);
      const y0 = Math.max(0, gy - kernelR | 0);
      const y1 = Math.min(gh - 1, gy + kernelR + 1 | 0);
      for (let cy = y0; cy <= y1; cy++) {
        const dy = cy - gy, dySq = dy * dy;
        const rowOff = cy * gw;
        for (let cx = x0; cx <= x1; cx++) {
          const dx = cx - gx;
          const distSq = dx * dx + dySq;
          if (distSq > kernelRSq) continue;
          const t = 1 - distSq / kernelRSq;
          globalGrid[rowOff + cx] += t * t * weight;
        }
      }
    }
  }
  let globalMaxW = 0;
  for (let i = 0; i < totalCells; i++) if (globalGrid[i] > globalMaxW) globalMaxW = globalGrid[i];
  if (globalMaxW < 0.001) return '';

  // Second pass: per-color density grids, thresholded against the global maxW
  const densGrid = new Float32Array(totalCells); // reused per color

  for (const [hex, nodes] of colorGroups) {
    densGrid.fill(0);

    // Accumulate kernel density for this color's nodes
    for (const { gx, gy, weight } of nodes) {
      const x0 = Math.max(0, gx - kernelR | 0);
      const x1 = Math.min(gw - 1, gx + kernelR + 1 | 0);
      const y0 = Math.max(0, gy - kernelR | 0);
      const y1 = Math.min(gh - 1, gy + kernelR + 1 | 0);
      for (let cy = y0; cy <= y1; cy++) {
        const dy = cy - gy, dySq = dy * dy;
        const rowOff = cy * gw;
        for (let cx = x0; cx <= x1; cx++) {
          const dx = cx - gx;
          const distSq = dx * dx + dySq;
          if (distSq > kernelRSq) continue;
          const t = 1 - distSq / kernelRSq;
          densGrid[rowOff + cx] += t * t * weight;
        }
      }
    }

    // Extract contour bands using global maxW for thresholds
    for (let ti = 0; ti < thresholds.length; ti++) {
      const thresh = thresholds[ti] * globalMaxW;
      const polys = traceThresholdRegions(densGrid, gw, gh, thresh);
      if (polys.length === 0) continue;

      const alpha = light ? 0.18 + ti * 0.12 : 0.12 + ti * 0.12;

      for (const poly of polys) {
        const simplified = simplifyRDP(poly, 0.5);
        if (simplified.length < 3) continue;
        const smoothed = smoothChaikin(simplified, 2);
        const d = polyToSVGPath(smoothed, scale);
        if (d) parts.push(`<path d="${d}" fill="${hex}" fill-opacity="${alpha.toFixed(2)}"/>`);
      }
    }
  }

  parts.push('</g>');
  return parts.join('\n');
}

/**
 * Create a lightweight view object for exportSVG from plain pipeline data.
 * No DOM or BitZoomCanvas required — suitable for headless/server-side export and testing.
 *
 * @param {object[]} nodes — node array with x, y, id, label, group, degree
 * @param {object[]} edges — edge array with src, dst
 * @param {object}   [opts]
 * @param {number}   [opts.width=800]
 * @param {number}   [opts.height=600]
 * @param {number}   [opts.zoom=1]       — renderZoom
 * @param {{x:number,y:number}} [opts.pan] — defaults to center
 * @param {string}   [opts.colorBy='group'] — property name for coloring
 * @param {number}   [opts.colorScheme=0]   — scheme index for generateGroupColors
 * @param {Record<string,string>} [opts.colorMap] — explicit value→hex map (overrides colorScheme)
 * @param {string}   [opts.sizeBy='nodes']
 * @param {boolean}  [opts.sizeLog=false]
 * @param {string}   [opts.edgeMode='lines']
 * @param {string}   [opts.heatmapMode='off']
 * @param {boolean}  [opts.lightMode=false]
 * @param {number|false} [opts.showLegend=false] — false or corner position 1-4
 * @param {Set<string>}  [opts.selectedIds]
 * @param {Set<string>}  [opts.labelProps]
 * @param {number}   [opts.level]        — aggregated level (omit for raw)
 * @returns {object} view compatible with exportSVG
 */
export function createSVGView(nodes, edges, opts = {}) {
  const W = opts.width || 800;
  const H = opts.height || 600;
  const rz = opts.zoom || 1;
  const pan = opts.pan || { x: W / 2, y: H / 2 };
  const colorBy = opts.colorBy || 'group';
  const sizeBy = opts.sizeBy || 'nodes';
  const sizeLog = opts.sizeLog || false;
  const edgeMode = opts.edgeMode || 'lines';
  const heatmapMode = opts.heatmapMode || 'off';
  const lightMode = opts.lightMode || false;
  const showLegend = opts.showLegend || false;
  const selectedIds = opts.selectedIds || new Set();
  const labelProps = opts.labelProps || new Set(['label']);

  // Build color map from node values
  const values = [...new Set(nodes.map(n => n[colorBy] || ''))];
  const colorMap = opts.colorMap || generateGroupColors(values, opts.colorScheme || 0);
  const dominant = colorBy;

  const nodeIndex = Object.fromEntries(nodes.map(n => [n.id, n]));

  // Level cache for aggregated views
  const levelCache = {};

  const view = {
    W, H, renderZoom: rz, pan,
    currentLevel: opts.level !== undefined ? opts.level : RAW_LEVEL,
    nodes, edges, nodeIndexFull: nodeIndex,
    sizeBy, sizeLog, edgeMode, heatmapMode,
    showLegend, selectedIds, hoveredId: null, labelProps,
    _lightMode: lightMode,
    _nodeColor: n => colorMap[n[colorBy] || ''] || '#888888',
    _nodeLabel: n => n.label || n.id,
    _nodeColorVal: n => n[colorBy] || '',
    _cachedColorMap: colorMap,
    _cachedDominant: dominant,
    getLevel(l) {
      if (!levelCache[l]) {
        levelCache[l] = buildLevel(l, nodes, edges, nodeIndex,
          n => n[colorBy] || '', n => n.label || n.id,
          v => colorMap[v] || '#888888');
      }
      return levelCache[l];
    },
  };
  return view;
}

/**
 * Export the current BitZoomCanvas state as an SVG string.
 * @param {object} bz — BitZoomCanvas instance or createSVGView() result
 * @param {object} [opts] — { background: true, grid: true, edges: true, labels: true, legend: true }
 * @returns {string} SVG markup
 */
export function exportSVG(bz, opts = {}) {
  const W = bz.W, H = bz.H;
  const rz = bz.renderZoom;
  const isRaw = bz.currentLevel === RAW_LEVEL;
  const bg = opts.background !== false;
  const grid = opts.grid !== false;
  const edges = opts.edges !== false;
  const labels = opts.labels !== false;
  const legend = opts.legend !== false && bz.showLegend;
  const light = bz._lightMode;

  const parts = [];
  const meta = opts.metadata ? ` | ${opts.metadata}` : '';
  parts.push(`<!-- Generated by BitZoom${meta} — https://github.com/wistrand/bitzoom -->`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);

  // Background
  if (bg) {
    const bgColor = light ? '#ffffff' : '#12122a';
    parts.push(`<rect width="${W}" height="${H}" fill="${bgColor}"/>`);
  }

  // Grid
  if (grid) {
    const gridSize = 40 * rz;
    if (gridSize >= 4) {
      const gridColor = light ? 'rgba(100,100,140,0.15)' : 'rgba(60,60,100,0.3)';
      const ox = bz.pan.x % gridSize;
      const oy = bz.pan.y % gridSize;
      parts.push(`<g stroke="${gridColor}" stroke-width="0.5">`);
      for (let x = ox; x < W; x += gridSize) parts.push(`<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${H}"/>`);
      for (let y = oy; y < H; y += gridSize) parts.push(`<line x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}"/>`);
      parts.push('</g>');
    }
  }

  // Get nodes and edges
  let allNodes, snEdges, cellPx, getColor, getId, getSizeVal, getLabel;
  if (isRaw) {
    allNodes = bz.nodes;
    snEdges = bz.edges;
    cellPx = (Math.min(W, H) * rz) / 256;
    getColor = n => bz._nodeColor(n);
    getId = n => n.id;
    getSizeVal = n => bz.sizeBy === 'edges' ? n.degree : 1;
    getLabel = n => bz._nodeLabel(n);
  } else {
    const level = bz.getLevel(bz.currentLevel);
    allNodes = level.supernodes;
    snEdges = level.snEdges || [];
    const k = 1 << ZOOM_LEVELS[bz.currentLevel];
    cellPx = (Math.min(W, H) * rz) / k;
    getColor = n => n.cachedColor;
    getId = n => n.bid;
    getSizeVal = n => bz.sizeBy === 'edges' ? n.totalDegree : n.members.length;
    getLabel = n => n.cachedLabel;
  }

  // Edges
  if (edges && bz.edgeMode !== 'none') {
    const diag = Math.sqrt(W * W + H * H);
    const maxEdgeLen = diag * 1.2;
    const maxEdgeLenSq = maxEdgeLen * maxEdgeLen;
    const fadeStart = diag * 0.25;
    const fadeStartSq = fadeStart * fadeStart;
    const fadeRange = maxEdgeLen - fadeStart;
    const maxE = maxEdgesToDraw(allNodes.length);
    const sampleRate = (isRaw ? bz.edges.length : snEdges.length) > maxE ? maxE / (isRaw ? bz.edges.length : snEdges.length) : 1;
    const edgeColor = isRaw ? [100, 100, 140] : [124, 106, 247];
    const maxAlpha = isRaw ? 0.25 : 0.4;

    let nodeMap;
    if (isRaw) {
      nodeMap = bz.nodeIndexFull;
    } else {
      const level = bz.getLevel(bz.currentLevel);
      if (!level._snByBid) {
        level._snByBid = new Map();
        for (const sn of level.supernodes) level._snByBid.set(sn.bid, sn);
      }
      nodeMap = level._snByBid;
    }

    const getNode = isRaw ? (id => nodeMap[id]) : (id => nodeMap.get(id));
    const getSrc = isRaw ? (e => e.src) : (e => e.a);
    const getDst = isRaw ? (e => e.dst) : (e => e.b);
    const getWeight = isRaw ? (() => 1) : (e => e.weight);
    const edgeList = isRaw ? bz.edges : snEdges;

    parts.push(`<g fill="none">`);
    let drawn = 0;
    for (let i = 0; i < edgeList.length; i++) {
      const e = edgeList[i];
      const a = getNode(getSrc(e)), b = getNode(getDst(e));
      if (!a || !b) continue;
      const ax = a.x * rz + bz.pan.x, ay = a.y * rz + bz.pan.y;
      const bx = b.x * rz + bz.pan.x, by = b.y * rz + bz.pan.y;
      const dx = ax - bx, dy = ay - by;
      const distSq = dx * dx + dy * dy;
      if (distSq > maxEdgeLenSq) continue;
      if (sampleRate < 1 && edgeHash(i) > sampleRate * (2 - distSq / maxEdgeLenSq)) continue;
      if (++drawn > maxE) break;
      const distFade = distSq <= fadeStartSq ? 1 : Math.max(0, 1 - (Math.sqrt(distSq) - fadeStart) / fadeRange);
      const w = getWeight(e);
      const alpha = isRaw ? maxAlpha * distFade : Math.min(maxAlpha, 0.05 + w * 0.05) * distFade;
      if (alpha < 0.01) continue;

      const stroke = `rgba(${edgeColor[0]},${edgeColor[1]},${edgeColor[2]},${alpha.toFixed(3)})`;
      if (bz.edgeMode === 'curves') {
        const edx = bx - ax, edy = by - ay;
        const len = Math.sqrt(edx * edx + edy * edy);
        if (len < 1) {
          parts.push(`<line x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="${stroke}" stroke-width="1"/>`);
        } else {
          const px = -edy / len, py = edx / len;
          const c1x = ax + edx * 0.3 + px * len * 0.15;
          const c1y = ay + edy * 0.3 + py * len * 0.15;
          const c2x = ax + edx * 0.7 + px * len * 0.05;
          const c2y = ay + edy * 0.7 + py * len * 0.05;
          parts.push(`<path d="M${ax.toFixed(1)},${ay.toFixed(1)} C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${bx.toFixed(1)},${by.toFixed(1)}" stroke="${stroke}" stroke-width="1"/>`);
        }
      } else {
        parts.push(`<line x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="${stroke}" stroke-width="1"/>`);
      }
    }
    parts.push('</g>');
  }

  // Heatmap density contours (between edges and circles, matching render order)
  if (opts.heatmap !== false && bz.heatmapMode === 'density') {
    const heatSvg = buildDensityContours(bz, 4);
    if (heatSvg) parts.push(heatSvg);
  }

  // Circles + labels
  const rMaxBase = isRaw
    ? Math.max(1, Math.min(cellPx * 0.40, 20))
    : Math.max(1.5, Math.min(cellPx * 0.42, 40));
  const rMin = isRaw ? 1 : 1.5;
  const rScale = isRaw ? 1.0 : 1.2;

  // Visible count + max for importance
  let visibleCount = 0, maxSizeVal = 1;
  const margin = cellPx * 0.5;
  for (const n of allNodes) {
    const sx = n.x * rz + bz.pan.x, sy = n.y * rz + bz.pan.y;
    if (sx >= -margin && sx <= W + margin && sy >= -margin && sy <= H + margin) {
      visibleCount++;
      const sv = scaleSize(getSizeVal(n), bz);
      if (sv > maxSizeVal) maxSizeVal = sv;
    }
  }

  const selIds = bz.selectedIds;
  const hov = bz.hoveredId;
  const circleParts = [];
  const labelParts = [];

  for (const n of allNodes) {
    const px = n.x * rz + bz.pan.x;
    const py = n.y * rz + bz.pan.y;
    if (px < -rMaxBase || px > W + rMaxBase || py < -rMaxBase || py > H + rMaxBase) continue;

    const rawSizeVal = getSizeVal(n);
    const sizeVal = scaleSize(rawSizeVal, bz);
    const r = Math.max(rMin, Math.min(rMaxBase, rMin + Math.sqrt(sizeVal) * rScale));
    const col = getColor(n);
    const nid = getId(n);
    const isSelected = selIds.has(nid);
    const isHovered = hov === nid;
    const importance = visibleCount > 50 ? 0.3 + 0.7 * Math.sqrt(sizeVal / maxSizeVal) : 1;

    let fillA, strokeCol, strokeA;
    if (isRaw) {
      fillA = isSelected ? 1.0 : isHovered ? 0.8 : 0xbb / 0xff;
      strokeCol = isSelected ? '#fff' : col;
      strokeA = isSelected ? 1.0 : 0;
    } else {
      fillA = isSelected ? 1.0 : isHovered ? 0.8 : (importance * 0x99 / 0xff);
      strokeCol = isSelected ? '#fff' : col;
      strokeA = isSelected ? 1.0 : isHovered ? 1.0 : importance;
    }

    circleParts.push(`<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${r.toFixed(1)}" fill="${col}" fill-opacity="${fillA.toFixed(2)}" stroke="${strokeCol}" stroke-opacity="${strokeA.toFixed(2)}" stroke-width="${isSelected ? 2 : 1}"/>`);

    // Labels
    if (labels) {
      const showLabel = isSelected || isHovered
        || (visibleCount <= 50 && cellPx >= 20)
        || (visibleCount <= 150 && importance > 0.7 && cellPx >= 20);
      if (showLabel) {
        const rawLabel = getLabel(n);
        const labelParts2 = rawLabel.split(' · ');
        const hasMulti = labelParts2.length > 1 && bz.labelProps.has('label');
        const fs = isSelected || isHovered ? Math.max(11, Math.min(12, cellPx * 0.18)) | 0 : Math.max(10, Math.min(13, cellPx * 0.18)) | 0;
        const fillColor = light
          ? (isSelected ? '#111' : isHovered ? 'rgba(30,30,60,0.9)' : 'rgba(50,50,80,0.8)')
          : (isSelected ? '#fff' : isHovered ? 'rgba(230,230,255,0.95)' : 'rgba(220,220,255,0.85)');
        const bold = isSelected || isHovered ? ' font-weight="bold"' : '';

        if (hasMulti) {
          labelParts.push(`<text x="${px.toFixed(1)}" y="${(py - r - 3).toFixed(1)}" text-anchor="middle" dominant-baseline="auto" fill="${fillColor}" font-size="${fs}"${bold}>${esc(labelParts2[0])}</text>`);
          labelParts.push(`<text x="${px.toFixed(1)}" y="${(py + r + 3 + fs).toFixed(1)}" text-anchor="middle" dominant-baseline="auto" fill="${fillColor}" font-size="${Math.max(9, fs - 1)}">${esc(labelParts2.slice(1).join(' · '))}</text>`);
        } else {
          const charW = fs * 0.6;
          const maxChars = isSelected || isHovered ? 999 : Math.max(3, (cellPx / charW) | 0);
          const text = rawLabel.length > maxChars ? rawLabel.slice(0, maxChars - 1) + '…' : rawLabel;
          labelParts.push(`<text x="${px.toFixed(1)}" y="${(py - r - 3).toFixed(1)}" text-anchor="middle" dominant-baseline="auto" fill="${fillColor}" font-size="${fs}"${bold}>${esc(text)}</text>`);
        }
      }
    }
  }

  parts.push('<g>' + circleParts.join('') + '</g>');
  if (labelParts.length > 0) parts.push(`<g font-family="JetBrains Mono, monospace">` + labelParts.join('') + '</g>');

  // Legend
  if (legend) {
    const colorMap = bz._cachedColorMap;
    if (colorMap) {
      const allEntries = Object.entries(colorMap);
      if (allEntries.length > 0) {
        const counts = {};
        for (const n of allNodes) {
          const val = isRaw ? bz._nodeColorVal(n) : (n.cachedColorVal || '');
          counts[val] = (counts[val] || 0) + 1;
        }
        allEntries.sort((a, b) => (counts[b[0]] || 0) - (counts[a[0]] || 0));
        const MAX_ENTRIES = 12;
        const entries = allEntries.slice(0, MAX_ENTRIES);
        const overflow = allEntries.length - entries.length;

        const fontSize = 10;
        const dotR = 4;
        const lineH = 16;
        const pad = 8;
        const headerH = 14;
        const headerText = bz._cachedDominant.toUpperCase();

        const boxW = 120;
        const boxH = headerH + entries.length * lineH + (overflow > 0 ? lineH : 0) + pad * 2;
        const pos = bz.showLegend || 1;
        const lm = 8;
        const lx = (pos === 2 || pos === 3) ? lm : W - boxW - lm;
        const ly = (pos === 3 || pos === 4) ? lm : H - boxH - lm;

        const legendBg = light ? 'rgba(255,255,255,0.85)' : 'rgba(10,10,15,0.75)';
        const legendText = light ? '#333340' : '#c8c8d8';
        const legendDim = light ? '#6a6a80' : '#8888a0';

        parts.push(`<g font-family="JetBrains Mono, monospace">`);
        parts.push(`<rect x="${lx}" y="${ly}" width="${boxW}" height="${boxH}" rx="4" fill="${legendBg}"/>`);
        parts.push(`<text x="${lx + pad}" y="${ly + pad + 8}" fill="${legendDim}" font-size="8" font-weight="bold">${esc(headerText)}</text>`);

        for (let i = 0; i < entries.length; i++) {
          const [label, color] = entries[i];
          const ey = ly + pad + headerH + i * lineH + lineH / 2;
          parts.push(`<circle cx="${lx + pad + dotR}" cy="${ey}" r="${dotR}" fill="${color}"/>`);
          const truncated = label.length > 14 ? label.slice(0, 13) + '…' : label;
          parts.push(`<text x="${lx + pad + dotR * 2 + 6}" y="${ey + 3}" fill="${legendText}" font-size="${fontSize}">${esc(truncated)}</text>`);
        }
        if (overflow > 0) {
          const ey = ly + pad + headerH + entries.length * lineH + lineH / 2;
          parts.push(`<text x="${lx + pad}" y="${ey + 3}" fill="${legendDim}" font-size="${fontSize}">+${overflow} more</text>`);
        }
        parts.push('</g>');
      }
    }
  }

  parts.push('</svg>');
  return parts.join('\n');
}
