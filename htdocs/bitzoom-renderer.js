// bitzoom-renderer.js — Canvas rendering, heatmaps, edge drawing, hit testing.
// Optimized to minimize GC pressure: reusable point objects, cached strings.

import { RAW_LEVEL, ZOOM_LEVELS } from './bitzoom-algo.js';

// Adaptive edge cap: scales with visible node count to avoid clutter on dense graphs
function maxEdgesToDraw(nodeCount) {
  return Math.min(5000, Math.max(200, nodeCount * 3));
}

// ─── Reusable scratch objects (avoid per-frame allocations) ──────────────────
const _pa = {x: 0, y: 0};
const _pb = {x: 0, y: 0};
const _pt = {x: 0, y: 0};

// Hex→RGB cache to avoid parseInt in render loops
const _rgbCache = {};
function hexToRgb(hex) {
  if (_rgbCache[hex]) return _rgbCache[hex];
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const result = {r, g, b};
  _rgbCache[hex] = result;
  return result;
}

// Pre-built font string cache
const _fontCache = {};
function fontStr(size, bold) {
  const key = bold ? -size : size;
  if (_fontCache[key]) return _fontCache[key];
  const s = bold ? `bold ${size}px JetBrains Mono` : `${size}px JetBrains Mono`;
  _fontCache[key] = s;
  return s;
}

// Pre-built RGBA string cache (for common alpha values)
const _rgbaCache = {};
function rgba(r, g, b, a) {
  const key = (r << 24 | g << 16 | b << 8 | (a * 255) | 0) >>> 0;
  if (_rgbaCache[key]) return _rgbaCache[key];
  const s = `rgba(${r},${g},${b},${a})`;
  _rgbaCache[key] = s;
  return s;
}

// ─── Edge drawing ────────────────────────────────────────────────────────────

function drawEdge(ctx, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) { ctx.moveTo(ax, ay); ctx.lineTo(bx, by); return; }
  const px = -dy / len, py = dx / len;
  const c1x = ax + dx * 0.3 + px * len * 0.15;
  const c1y = ay + dy * 0.3 + py * len * 0.15;
  const c2x = ax + dx * 0.7 + px * len * 0.05;
  const c2y = ay + dy * 0.7 + py * len * 0.05;
  ctx.moveTo(ax, ay);
  ctx.bezierCurveTo(c1x, c1y, c2x, c2y, bx, by);
}

// ─── Coordinate transforms (write into reusable objects) ─────────────────────

function wts(bz, wx, wy, out) {
  out.x = wx * bz.renderZoom + bz.pan.x;
  out.y = wy * bz.renderZoom + bz.pan.y;
}

// Public versions that return objects (for non-hot paths)
export function worldToScreen(bz, wx, wy) {
  return { x: wx * bz.renderZoom + bz.pan.x, y: wy * bz.renderZoom + bz.pan.y };
}

export function screenToWorld(bz, sx, sy) {
  return { x: (sx - bz.pan.x) / bz.renderZoom, y: (sy - bz.pan.y) / bz.renderZoom };
}

// ─── Layout ──────────────────────────────────────────────────────────────────

export function layoutAll(bz) {
  const isRaw = bz.currentLevel === RAW_LEVEL - 1;
  const allNodes = isRaw ? bz.nodes : bz.getLevel(bz.currentLevel).supernodes;
  if (allNodes.length === 0) return;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < allNodes.length; i++) {
    const n = allNodes[i];
    const vx = n.ax !== undefined ? n.ax : n.px;
    const vy = n.ay !== undefined ? n.ay : n.py;
    if (vx < minX) minX = vx;
    if (vx > maxX) maxX = vx;
    if (vy < minY) minY = vy;
    if (vy > maxY) maxY = vy;
  }

  // Clip to ±3σ
  if (minX < -3) minX = -3;
  if (maxX > 3) maxX = 3;
  if (minY < -3) minY = -3;
  if (maxY > 3) maxY = 3;
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  const pad = Math.min(60, bz.W * 0.08, bz.H * 0.08);
  const availW = bz.W - pad * 2;
  const availH = bz.H - pad * 2;
  const scale = Math.min(availW / rangeX, availH / rangeY);
  const offsetX = pad + (availW - rangeX * scale) / 2;
  const offsetY = pad + (availH - rangeY * scale) / 2;

  if (isRaw) {
    for (let i = 0; i < bz.nodes.length; i++) {
      const n = bz.nodes[i];
      const ax = Math.max(minX, Math.min(maxX, n.px));
      const ay = Math.max(minY, Math.min(maxY, n.py));
      n.x = offsetX + (ax - minX) * scale;
      n.y = offsetY + (ay - minY) * scale;
    }
  } else {
    const sns = bz.getLevel(bz.currentLevel).supernodes;
    for (let i = 0; i < sns.length; i++) {
      const sn = sns[i];
      const ax = Math.max(minX, Math.min(maxX, sn.ax));
      const ay = Math.max(minY, Math.min(maxY, sn.ay));
      sn.x = offsetX + (ax - minX) * scale;
      sn.y = offsetY + (ay - minY) * scale;
    }
  }
}

// ─── Main render ─────────────────────────────────────────────────────────────

export function render(bz) {
  const ctx = bz.ctx;
  const W = bz.W, H = bz.H;
  ctx.clearRect(0, 0, W, H);

  // Background grid
  ctx.strokeStyle = 'rgba(60,60,100,0.6)';
  ctx.lineWidth = 0.5;
  const gridSize = 40 * bz.renderZoom;
  const ox = bz.pan.x % gridSize;
  const oy = bz.pan.y % gridSize;
  ctx.beginPath();
  for (let x = ox; x < W; x += gridSize) { ctx.moveTo(x,0); ctx.lineTo(x,H); }
  for (let y = oy; y < H; y += gridSize) { ctx.moveTo(0,y); ctx.lineTo(W,y); }
  ctx.stroke();

  // Layer order: edges → heatmap → hilited edges → circles → labels/counts
  const isRaw = bz.currentLevel === RAW_LEVEL - 1;
  const renderFn = isRaw ? renderNodes : renderSupernodes;
  renderFn(bz, 'edges');
  if (bz.heatmapMode === 'splat') renderHeatmapSplat(bz);
  else if (bz.heatmapMode === 'density') renderHeatmapDensity(bz);
  renderFn(bz, 'hilite');
  renderFn(bz, 'circles');
  renderFn(bz, 'labels');
}

// ─── Supernode rendering ─────────────────────────────────────────────────────

function renderSupernodes(bz, pass) {
  const ctx = bz.ctx;
  const { supernodes, snEdges } = bz.getLevel(bz.currentLevel);

  // Build snMap using direct index — avoid Object.fromEntries per frame
  const snMap = {};
  for (let i = 0; i < supernodes.length; i++) snMap[supernodes[i].bid] = supernodes[i];

  const diag = Math.sqrt(bz.W * bz.W + bz.H * bz.H);
  const maxEdgeLen = diag * 1.2;
  const maxEdgeLenSq = maxEdgeLen * maxEdgeLen;
  const fadeStart = diag * 0.25;
  const fadeRange = maxEdgeLen - fadeStart;
  const rz = bz.renderZoom;

  const selIds = bz.selectedIds;
  const hasSel = selIds.size > 0;
  const hov = bz.hoveredId;

  if (pass === 'edges') {
    // Normal edges — drawn behind heatmap
    const maxEdges = maxEdgesToDraw(supernodes.length);
    const snSampleRate = snEdges.length > maxEdges ? maxEdges / snEdges.length : 1;
    let snDrawn = 0;

    for (let i = 0; i < snEdges.length; i++) {
      const e = snEdges[i];
      const a = snMap[e.a], b = snMap[e.b];
      if (!a || !b) continue;
      if ((hasSel && (selIds.has(e.a) || selIds.has(e.b))) || (hov !== null && (e.a === hov || e.b === hov))) continue;
      const pax = a.x * rz + bz.pan.x, pay = a.y * rz + bz.pan.y;
      const pbx = b.x * rz + bz.pan.x, pby = b.y * rz + bz.pan.y;
      const dx = pax - pbx, dy = pay - pby;
      const distSq = dx * dx + dy * dy;
      if (distSq > maxEdgeLenSq) continue;
      const dist = Math.sqrt(distSq);
      if (snSampleRate < 1) {
        if (Math.random() > snSampleRate * (2 - dist / maxEdgeLen)) continue;
      }
      if (++snDrawn > maxEdges) break;
      const distFade = dist <= fadeStart ? 1 : Math.max(0, 1 - (dist - fadeStart) / fadeRange);
      const alpha = Math.min(0.4, 0.05 + e.weight * 0.05) * distFade;
      if (alpha < 0.01) continue;
      ctx.strokeStyle = rgba(124, 106, 247, (alpha * 100 | 0) / 100);
      ctx.lineWidth = Math.min(3, 0.5 + e.weight * 0.3);
      ctx.beginPath();
      drawEdge(ctx, pax, pay, pbx, pby);
      ctx.stroke();
    }
    return;
  }

  // Shared setup for circles/labels passes
  const k = 1 << ZOOM_LEVELS[bz.currentLevel];
  const cellPx = (Math.min(bz.W, bz.H) * rz) / k;

  if (pass === 'hilite') {
    // Highlighted edges for selected + hovered nodes
    if (hasSel || hov !== null) {
      for (let i = 0; i < snEdges.length; i++) {
        const e = snEdges[i];
        const aHit = selIds.has(e.a) || e.a === hov;
        const bHit = selIds.has(e.b) || e.b === hov;
        if (!aHit && !bHit) continue;
        const a = snMap[e.a], b = snMap[e.b];
        if (!a || !b) continue;
        const pax = a.x * rz + bz.pan.x, pay = a.y * rz + bz.pan.y;
        const pbx = b.x * rz + bz.pan.x, pby = b.y * rz + bz.pan.y;
        ctx.strokeStyle = (selIds.has(e.a) || selIds.has(e.b)) ? 'rgba(180,180,220,0.3)' : 'rgba(180,180,220,0.15)';
        ctx.lineWidth = Math.min(4, 1 + e.weight * 0.4);
        ctx.beginPath();
        drawEdge(ctx, pax, pay, pbx, pby);
        ctx.stroke();
      }
    }
    return;
  }

  // Count visible supernodes + find max size for opacity scaling
  let visibleCount = 0;
  let maxSizeVal = 1;
  const margin = cellPx * 0.5;
  for (let i = 0; i < supernodes.length; i++) {
    const sn = supernodes[i];
    const sx = sn.x * rz + bz.pan.x, sy = sn.y * rz + bz.pan.y;
    if (sx >= -margin && sx <= bz.W + margin && sy >= -margin && sy <= bz.H + margin) {
      visibleCount++;
      const sv = bz.sizeBy === 'edges' ? sn.totalDegree : sn.members.length;
      if (sv > maxSizeVal) maxSizeVal = sv;
    }
  }

  for (let i = 0; i < supernodes.length; i++) {
    const sn = supernodes[i];
    const px = sn.x * rz + bz.pan.x, py = sn.y * rz + bz.pan.y;
    const rMax = Math.max(1.5, Math.min(cellPx * 0.42, 40));
    if (px < -rMax || px > bz.W + rMax || py < -rMax || py > bz.H + rMax) continue;

    const sizeVal = bz.sizeBy === 'edges' ? sn.totalDegree : sn.members.length;
    const r = Math.max(1.5, Math.min(rMax, 1.5 + Math.sqrt(sizeVal) * 1.2));
    const col = sn.cachedColor;
    const isSelected = selIds.has(sn.bid);
    const isHovered = hov === sn.bid;
    const importance = visibleCount > 50 ? 0.3 + 0.7 * Math.sqrt(sizeVal / maxSizeVal) : 1;

    if (pass === 'circles') {
      if (isSelected || isHovered) {
        const grad = ctx.createRadialGradient(px, py, 0, px, py, r * 2.5);
        grad.addColorStop(0, col + '44');
        grad.addColorStop(1, col + '00');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(px, py, r * 2.5, 0, Math.PI * 2);
        ctx.fill();
      }

      const normalAlpha = Math.round(importance * 0x99).toString(16).padStart(2, '0');
      ctx.fillStyle = col + (isSelected ? 'ff' : isHovered ? 'cc' : normalAlpha);
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = isSelected ? '#fff' : col;
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.globalAlpha = isSelected || isHovered ? 1 : importance;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (pass === 'labels') {
      // Count inside node
      const showCount = isSelected || isHovered
        || visibleCount <= 100
        || (visibleCount <= 200 && importance > 0.7);
      if (showCount && cellPx >= 10 && r >= 3) {
        const fs = Math.max(7, Math.min(13, r * 1.0)) | 0;
        ctx.fillStyle = '#ffffffcc';
        ctx.font = fontStr(fs, true);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(bz.sizeBy === 'edges' ? sn.totalDegree : sn.members.length, px, py);
      }

      // Label above node
      const showLabel = isSelected || isHovered
        || (visibleCount <= 50 && cellPx >= 20)
        || (visibleCount <= 150 && importance > 0.7 && cellPx >= 20);
      if (showLabel) {
        const rawLabel = sn.cachedLabel;
        if (isSelected || isHovered) {
          const fs = Math.max(11, Math.min(12, cellPx * 0.18)) | 0;
          ctx.fillStyle = isSelected ? '#fff' : 'rgba(230,230,255,0.95)';
          ctx.font = fontStr(fs, true);
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(rawLabel, px, py - r - 3);
        } else {
          const fs = Math.max(10, Math.min(13, cellPx * 0.18)) | 0;
          const charW = fs * 0.6;
          const maxChars = Math.max(3, (cellPx / charW) | 0);
          const label = rawLabel.length > maxChars ? rawLabel.slice(0, maxChars - 1) + '…' : rawLabel;
          ctx.fillStyle = 'rgba(220,220,255,0.85)';
          ctx.font = fontStr(fs, false);
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(label, px, py - r - 3);
        }
      }
    }
  }
}

// ─── Raw node rendering ──────────────────────────────────────────────────────

function renderNodes(bz, pass) {
  const ctx = bz.ctx;
  const rz = bz.renderZoom;
  const cellPxRaw = (Math.min(bz.W, bz.H) * rz) / 256;

  const diag = Math.sqrt(bz.W * bz.W + bz.H * bz.H);
  const maxEdgeLen = diag * 1.2;
  const maxEdgeLenSq = maxEdgeLen * maxEdgeLen;
  const fadeStart = diag * 0.25;
  const fadeRange = maxEdgeLen - fadeStart;

  const selIds = bz.selectedIds;
  const hasSel = selIds.size > 0;
  const hov = bz.hoveredId;

  if (pass === 'edges') {
    // Normal edges — drawn behind heatmap
    const maxEdges = maxEdgesToDraw(bz.nodes.length);
    const rawSampleRate = bz.edges.length > maxEdges ? maxEdges / bz.edges.length : 1;
    let rawDrawn = 0;

    const ALPHA_BUCKETS = 10;
    const edgeBuckets = new Array(ALPHA_BUCKETS);
    for (let b = 0; b < ALPHA_BUCKETS; b++) edgeBuckets[b] = [];

    for (let i = 0; i < bz.edges.length; i++) {
      const e = bz.edges[i];
      const a = bz.nodeIndexFull[e.src], b = bz.nodeIndexFull[e.dst];
      if (!a || !b) continue;
      if ((hasSel && (selIds.has(e.src) || selIds.has(e.dst))) || (hov !== null && (e.src === hov || e.dst === hov))) continue;
      const pax = a.x * rz + bz.pan.x, pay = a.y * rz + bz.pan.y;
      const pbx = b.x * rz + bz.pan.x, pby = b.y * rz + bz.pan.y;
      const dx = pax - pbx, dy = pay - pby;
      const distSq = dx * dx + dy * dy;
      if (distSq > maxEdgeLenSq) continue;
      const dist = Math.sqrt(distSq);
      if (rawSampleRate < 1) {
        if (Math.random() > rawSampleRate * (2 - dist / maxEdgeLen)) continue;
      }
      if (++rawDrawn > maxEdges) break;
      const distFade = dist <= fadeStart ? 1 : Math.max(0, 1 - (dist - fadeStart) / fadeRange);
      const alpha = 0.25 * distFade;
      if (alpha < 0.01) continue;
      const bucket = Math.min(ALPHA_BUCKETS - 1, (alpha / 0.25 * ALPHA_BUCKETS) | 0);
      edgeBuckets[bucket].push(pax, pay, pbx, pby);
    }

    ctx.lineWidth = 0.8;
    for (let b = 0; b < ALPHA_BUCKETS; b++) {
      const coords = edgeBuckets[b];
      if (coords.length === 0) continue;
      const a = ((b + 0.5) / ALPHA_BUCKETS * 25 | 0) / 100;
      ctx.strokeStyle = rgba(100, 100, 140, a);
      ctx.beginPath();
      for (let j = 0; j < coords.length; j += 4) {
        drawEdge(ctx, coords[j], coords[j+1], coords[j+2], coords[j+3]);
      }
      ctx.stroke();
    }
    return;
  }

  if (pass === 'hilite') {
    // Highlighted edges for selected + hovered nodes
    if (hasSel || hov !== null) {
      for (let i = 0; i < bz.edges.length; i++) {
        const e = bz.edges[i];
        const aHit = selIds.has(e.src) || e.src === hov;
        const bHit = selIds.has(e.dst) || e.dst === hov;
        if (!aHit && !bHit) continue;
        const a = bz.nodeIndexFull[e.src], b = bz.nodeIndexFull[e.dst];
        if (!a || !b) continue;
        const pax = a.x * rz + bz.pan.x, pay = a.y * rz + bz.pan.y;
        const pbx = b.x * rz + bz.pan.x, pby = b.y * rz + bz.pan.y;
        ctx.strokeStyle = (selIds.has(e.src) || selIds.has(e.dst)) ? 'rgba(180,180,220,0.3)' : 'rgba(180,180,220,0.15)';
        ctx.lineWidth = (selIds.has(e.src) || selIds.has(e.dst)) ? 1.5 : 1;
        ctx.beginPath();
        drawEdge(ctx, pax, pay, pbx, pby);
        ctx.stroke();
      }
    }
    return;
  }

  // Shared node loop for 'circles' and 'labels' passes
  for (let i = 0; i < bz.nodes.length; i++) {
    const n = bz.nodes[i];
    const px = n.x * rz + bz.pan.x, py = n.y * rz + bz.pan.y;
    const rMaxRaw = Math.max(1, Math.min(cellPxRaw * 0.40, 20));
    if (px < -rMaxRaw || px > bz.W + rMaxRaw || py < -rMaxRaw || py > bz.H + rMaxRaw) continue;

    const sizeVal = bz.sizeBy === 'edges' ? n.degree : 1;
    const r = Math.max(1, Math.min(rMaxRaw, 1 + Math.sqrt(sizeVal) * 1.0));
    const col = bz._nodeColor(n);
    const isSelected = selIds.has(n.id);
    const isHovered = hov === n.id;

    if (pass === 'circles') {
      if (isSelected || isHovered) {
        const grad = ctx.createRadialGradient(px, py, 0, px, py, r*3);
        grad.addColorStop(0, col+'66');
        grad.addColorStop(1, col+'00');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(px, py, r*3, 0, Math.PI*2);
        ctx.fill();
      }

      ctx.fillStyle = col + (isSelected ? 'ff' : 'bb');
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI*2);
      ctx.fill();

      if (isSelected) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    if (pass === 'labels') {
      if (isSelected || isHovered || cellPxRaw >= 14) {
        const rawLabel = bz._nodeLabel(n);
        if (isSelected || isHovered) {
          const fs = Math.max(11, Math.min(12, cellPxRaw * 0.22)) | 0;
          ctx.fillStyle = isSelected ? '#fff' : 'rgba(230,230,255,0.95)';
          ctx.font = fontStr(fs, true);
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(rawLabel, px + r + 3, py);
        } else {
          const fs = Math.max(10, Math.min(13, cellPxRaw * 0.22)) | 0;
          const charW = fs * 0.6;
          const maxChars = Math.max(4, ((cellPxRaw * 0.8) / charW) | 0);
          const text = rawLabel.length > maxChars ? rawLabel.slice(0, maxChars - 1) + '…' : rawLabel;
          ctx.fillStyle = 'rgba(200,200,220,0.75)';
          ctx.font = fontStr(fs, false);
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(text, px + r + 3, py);
        }
      }
    }
  }
}

// ─── Heatmap: Gaussian splat ─────────────────────────────────────────────────

function renderHeatmapSplat(bz) {
  const ctx = bz.ctx;
  const W = bz.W, H = bz.H;
  const rz = bz.renderZoom;
  const isRaw = bz.currentLevel === RAW_LEVEL - 1;
  const allNodes = isRaw ? bz.nodes : bz.getLevel(bz.currentLevel).supernodes;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.6;

  for (let i = 0; i < allNodes.length; i++) {
    const n = allNodes[i];
    const px = n.x * rz + bz.pan.x, py = n.y * rz + bz.pan.y;
    const maxR = isRaw ? 200 : 400;
    if (px < -maxR || px > W + maxR || py < -maxR || py > H + maxR) continue;

    let weight;
    if (isRaw) {
      weight = bz.sizeBy === 'edges' ? (n.degree + 1) : 1;
    } else {
      weight = bz.sizeBy === 'edges' ? (n.totalDegree + 1) : n.members.length;
    }
    const r = Math.max(50, Math.min(maxR, 50 + Math.sqrt(weight) * 25));

    const hexCol = isRaw ? bz._nodeColor(n) : n.cachedColor;
    const rgb = hexToRgb(hexCol);

    const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
    grad.addColorStop(0, rgba(rgb.r, rgb.g, rgb.b, 0.25));
    grad.addColorStop(0.5, rgba(rgb.r, rgb.g, rgb.b, 0.08));
    grad.addColorStop(1, rgba(rgb.r, rgb.g, rgb.b, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

// ─── Heatmap: Kernel density ─────────────────────────────────────────────────

// Persistent buffers — reused across frames to avoid GC
let _densityGw = 0, _densityGh = 0;
let _densityR = null, _densityG = null, _densityB = null, _densityW = null;
let _densityImgData = null;
let _densityCanvas = null;

function renderHeatmapDensity(bz) {
  const W = bz.W, H = bz.H;
  const rz = bz.renderZoom;
  const isRaw = bz.currentLevel === RAW_LEVEL - 1;
  const allNodes = isRaw ? bz.nodes : bz.getLevel(bz.currentLevel).supernodes;

  const scale = 4;
  const gw = Math.ceil(W / scale);
  const gh = Math.ceil(H / scale);
  const totalCells = gw * gh;

  // Reallocate buffers only when grid size changes
  if (gw !== _densityGw || gh !== _densityGh) {
    _densityGw = gw;
    _densityGh = gh;
    _densityR = new Float32Array(totalCells);
    _densityG = new Float32Array(totalCells);
    _densityB = new Float32Array(totalCells);
    _densityW = new Float32Array(totalCells);
    _densityImgData = new ImageData(gw, gh);
    _densityCanvas = new OffscreenCanvas(gw, gh);
  }

  // Clear buffers
  _densityR.fill(0);
  _densityG.fill(0);
  _densityB.fill(0);
  _densityW.fill(0);

  const kernelR = Math.max(8, Math.min(40, gw / 8));
  const kernelRSq = kernelR * kernelR;

  for (let i = 0; i < allNodes.length; i++) {
    const n = allNodes[i];
    const gx = (n.x * rz + bz.pan.x) / scale;
    const gy = (n.y * rz + bz.pan.y) / scale;

    if (gx < -kernelR || gx > gw + kernelR || gy < -kernelR || gy > gh + kernelR) continue;

    let weight;
    if (isRaw) {
      weight = bz.sizeBy === 'edges' ? (n.degree + 1) : 1;
    } else {
      weight = bz.sizeBy === 'edges' ? (n.totalDegree + 1) : n.members.length;
    }

    const hexCol = isRaw ? bz._nodeColor(n) : n.cachedColor;
    const rgb = hexToRgb(hexCol);

    const x0 = Math.max(0, gx - kernelR | 0);
    const x1 = Math.min(gw - 1, gx + kernelR + 1 | 0);
    const y0 = Math.max(0, gy - kernelR | 0);
    const y1 = Math.min(gh - 1, gy + kernelR + 1 | 0);

    for (let cy = y0; cy <= y1; cy++) {
      const dy = cy - gy;
      const dySq = dy * dy;
      const rowOff = cy * gw;
      for (let cx = x0; cx <= x1; cx++) {
        const dx = cx - gx;
        const distSq = dx * dx + dySq;
        if (distSq > kernelRSq) continue;
        const t = 1 - distSq / kernelRSq;
        const k = t * t * weight;
        const idx = rowOff + cx;
        _densityR[idx] += rgb.r * k;
        _densityG[idx] += rgb.g * k;
        _densityB[idx] += rgb.b * k;
        _densityW[idx] += k;
      }
    }
  }

  let maxW = 0;
  for (let i = 0; i < totalCells; i++) if (_densityW[i] > maxW) maxW = _densityW[i];
  if (maxW === 0) return;

  const px = _densityImgData.data;
  const invThreshold = 1 / (maxW * 0.3); // pre-compute division
  for (let i = 0; i < totalCells; i++) {
    const w = _densityW[i];
    if (w < 0.001) { px[i*4+3] = 0; continue; }
    const intensity = Math.min(1, w * invThreshold);
    const invW = intensity / w; // combine intensity/w into single multiply
    const off = i * 4;
    px[off]     = Math.min(255, _densityR[i] * invW + 0.5 | 0);
    px[off + 1] = Math.min(255, _densityG[i] * invW + 0.5 | 0);
    px[off + 2] = Math.min(255, _densityB[i] * invW + 0.5 | 0);
    px[off + 3] = Math.min(255, intensity * 180 + 0.5 | 0);
  }

  const octx = _densityCanvas.getContext('2d');
  octx.putImageData(_densityImgData, 0, 0);
  bz.ctx.save();
  bz.ctx.imageSmoothingEnabled = true;
  bz.ctx.imageSmoothingQuality = 'high';
  bz.ctx.drawImage(_densityCanvas, 0, 0, W, H);
  bz.ctx.restore();
}

// ─── Hit testing ─────────────────────────────────────────────────────────────

export function hitTest(bz, sx, sy) {
  const rz = bz.renderZoom;
  const wx = (sx - bz.pan.x) / rz;
  const wy = (sy - bz.pan.y) / rz;

  if (bz.currentLevel === RAW_LEVEL - 1) {
    const cellPxRaw = (Math.min(bz.W, bz.H) * rz) / 256;
    const rScreen = Math.max(8, Math.min(10, cellPxRaw * 0.42));
    const rWorld = (rScreen + 4) / rz;
    const rWorldSq = rWorld * rWorld;
    for (let i = 0; i < bz.nodes.length; i++) {
      const n = bz.nodes[i];
      const dx = n.x - wx, dy = n.y - wy;
      if (dx*dx + dy*dy < rWorldSq) return {type:'node', item:n};
    }
  } else {
    const k = 1 << ZOOM_LEVELS[bz.currentLevel];
    const cellPx = (Math.min(bz.W, bz.H) * rz) / k;
    const rScreen = Math.max(6, Math.min(22, cellPx * 0.42));
    const rWorld = (rScreen + 6) / rz;
    const rWorldSq = rWorld * rWorld;
    const sns = bz.getLevel(bz.currentLevel).supernodes;
    for (let i = 0; i < sns.length; i++) {
      const sn = sns[i];
      const dx = sn.x - wx, dy = sn.y - wy;
      if (dx*dx + dy*dy < rWorldSq) return {type:'supernode', item:sn};
    }
  }
  return null;
}
