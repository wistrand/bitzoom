// bitzoom-viewer.js — BitZoom viewer application. Composes BitZoomCanvas with UI, workers, data loading.

import {
    MINHASH_K, GRID_SIZE, GRID_BITS, ZOOM_LEVELS, RAW_LEVEL, LEVEL_LABELS,
    buildGaussianProjection, cellIdAtLevel,
} from './bitzoom-algo.js';
import { generateGroupColors } from './bitzoom-colors.js';
import { autoTuneStrengths, autoTuneBearings } from './bitzoom-utils.js';
import { initGPU, computeProjectionsGPU, setGpuBlendProfiling } from './bitzoom-gpu.js';
import { isWebGL2Available } from './bitzoom-gl-renderer.js';
import { exportSVG } from './bitzoom-svg.js';

import { BitZoomCanvas } from './bitzoom-canvas.js';
import { computeNodeSig, runPipeline, runPipelineGPU, runPipelineFromObjects, runPipelineFromObjectsGPU, parseEdgesFile, parseNodesFile, buildGraph, computeProjections } from './bitzoom-pipeline.js';
import { parseAny, detectFormat, isObjectFormat, FILE_ACCEPT_ATTR, readFileText, classifyFiles } from './bitzoom-parsers.js';

// HTML-escape user-derived strings to prevent XSS from crafted SNAP files.
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

/** Pick a sensible initial zoom level by inspecting how the already-quantized
 *  nodes actually distribute across cells at each level. The ideal initial view
 *  has a MIX of supernodes (multi-member cells) and singletons, with the total
 *  count of distinct visible items in a readable range (not too few, not too
 *  many). Walks from coarsest (L1) to finest, returning the first level that
 *  satisfies: distinct cells in [MIN, MAX] AND some multi-member cells exist.
 *  Falls through to RAW for small datasets where no aggregated level qualifies.
 *  Dataset presets can override via settings.initialLevel. */
function pickInitialLevel(nodes, zoomLevels, rawLevel) {
    if (!nodes || nodes.length === 0) return rawLevel;
    const TARGET_MIN = 25;  // ~25 visible items is the floor for "something to look at"
    const TARGET_MAX = 400; // beyond ~400, the view gets crowded / labels overlap
    const MAX_IDX = zoomLevels.length - 1; // highest aggregated level (RAW is rawLevel)

    for (let idx = 0; idx <= MAX_IDX; idx++) {
        const bits = zoomLevels[idx];
        if (bits === undefined) continue;
        const shift = 16 - bits;
        const gridK = 1 << bits;
        const counts = new Map();
        let anyMulti = false;
        for (const n of nodes) {
            if (n.gx === undefined) continue;
            const key = (n.gx >> shift) * gridK + (n.gy >> shift);
            const c = (counts.get(key) || 0) + 1;
            counts.set(key, c);
            if (c > 1) anyMulti = true;
        }
        const distinct = counts.size;
        // A good level has enough detail to be interesting (>= MIN), isn't too
        // crowded (<= MAX), and actually has some aggregation happening (multi-
        // member cells — otherwise raw is better).
        if (distinct >= TARGET_MIN && distinct <= TARGET_MAX && anyMulti) {
            return idx;
        }
        // We've gone too fine — back off to the previous level (which was under MAX).
        if (distinct > TARGET_MAX) {
            return Math.max(0, idx - 1);
        }
    }
    // No aggregated level satisfied the band — dataset is small enough to show
    // every node individually.
    return rawLevel;
}

// Dataset definitions. Optional `settings` configures initial strengths and label checkboxes.
let DATASETS = [];

class BitZoom {
    constructor() {
        const canvas = document.getElementById('canvas');

        // Sync all UI from canvas state on every state change. The canvas is the
        // single source of truth for propStrengths/propBearings — UI just reflects it.
        // statechange fires at the START of _blend(), before the expensive work,
        // so sliders/dials/compass update immediately during drag.
        canvas.addEventListener('statechange', () => {
            if (this.view && this.dataLoaded) {
                this._syncControls();
                this._syncCompass();
            }
        });

        // Sync the file input accept attribute from the parsers' capability list
        // so adding a new supported format doesn't require an HTML edit.
        const edgesFile = document.getElementById('edgesFile');
        if (edgesFile) edgesFile.accept = FILE_ACCEPT_ATTR;

        // The canvas view handles all graph state, rendering, interaction primitives
        this.view = new BitZoomCanvas(canvas, {
            heatmapMode: 'density',
            showLegend: true,
            initialLevel: 0,
            clickDelay: 250,
            keyboardTarget: window,
            onRender: () => this._scheduleHashUpdate(),
            onAnnounce: (text) => { const el = document.getElementById('aria-announce'); if (el) el.textContent = text; },
            onSummary: (rows) => {
                const tb = document.querySelector('#aria-summary tbody');
                if (!tb) return;
                const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                tb.innerHTML = rows.map(r => `<tr><td>${esc(r.label)}</td><td>${esc(r.group)}</td><td>${r.connections}</td></tr>`).join('');
            },
            onSelect: (hit) => this._showDetail(hit),
            onDeselect: () => {
                document.getElementById('node-panel').classList.remove('open');
            },
            onLevelChange: () => {
                this._updateStepperUI();
                this._deferUIUpdate();
            },
            onZoomToHit: (hit) => this.zoomToNode(hit),
            onSwitchLevel: (idx) => this.switchLevel(idx),
            onKeydown: (e) => this._handleViewerKeys(e),
        });

        // App-specific state
        this.dataLoaded = false;
        this.presets = {};
        this.activeWorker = null;
        this.pendingEdgesText = null;
        this.pendingNodesText = null;
        this.pendingParsed = null;       // {nodes, edges, extraPropNames, format} from parseAny
        this._lastParsed = null;         // for rebuild after object-pipeline loads
        this._autoTuneOnLoad = true;     // auto-tune on fresh datasets without preset settings
        this._tuneAbort = null;          // shared AbortController for auto-tune (manual + on-load)
        this._canvasDropTimer = null;    // debounce for two-file SNAP drops onto the canvas
        this._lastEdgesText = null;      // last SNAP edges text loaded (for rebuild on GPU/CPU switch)
        this._lastNodesText = null;      // last SNAP nodes text loaded
        this.rebuildTimer = null;
        this.smoothDebounceTimer = null;
        this._zoomTargetMembers = null;
        this._zoomTargetLabel = null;
        this._hashUpdateTimer = null;
        this._currentDatasetId = null;
        this._uiUpdatePending = false;
        this._abortController = new AbortController();

        this._bindEvents();
    }

    // ─── URL hash state ────────────────────────────────────────────────────────

    // ─── URL hash: compact positional format ──────────────────────────────────
    // Settings use group-order positional arrays (groupNames order is stable per
    // dataset). Format: st=5,0,8,0  b=28.6,0,0,0  lp=0,2  cb=1
    // All settings are serialized together — if any is present, all are present.
    // This eliminates partial-state bugs entirely.

    _serializeHash() {
        const v = this.view;
        const parts = [];
        if (this._currentDatasetId === '__url__' && this._currentEdgesUrl) {
            parts.push(`edges=${encodeURIComponent(this._currentEdgesUrl)}`);
            if (this._currentNodesUrl) parts.push(`nodes=${encodeURIComponent(this._currentNodesUrl)}`);
        } else if (this._currentDatasetId) {
            parts.push(`d=${encodeURIComponent(this._currentDatasetId)}`);
        }
        parts.push(`l=${v.currentLevel}`);
        parts.push(`z=${v.zoom.toFixed(3)}`);
        parts.push(`x=${v.pan.x.toFixed(0)}`);
        parts.push(`y=${v.pan.y.toFixed(0)}`);
        parts.push(`bl=${v.baseLevel}`);
        if (v.selectedId) parts.push(`s=${encodeURIComponent(v.selectedId)}`);
        // All settings as a block — positional arrays keyed by groupNames order
        if (v.groupNames && v.groupNames.length) {
            const G = v.groupNames.length;
            // Strengths: positional, 3 decimals
            const st = new Array(G);
            for (let i = 0; i < G; i++) st[i] = Math.round((v.propStrengths[v.groupNames[i]] || 0) * 1000) / 1000;
            parts.push(`st=${st.join(',')}`);
            // Bearings: positional, degrees, 2 decimals (0.01° ≈ 0.00017 rad)
            const bd = new Array(G);
            for (let i = 0; i < G; i++) bd[i] = Math.round(((v.propBearings[v.groupNames[i]] || 0) * 180 / Math.PI) * 100) / 100;
            parts.push(`b=${bd.join(',')}`);
            // Alpha: 3 decimals
            parts.push(`a=${Math.round(v.smoothAlpha * 1000) / 1000}`);
            // Color-by: group index, -1 = auto
            const cbIdx = v.colorBy ? v.groupNames.indexOf(v.colorBy) : -1;
            parts.push(`cb=${cbIdx}`);
            // Label props: comma-separated group indices
            if (v.labelProps && v.labelProps.size) {
                const lpIdx = [];
                for (const p of v.labelProps) {
                    const idx = v.groupNames.indexOf(p);
                    if (idx >= 0) lpIdx.push(idx);
                }
                parts.push(`lp=${lpIdx.join(',')}`);
            }
        }
        return parts.join('&');
    }

    _scheduleHashUpdate() {
        if (this._hashUpdateTimer || this._finalizing || !this._currentDatasetId) return;
        this._hashUpdateTimer = requestAnimationFrame(() => {
            this._hashUpdateTimer = null;
            const hash = this._serializeHash();
            if (location.hash.slice(1) !== hash) {
                history.replaceState(null, '', '#' + hash);
            }
        });
    }

    _restoreFromHash() {
        const hash = location.hash.slice(1);
        if (!hash) return null;
        const params = {};
        for (const part of hash.split('&')) {
            const eq = part.indexOf('=');
            if (eq > 0) params[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1));
        }
        return params;
    }

    /** Apply all hash state. When settings (st) are present, ALL settings are
     *  restored authoritatively and a full blend + layout + render is performed.
     *  Returns a promise so callers can await the blend. */
    _applyHashState(params) {
        if (!params || !this.dataLoaded) return;
        const v = this.view;
        // View state
        if (params.l !== undefined) v.currentLevel = parseInt(params.l) || 0;
        if (params.bl !== undefined) v.baseLevel = parseInt(params.bl) || 0;
        if (params.z !== undefined) v.zoom = parseFloat(params.z) || 1;
        if (params.x !== undefined) v.pan.x = parseFloat(params.x) || 0;
        if (params.y !== undefined) v.pan.y = parseFloat(params.y) || 0;
        if (params.s) {
            v.selectedId = params.s;
            const n = v.nodeIndexFull[params.s];
            if (n) this._showDetail({ type: 'node', item: n });
        }
        // Settings block: if `st` is present, all settings are authoritative.
        // Positional arrays must match the dataset's group count — reject stale hashes.
        const hasSettings = params.st !== undefined;
        if (hasSettings) {
            const G = v.groupNames.length;
            const stVals = params.st.split(',').map(s => parseFloat(s) || 0);
            const bVals = params.b ? params.b.split(',').map(s => parseFloat(s) || 0) : [];
            if (stVals.length !== G || (bVals.length && bVals.length !== G)) {
                console.warn(`[hash] settings length mismatch: st=${stVals.length} b=${bVals.length} groups=${G} — ignoring settings`);
                this._updateStepperUI();
                v.layoutAll();
                v.render();
                return;
            }
            // Strengths: positional array
            for (let i = 0; i < G; i++) v.propStrengths[v.groupNames[i]] = stVals[i] || 0;
            // Bearings: positional array, degrees → radians
            const obj = {};
            for (let i = 0; i < G; i++) obj[v.groupNames[i]] = (bVals[i] || 0) * Math.PI / 180;
            v.bulkSetBearings(obj);
            // Alpha
            v.smoothAlpha = params.a !== undefined ? (parseFloat(params.a) || 0) : 0;
            document.getElementById('nudgeSlider').value = v.smoothAlpha;
            document.getElementById('nudgeVal').textContent = v.smoothAlpha.toFixed(2);
            // Color-by: group index, -1 or absent = auto
            const cbIdx = params.cb !== undefined ? parseInt(params.cb) : -1;
            v.colorBy = (cbIdx >= 0 && cbIdx < G) ? v.groupNames[cbIdx] : null;
            // Label props: group indices
            v.labelProps.clear();
            if (params.lp) {
                for (const s of params.lp.split(',')) {
                    const idx = parseInt(s);
                    if (idx >= 0 && idx < G) v.labelProps.add(v.groupNames[idx]);
                }
            }
            // Full rebuild: blend + layout + render
            v._refreshPropCache();
            this._updateStepperUI();
            this._updateColorByUI();
            return v._blend().then(() => {
                v.layoutAll();
                this._updateAlgoInfo();
                this._updateOverview();
                this._syncControls();
                v.render();
            });
        }
        // No settings — just view state (pan/zoom/level)
        this._updateStepperUI();
        v.layoutAll();
        v.render();
    }

    // ─── Algorithm wrappers ────────────────────────────────────────────────────

    async rebuildProjections(fast = false) {
        const v = this.view;
        v._quantStats = {}; // refreeze Gaussian boundaries from new distribution
        v._refreshPropCache(); // also invalidates levels

        // Blend ALL nodes — valid topology even at α > 0.
        // Only use fast (adaptive passes) for large datasets where blend is expensive.
        const useFast = fast && v.nodes.length > 50000;
        await v._blend(useFast);

        if (useFast) {
            // Level build is the bottleneck (~330ms at 367K). Subsample for
            // level build + render only — the blend already ran on all nodes
            // so gx/gy are correct. Fewer nodes → fewer supernodes → fast frame.
            if (!v._sampleNodes) {
                const targetN = Math.max(20000, Math.min(50000, v.nodes.length));
                // Spatial grid sampling from current gx/gy: 16×16 grid,
                // degree-weighted within each cell, min 1 per occupied cell.
                const shift = 16 - 4;
                const cells = new Map();
                for (const n of v.nodes) {
                    const key = ((n.gx >> shift) << 4) | (n.gy >> shift);
                    if (!cells.has(key)) cells.set(key, []);
                    cells.get(key).push(n);
                }
                for (const arr of cells.values()) arr.sort((a, b) => b.degree - a.degree);
                v._sampleNodes = [];
                for (const [, arr] of cells) {
                    const take = Math.max(1, Math.round(arr.length * targetN / v.nodes.length));
                    for (let i = 0; i < Math.min(take, arr.length); i++) v._sampleNodes.push(arr[i]);
                }
            }
            // Swap nodes for level build + render only; skip edges entirely.
            // Suppress edge build scheduling during getLevel by setting a flag.
            const fullNodes = v.nodes;
            const savedEdgeMode = v.edgeMode;
            v.nodes = v._sampleNodes;
            v.edgeMode = 'none';
            v._skipEdgeBuild = true; // stays true until full rebuild on release
            v.layoutAll();
            v.render();
            // Cancel any edge build that snuck through
            if (v._edgeBuildRaf) { cancelAnimationFrame(v._edgeBuildRaf); v._edgeBuildRaf = null; }
            v.edgeMode = savedEdgeMode;
            v.nodes = fullNodes;
        } else {
            v.layoutAll();
            v.render();
            if (!fast) { v._sampleNodes = null; v._skipEdgeBuild = false; }
        }
    }

    // ─── Navigation ─────────────────────────────────────────────────────────────

    switchLevel(idx) {
        const v = this.view;
        const oldIdx = v.currentLevel;
        const oldIsRaw = oldIdx === RAW_LEVEL;
        const newIsRaw = idx === RAW_LEVEL;

        // Capture old supernode screen positions for animation
        const oldSns = !oldIsRaw ? v.getLevel(oldIdx).supernodes : null;
        const oldLevel = oldIsRaw ? null : ZOOM_LEVELS[oldIdx];
        const oldPosByBid = {};
        if (oldSns) {
            for (const sn of oldSns) oldPosByBid[sn.bid] = { x: sn.x, y: sn.y };
        }

        // Switch
        const oldRZ = v.renderZoom;
        v.currentLevel = idx;
        v.zoom = oldRZ / Math.pow(2, idx - v.baseLevel);
        this._updateStepperUI();
        v.selectedId = null;
        document.getElementById('node-panel').classList.remove('open');
        v.layoutAll();
        this._updateAlgoInfo();
        this._updateOverview();
        // Animate if few nodes on screen and not switching to/from RAW
        const newSns = !newIsRaw ? v.getLevel(idx).supernodes : null;
        const shouldAnimate = oldSns && newSns && newSns.length < 80 && oldSns.length < 80;

        if (!shouldAnimate) { v.render(); return; }

        const newLevel = ZOOM_LEVELS[idx];
        const zoomingIn = idx > oldIdx;

        // Build animation map: newBid → {startX, startY, endX, endY}
        const anims = [];
        if (zoomingIn) {
            // Each new sub-supernode animates FROM its parent supernode position
            for (const sn of newSns) {
                // Find parent bid at old level using first member's grid coords
                const m0 = sn.members[0];
                const parentBid = cellIdAtLevel(m0.gx, m0.gy, oldLevel);
                const from = oldPosByBid[parentBid];
                if (from) {
                    anims.push({ sn, sx: from.x, sy: from.y, ex: sn.x, ey: sn.y });
                }
            }
        } else {
            // Each old supernode animates TO its new parent supernode position
            // We animate the NEW supernodes from the centroid of their old children
            const newPosByBid = {};
            for (const sn of newSns) newPosByBid[sn.bid] = { x: sn.x, y: sn.y };

            for (const sn of newSns) {
                // Find old children that map to this new supernode
                let cx = 0, cy = 0, count = 0;
                for (const old of oldSns) {
                    const m0 = old.members[0];
                    const parentBid = cellIdAtLevel(m0.gx, m0.gy, newLevel);
                    if (parentBid === sn.bid) {
                        cx += oldPosByBid[old.bid].x;
                        cy += oldPosByBid[old.bid].y;
                        count++;
                    }
                }
                if (count > 0) {
                    anims.push({ sn, sx: cx / count, sy: cy / count, ex: sn.x, ey: sn.y });
                }
            }
        }

        if (anims.length === 0) { v.render(); return; }

        const duration = 300;
        const startTime = performance.now();
        const animate = (now) => {
            const t = Math.min(1, (now - startTime) / duration);
            const e = 1 - Math.pow(1 - t, 3); // ease-out cubic

            for (const a of anims) {
                a.sn.x = a.sx + (a.ex - a.sx) * e;
                a.sn.y = a.sy + (a.ey - a.sy) * e;
            }

            v.renderNow();

            if (t < 1) {
                requestAnimationFrame(animate);
            } else {
                // Restore final positions
                for (const a of anims) { a.sn.x = a.ex; a.sn.y = a.ey; }
                v.renderNow();
            }
        };
        requestAnimationFrame(animate);
    }

    _handleViewerKeys(e) {
        if (!this.dataLoaded) return true;
        if ((e.key === 'Enter' || e.key === ' ') && this.view.selectedId) {
            const item = this.view._findById(this.view.selectedId);
            if (item) {
                const type = this.view.currentLevel === RAW_LEVEL ? 'node' : 'supernode';
                this._showDetail({ type, item });
            }
            return false; // let canvas handle nav neighbor rebuild
        }
        if (e.key === 'Escape') {
            if (this._compassOpen) { this._toggleCompass(false); return true; }
            document.getElementById('node-panel').classList.remove('open');
            return false; // let canvas handle deselect
        }
        if (e.key === 'r') {
            this._toggleCompass();
            return true;
        }
        if (e.key === 'a') {
            document.body.classList.toggle('a11y-debug');
            return true;
        }
        if (e.key === 's') {
            e.preventDefault();
            const svg = exportSVG(this.view, { metadata: this._currentDatasetId || undefined, compass: this._compassOpen ? this._compassSVGOpts() : null });
            const blob = new Blob([svg], { type: 'image/svg+xml' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `bitzoom-${this._currentDatasetId || 'export'}.svg`;
            a.click();
            URL.revokeObjectURL(url);
            return true;
        }
        if (e.key === 'S') {
            e.preventDefault();
            const svg = exportSVG(this.view, { metadata: this._currentDatasetId || undefined, compass: this._compassOpen ? this._compassSVGOpts() : null });
            navigator.clipboard.writeText(svg).then(() => {
                this.view.showProgress('SVG copied to clipboard');
                setTimeout(() => { this.view._progressText = null; this.view.render(); }, 1500);
            });
            return true;
        }
        return false;
    }

    zoomToNode(hit) {
        const v = this.view;
        const isNode = hit.type === 'node';
        const item = hit.item;

        this._zoomTargetMembers = isNode ? [item] : item.members;
        this._zoomTargetLabel = isNode ? v._nodeLabel(item) : v._supernodeLabel(item);
        v.selectedId = isNode ? item.id : item.bid;

        const startPan = { x: v.pan.x, y: v.pan.y };
        const startZoom = v.zoom;
        const targetZoom = startZoom * 2;

        const wp = v.worldToScreen(item.x, item.y);
        const startRZ = v.renderZoom;
        const targetRZ = Math.max(1, targetZoom * Math.pow(2, v.currentLevel - v.baseLevel));
        const f = targetRZ / startRZ;
        const targetPan = {
            x: v.W / 2 - (v.W / 2 - startPan.x) * f - (wp.x - v.W / 2) * f,
            y: v.H / 2 - (v.H / 2 - startPan.y) * f - (wp.y - v.H / 2) * f,
        };

        const startTime = performance.now();
        const animate = (now) => {
            const t = Math.min(1, (now - startTime) / 350);
            const e = 1 - Math.pow(1 - t, 3);
            v.zoom = startZoom + (targetZoom - startZoom) * e;
            v.pan.x = startPan.x + (targetPan.x - startPan.x) * e;
            v.pan.y = startPan.y + (targetPan.y - startPan.y) * e;
            v.renderNow();
            if (t < 1) {
                requestAnimationFrame(animate);
            } else {
                const prevLevel = v.currentLevel;
                v._checkAutoLevel();
                if (v.currentLevel !== prevLevel && this._zoomTargetMembers) {
                    this._reselectAfterLevelChange();
                }
                v.renderNow();
            }
        };
        requestAnimationFrame(animate);
    }

    _reselectAfterLevelChange() {
        const v = this.view;
        if (!this._zoomTargetMembers || this._zoomTargetMembers.length === 0) return;
        const targetLabel = this._zoomTargetLabel || '';

        if (v.currentLevel === RAW_LEVEL) {
            let best = v.nodeIndexFull[this._zoomTargetMembers[0].id];
            if (targetLabel) {
                for (const m of this._zoomTargetMembers) {
                    const n = v.nodeIndexFull[m.id];
                    if (n && v._nodeLabel(n) === targetLabel) { best = n; break; }
                }
            }
            if (best) {
                v.selectedId = best.id;
                v.layoutAll();
                this._showDetail({ type: 'node', item: best });
                this._centerOnNode(best);
            }
            return;
        }

        const level = v.getLevel(v.currentLevel);
        const memberIds = new Set(this._zoomTargetMembers.map(m => m.id));

        let bestSn = null;
        let bestScore = -1;
        for (const sn of level.supernodes) {
            let overlap = 0;
            for (const m of sn.members) {
                if (memberIds.has(m.id)) overlap++;
            }
            const snLabel = v._supernodeLabel(sn);
            const labelBonus = (targetLabel && snLabel === targetLabel) ? 10000 : 0;
            const score = labelBonus + overlap;
            if (score > bestScore) {
                bestScore = score;
                bestSn = sn;
            }
        }

        if (bestSn) {
            v.selectedId = bestSn.bid;
            this._zoomTargetMembers = bestSn.members;
            this._zoomTargetLabel = v._supernodeLabel(bestSn);
            v.layoutAll();
            this._showDetail({ type: 'supernode', item: bestSn });
            this._centerOnNode(bestSn);
        }
    }

    _centerOnNode(item) {
        const v = this.view;
        const p = v.worldToScreen(item.x, item.y);
        v.pan.x += v.W / 2 - p.x;
        v.pan.y += v.H / 2 - p.y;
    }

    selectNode(id) {
        const v = this.view;
        const n = v.nodeIndexFull[id];
        if (!n) return;
        v.selectedId = id;
        this.switchLevel(RAW_LEVEL);
        const p = v.worldToScreen(n.x, n.y);
        v.pan.x += v.W / 2 - p.x;
        v.pan.y += v.H / 2 - p.y;
        this._showDetail({ type: 'node', item: n });
        v.render();
    }

    _deferUIUpdate() {
        if (this._uiUpdatePending) return;
        this._uiUpdatePending = true;
        requestAnimationFrame(() => {
            this._uiUpdatePending = false;
            this._updateAlgoInfo();
            this._updateOverview();
        });
    }

    // ─── UI updates ────────────────────────────────────────────────────────────

    _updateStepperUI() {
        const v = this.view;
        const label = LEVEL_LABELS[v.currentLevel];
        const el = document.getElementById('zoomCurrent');
        if (el.textContent !== label) el.textContent = label;
        document.getElementById('zoomPrev').disabled = v.currentLevel === 0;
        document.getElementById('zoomNext').disabled = v.currentLevel === LEVEL_LABELS.length - 1;
    }

    _updateOverview() {
        const v = this.view;
        const stats = document.getElementById('overview-stats');
        const isRaw = v.currentLevel === RAW_LEVEL;
        if (isRaw) {
            stats.innerHTML = `
        <div class="stat-row"><span class="stat-label">Nodes</span><span class="stat-value">${v.nodes.length}</span></div>
        <div class="stat-row"><span class="stat-label">Edges</span><span class="stat-value">${v.edges.length}</span></div>
        <div class="stat-row"><span class="stat-label">MinHash k</span><span class="stat-value">${MINHASH_K}</span></div>
        <div class="stat-row"><span class="stat-label">Grid</span><span class="stat-value">${GRID_SIZE}×${GRID_SIZE}</span></div>
        <div class="stat-row"><span class="stat-label">Level</span><span class="stat-value">RAW</span></div>`;
        } else {
            const lv = v.getLevel(v.currentLevel);
            const k = 1 << ZOOM_LEVELS[v.currentLevel];
            stats.innerHTML = `
        <div class="stat-row"><span class="stat-label">Nodes</span><span class="stat-value">${v.nodes.length}</span></div>
        <div class="stat-row"><span class="stat-label">Supernodes</span><span class="stat-value">${lv.supernodes.length}</span></div>
        <div class="stat-row"><span class="stat-label">Super-edges</span><span class="stat-value">${lv.snEdges.length}</span></div>
        <div class="stat-row"><span class="stat-label">Grid k</span><span class="stat-value">${k}×${k}</span></div>
        <div class="stat-row"><span class="stat-label">Cells used</span><span class="stat-value">${lv.supernodes.length} / ${k*k}</span></div>
        <div class="stat-row"><span class="stat-label">Avg bucket</span><span class="stat-value">${(v.nodes.length/lv.supernodes.length).toFixed(1)} nodes</span></div>`;
        }
    }

    _updateAlgoInfo() {
        const v = this.view;
        const isRaw = v.currentLevel === RAW_LEVEL;
        const lvNum = ZOOM_LEVELS[v.currentLevel];
        const k = isRaw ? GRID_SIZE : (1 << lvNum);
        const desc = isRaw
            ? `RAW: individual nodes. MinHash(k=128) → Gaussian projection → 2D. Grid (gx,gy) uint16.`
            : `L${lvNum}: k=${k}/axis → ${k*k} cells. Shift uint16 gx,gy right by ${GRID_BITS-lvNum} bits.`;
        document.getElementById('algo-info').textContent = desc;
    }

    _showDetail(hit) {
        const v = this.view;
        const panel = document.getElementById('node-panel');
        const detail = document.getElementById('node-detail');
        panel.classList.add('open');

        if (hit.type === 'node') {
            const n = hit.item;
            const col = v._nodeColor(n);
            const nbrCount = (v.adjList[n.id] || []).length;
            let propsHtml = `
        <div class="prop-row"><div class="prop-key">Group</div><div class="prop-val">${esc(n.group)}</div></div>
        <div class="prop-row"><div class="prop-key">Label</div><div class="prop-val">${esc(n.label)}</div></div>
        <div class="prop-row"><div class="prop-key">Degree</div><div class="prop-val">${n.degree} (${nbrCount} neighbors)</div></div>`;
            if (n.edgeTypes && n.edgeTypes.size > 0) {
                propsHtml += `<div class="prop-row"><div class="prop-key">Edge types</div><div class="prop-val">${[...n.edgeTypes].map(esc).join(', ')}</div></div>`;
            }
            if (n.extraProps) {
                for (const [key, val] of Object.entries(n.extraProps)) {
                    if (val && val !== 'unknown') {
                        propsHtml += `<div class="prop-row"><div class="prop-key">${esc(key)}</div><div class="prop-val">${esc(val)}</div></div>`;
                    }
                }
            }
            const nbrIds = v.adjList[n.id] || [];
            if (nbrIds.length > 0) {
                const nbrByGroup = {};
                for (const nid of nbrIds) {
                    const nb = v.nodeIndexFull[nid];
                    const g = nb ? nb.group : 'unknown';
                    if (!nbrByGroup[g]) nbrByGroup[g] = [];
                    nbrByGroup[g].push(nb || { id: nid, group: 'unknown', degree: 0, label: nid });
                }
                const groups = Object.entries(nbrByGroup).sort((a, b) => b[1].length - a[1].length);
                let nbrHtml = '';
                const MAX_PER_GROUP = 5;
                const MAX_GROUPS = 6;
                for (let gi = 0; gi < Math.min(groups.length, MAX_GROUPS); gi++) {
                    const [gName, members] = groups[gi];
                    members.sort((a, b) => b.degree - a.degree);
                    const gc = v.groupColors[gName] || '#888888';
                    nbrHtml += `<div style="margin-top:4px"><span class="prop-key" style="color:${gc}">${esc(gName)} (${members.length})</span></div>`;
                    for (let mi = 0; mi < Math.min(members.length, MAX_PER_GROUP); mi++) {
                        const nb = members[mi];
                        const nc = v._nodeColor(nb);
                        const label = nb.label || nb.id;
                        const shortLabel = label.length > 40 ? label.slice(0, 37) + '…' : label;
                        nbrHtml += `<div class="neighbor-item" onclick="bz.selectNode('${esc(nb.id)}')" style="cursor:pointer">
              <span>${esc(shortLabel)}</span>
              <span style="color:${nc};font-size:9px">deg:${nb.degree}</span>
            </div>`;
                    }
                    if (members.length > MAX_PER_GROUP) {
                        nbrHtml += `<div class="hint">+${members.length - MAX_PER_GROUP} more</div>`;
                    }
                }
                if (groups.length > MAX_GROUPS) {
                    nbrHtml += `<div class="hint">+${groups.length - MAX_GROUPS} more groups</div>`;
                }
                propsHtml += `<div class="prop-row"><div class="prop-key">Linked nodes (${nbrIds.length})</div><div class="neighbor-list">${nbrHtml}</div></div>`;
            }
            detail.innerHTML = `
        <div class="node-title">${esc(n.id)}</div>
        <div class="node-badge" style="background:${col}33;color:${col};border:1px solid ${col}55">${esc(n.group)}</div>
        <div style="height:10px"></div>
        ${propsHtml}
        <div class="prop-row">
          <div class="prop-key">Grid coords</div>
          <div class="bucket-id">gx=${n.gx} gy=${n.gy} · px=${n.px.toFixed(3)} py=${n.py.toFixed(3)}</div>
        </div>
        <div class="prop-row">
          <div class="prop-key">MinHash sig (32 bits)</div>
          <div class="minhash-display">
            ${Array.from(computeNodeSig(n).subarray(0,32)).map((val,i) => {
                const bit = val % 2;
                const col2 = bit ? '#7c6af7' : '#1e1e2e';
                return `<div class="mh-bit" title="h${i}=${val}" style="background:${col2}"></div>`;
            }).join('')}
          </div>
        </div>`;
        } else {
            const sn = hit.item;
            const col = sn.cachedColor;
            const lvNum = ZOOM_LEVELS[v.currentLevel];
            const groupBreakdown = {};
            for (const m of sn.members) groupBreakdown[m.group] = (groupBreakdown[m.group]||0)+1;
            const groupRows = Object.entries(groupBreakdown).sort((a,b)=>b[1]-a[1])
                .map(([g,cnt]) => `<div class="neighbor-item"><span>${esc(g)}</span><span style="color:${v.groupColors[g]||'#888888'}">${cnt}</span></div>`).join('');

            let extraHtml = '';
            if (sn.members.length > 0 && sn.members[0].extraProps) {
                const propKeys = Object.keys(sn.members[0].extraProps);
                for (const key of propKeys) {
                    const counts = {};
                    for (const m of sn.members) {
                        const val = m.extraProps?.[key] || 'unknown';
                        counts[val] = (counts[val] || 0) + 1;
                    }
                    const sorted = Object.entries(counts).sort((a,b) => b[1] - a[1]);
                    const top = sorted.slice(0, 3).map(([val, c]) => `${esc(val)} (${c})`).join(', ');
                    extraHtml += `<div class="prop-row"><div class="prop-key">${esc(key)}</div><div class="prop-val">${top}</div></div>`;
                }
            }

            const level = v.getLevel(v.currentLevel);
            const linkedSns = [];
            for (const e of level.snEdges) {
                if (e.a === sn.bid) linkedSns.push({ bid: e.b, weight: e.weight });
                else if (e.b === sn.bid) linkedSns.push({ bid: e.a, weight: e.weight });
            }
            linkedSns.sort((a, b) => b.weight - a.weight);
            const snMap = {};
            for (const s of level.supernodes) snMap[s.bid] = s;

            let linkedHtml = '';
            const MAX_LINKED = 8;
            for (let i = 0; i < Math.min(linkedSns.length, MAX_LINKED); i++) {
                const linked = snMap[linkedSns[i].bid];
                if (!linked) continue;
                const lc = linked.cachedColor;
                const lbl = linked.cachedLabel || linked.repName;
                const shortLbl = lbl.length > 35 ? lbl.slice(0, 32) + '…' : lbl;
                linkedHtml += `<div class="neighbor-item"><span>${esc(shortLbl)}</span><span style="color:${lc};font-size:9px">${linkedSns[i].weight} edges</span></div>`;
            }
            if (linkedSns.length > MAX_LINKED) {
                linkedHtml += `<div class="hint">+${linkedSns.length - MAX_LINKED} more</div>`;
            }

            const topMembers = sn.members.slice().sort((a, b) => b.degree - a.degree);
            const memberList = topMembers.slice(0, 8).map(m => {
                const ml = m.label || m.id;
                const shortMl = ml.length > 35 ? ml.slice(0, 32) + '…' : ml;
                return `<div class="neighbor-item" onclick="bz.selectNode('${esc(m.id)}')" style="cursor:pointer">
          <span>${esc(shortMl)}</span>
          <span style="color:${v.groupColors[m.group]||'#888888'};font-size:9px">deg:${m.degree}</span>
        </div>`;
            }).join('') + (sn.members.length > 8 ? `<div class="hint">+${sn.members.length-8} more…</div>` : '');

            detail.innerHTML = `
        <div class="node-title" style="font-size:12px">Cell (${sn.cx}, ${sn.cy})</div>
        <div class="node-badge" style="background:${col}33;color:${col};border:1px solid ${col}55">L${lvNum} · k=${1<<lvNum}</div>
        <div style="height:10px"></div>
        <div class="prop-row"><div class="prop-key">Members</div><div class="prop-val">${sn.members.length} nodes</div></div>
        <div class="prop-row"><div class="prop-key">Avg Degree</div><div class="prop-val">${sn.avgDegree.toFixed(1)}</div></div>
        ${extraHtml}
        <div class="prop-row">
          <div class="prop-key">Group mix</div>
          <div class="neighbor-list">${groupRows}</div>
        </div>
        ${linkedSns.length > 0 ? `<div class="prop-row">
          <div class="prop-key">Linked cells (${linkedSns.length})</div>
          <div class="neighbor-list">${linkedHtml}</div>
        </div>` : ''}
        <div class="prop-row">
          <div class="prop-key">Top members</div>
          <div class="neighbor-list">${memberList}</div>
        </div>`;
        }
    }

    async _applyDatasetSettings(settings) {
        const v = this.view;
        const strengthSettings = settings.strengths || settings.weights;
        if (strengthSettings) {
            // Zero all strengths first, then apply specified values
            for (const g of v.groupNames) v.propStrengths[g] = 0;
            for (const [prop, val] of Object.entries(strengthSettings)) {
                if (prop in v.propStrengths) v.propStrengths[prop] = val;
            }
        }
        // Bearings: `settings.bearings = {groupName: degrees}`. Stored in degrees
        // for human readability in datasets.json; converted to radians for the
        // canvas `propBearings` field. Absent groups default to 0 (no rotation).
        v.propBearings = {};
        if (settings.bearings) {
            const obj = {};
            for (const [prop, deg] of Object.entries(settings.bearings)) {
                if (v.groupNames.includes(prop)) {
                    obj[prop] = (parseFloat(deg) || 0) * Math.PI / 180;
                }
            }
            v.bulkSetBearings(obj);
        }
        v.labelProps.clear();
        if (settings.labelProps) {
            for (const prop of settings.labelProps) {
                if (v.groupNames.includes(prop)) v.labelProps.add(prop);
            }
        }
        if (settings.quantMode) {
            v.quantMode = settings.quantMode;
            this._updateQuantBtn();
        }
        if (settings.smoothAlpha != null) {
            v.smoothAlpha = settings.smoothAlpha;
            document.getElementById('nudgeSlider').value = v.smoothAlpha;
            document.getElementById('nudgeVal').textContent = v.smoothAlpha.toFixed(2);
        }
        // label checkboxes synced via statechange → _syncControls
        v._quantStats = {}; // re-snapshot boundaries from dataset-tuned strengths
        v._refreshPropCache();
        await this.rebuildProjections();
        if (settings.initialLevel != null) {
            v.currentLevel = settings.initialLevel;
            v.baseLevel = settings.initialLevel;
            v._initLevel = settings.initialLevel;
        }
    }


    _buildDynamicUI() {
        const v = this.view;
        const presetRow = document.getElementById('presetRow');
        presetRow.innerHTML = '';
        for (const name of Object.keys(this.presets)) {
            const btn = document.createElement('button');
            btn.className = 'preset-btn' + (name === 'balanced' ? ' active' : '');
            btn.dataset.preset = name;
            btn.textContent = name.charAt(0).toUpperCase() + name.slice(1);
            btn.addEventListener('click', () => this._applyPreset(name));
            presetRow.appendChild(btn);
        }

        // Populate <bz-controls> from canvas state
        const controls = document.getElementById('strengthControls');
        if (controls) {
            const groups = v.groupNames.map(g => {
                const cmap = v.propColors && v.propColors[g];
                const color = cmap ? Object.values(cmap)[0] || '#888' : '#888';
                return { name: g, color, strength: v.propStrengths[g] || 0, bearing: v.propBearings[g] || 0 };
            });
            controls.groups = groups;
            controls.labelProps = v.labelProps;
            controls.colorBy = v.colorBy;
        }
    }

    _updateColorByUI() {
        const controls = document.getElementById('strengthControls');
        if (controls) controls.colorBy = this.view.colorBy;
    }

    _scheduleRebuild() {
        if (this.rebuildTimer) return;
        this.rebuildTimer = requestAnimationFrame(async () => { this.rebuildTimer = null; await this.rebuildProjections(true); this._updateColorByUI(); });
    }

    _syncControls() {
        const v = this.view;
        const controls = document.getElementById('strengthControls');
        if (!controls || !v.groupNames) return;
        const groups = v.groupNames.map(g => ({
            name: g, strength: v.propStrengths[g] || 0, bearing: v.propBearings[g] || 0,
        }));
        const namesMatch = controls.groups.length === groups.length &&
            controls.groups.every((g, i) => g.name === groups[i].name);
        if (namesMatch) {
            controls.updateAll(groups);
        } else {
            controls.groups = groups;
        }
        controls.labelProps = v.labelProps;
        controls.colorBy = v.colorBy;
    }

    _compassSVGOpts() {
        const widget = document.getElementById('compassWidget');
        const panel = document.getElementById('compassPanel');
        const canvas = document.getElementById('canvas');
        if (!widget || !panel || !canvas) return null;
        const cr = canvas.getBoundingClientRect();
        const pr = panel.getBoundingClientRect();
        // Compass content area (below titlebar)
        const titlebarH = 30;
        return {
            widget,
            x: pr.left - cr.left,
            y: pr.top - cr.top + titlebarH,
            w: pr.width,
            h: pr.height - titlebarH,
        };
    }

    _syncCompass() {
        const v = this.view;
        const widget = document.getElementById('compassWidget');
        if (!widget || !v.groupNames) return;
        const colorProp = v.colorBy || v.groupNames.find(g => (v.propStrengths[g] || 0) > 0) || v.groupNames[0];
        const colors = v.propColors || {};
        const groups = v.groupNames.filter(g => g !== 'label' && g !== 'structure' && g !== 'neighbors').map(g => {
            // Pick a representative color for this group
            const cmap = colors[g];
            const color = cmap ? Object.values(cmap)[0] || '#888' : '#888';
            return {
                name: g,
                color,
                strength: v.propStrengths[g] || 0,
                bearing: v.propBearings[g] || 0,
            };
        });
        // Full rebuild if group count or names changed (different dataset)
        const namesMatch = widget.groups.length === groups.length &&
            widget.groups.every((g, i) => g.name === groups[i].name);
        if (namesMatch) {
            widget.updateAll(groups);
        } else {
            widget.groups = groups;
        }
    }


    _applyPreset(name) {
        const v = this.view;
        const p = this.presets[name];
        if (!p) return;
        Object.assign(v.propStrengths, p);
        document.querySelectorAll('.preset-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.preset === name);
        });
        this._scheduleRebuild();
    }

    // ─── Data loading ──────────────────────────────────────────────────────────

    loadGraph(edgesText, nodesText) {
        this._lastEdgesText = edgesText;
        this._lastNodesText = nodesText;
        console.log('[CPU] Loading graph via worker pipeline...');
        return new Promise((resolve, reject) => {
            if (this.activeWorker) { this.activeWorker.terminate(); this.activeWorker = null; }
            const status = document.getElementById('loadStatus');
            const progressBar = document.getElementById('loadProgress');
            status.classList.remove('error');

            const worker = new Worker('bitzoom-worker.js', { type: 'module' });
            this.activeWorker = worker;

            worker.onmessage = (e) => {
                const msg = e.data;
                if (msg.type === 'progress') {
                    status.textContent = msg.message;
                    if (progressBar) progressBar.value = msg.pct;
                    return;
                }
                if (msg.type === 'error') {
                    status.textContent = 'Error: ' + msg.message;
                    status.classList.add('error');
                    if (progressBar) progressBar.value = 0;
                    worker.terminate();
                    this.activeWorker = null;
                    document.getElementById('datasetSelect').disabled = false; document.getElementById('datasetLoadBtn').disabled = false;
                    reject(new Error(msg.message));
                    return;
                }
                if (msg.type === 'done') {
                    worker.terminate();
                    this.activeWorker = null;
                    try {
                        this._applyWorkerResult(msg.result);
                        if (progressBar) progressBar.value = 100;
                        resolve();
                    } catch (err) {
                        status.textContent = '';
                        document.getElementById('datasetSelect').disabled = false; document.getElementById('datasetLoadBtn').disabled = false;
                        this._showError('Pipeline Error', err.message);
                        reject(err);
                    }
                }
            };

            worker.onerror = (err) => {
                status.textContent = '';
                if (progressBar) progressBar.value = 0;
                worker.terminate();
                this.activeWorker = null;
                document.getElementById('datasetSelect').disabled = false; document.getElementById('datasetLoadBtn').disabled = false;
                this._showError('Worker Error', err.message || 'Unknown worker error');
                reject(err);
            };

            status.textContent = 'Starting worker...';
            if (progressBar) progressBar.value = 0;
            worker.postMessage({ edgesText, nodesText });
        });
    }

    /** Load graph on main thread with GPU blend. Uses GPU projections when quantMode
     *  is gaussian (default), CPU projections when rank (float32 precision causes rank
     *  sort instability). Yields between pipeline stages for browser responsiveness. */
    async loadGraphGPU(edgesText, nodesText, dataset) {
        this._lastEdgesText = edgesText;
        this._lastNodesText = nodesText;
        const status = document.getElementById('loadStatus');
        const progressBar = document.getElementById('loadProgress');
        status.classList.remove('error');

        const t0 = performance.now();
        const yield_ = () => new Promise(r => requestAnimationFrame(r));

        status.textContent = 'Parsing edges...';
        if (progressBar) progressBar.value = 10;
        await yield_();
        const parsed = parseEdgesFile(edgesText);

        let nodesResult = null;
        if (nodesText) {
            status.textContent = 'Parsing nodes...';
            if (progressBar) progressBar.value = 25;
            await yield_();
            nodesResult = parseNodesFile(nodesText);
        }

        status.textContent = 'Building graph...';
        if (progressBar) progressBar.value = 40;
        await yield_();
        const nodesMap = nodesResult ? nodesResult.nodes : null;
        const extraPropNames = nodesResult ? nodesResult.extraPropNames : [];
        const graph = buildGraph(parsed, nodesMap, extraPropNames);

        // Adaptive GPU/CPU projection: GPU when N×G > 2000 and gaussian quant
        const N = graph.nodeArray.length;
        const G = graph.groupNames.length;
        const qm = dataset?.settings?.quantMode || 'gaussian';
        const useGPUProj = qm !== 'rank' && N * G > 2000;

        if (useGPUProj) {
            status.textContent = 'Computing projections (GPU)...';
        } else {
            status.textContent = 'Computing projections...';
        }
        if (progressBar) progressBar.value = 60;
        await yield_();
        console.log(`[GPU] Pipeline: N=${N}, G=${G}, proj=${useGPUProj ? 'GPU' : 'CPU'}, blend=${N > 50000 ? 'GPU' : 'CPU'}`);

        let projBuf;
        if (useGPUProj) {
            projBuf = (await computeProjectionsGPU(
                graph.nodeArray, graph.adjGroups, graph.groupNames, graph.hasEdgeTypes, extraPropNames, graph.numericBins
            )).projBuf;
        } else {
            projBuf = computeProjections(
                graph.nodeArray, graph.adjGroups, graph.groupNames, graph.hasEdgeTypes, extraPropNames, graph.numericBins
            ).projBuf;
        }

        status.textContent = 'Applying...';
        if (progressBar) progressBar.value = 85;
        await yield_();

        console.log(`[GPU] Pipeline done: ${graph.nodeArray.length} nodes, ${graph.edges.length} edges in ${Math.round(performance.now() - t0)}ms`);

        this._applyWorkerResult({
            nodeMeta: graph.nodeArray,
            projBuf,
            edges: graph.edges,
            groupNames: graph.groupNames,
            hasEdgeTypes: graph.hasEdgeTypes,
        });
        if (progressBar) progressBar.value = 100;
    }

    /** Load graph from already-parsed objects (CSV / D3 JSON / JGF / etc.).
     *  Uses runPipelineFromObjects instead of text-based worker. No re-parse.
     *  Stores `_lastParsed` so rebuild paths work. */
    async loadFromParsed(parsed) {
        const v = this.view;
        const status = document.getElementById('loadStatus');
        const progressBar = document.getElementById('loadProgress');
        status.classList.remove('error');
        const t0 = performance.now();
        const yield_ = () => new Promise(r => requestAnimationFrame(r));

        this._lastParsed = parsed;
        this._lastEdgesText = null;
        this._lastNodesText = null;

        status.textContent = 'Building graph...';
        if (progressBar) progressBar.value = 30;
        await yield_();

        const useGPUPath = this._gpuMode === 'gpu' || (this._gpuMode === 'auto' && !this._gpuUnavailable);
        let graph;
        try {
            if (useGPUPath) {
                status.textContent = 'Computing projections (GPU)...';
                if (progressBar) progressBar.value = 60;
                await yield_();
                graph = await runPipelineFromObjectsGPU(parsed.nodes, parsed.edges, parsed.extraPropNames, computeProjectionsGPU);
            } else {
                status.textContent = 'Computing projections...';
                if (progressBar) progressBar.value = 60;
                await yield_();
                graph = runPipelineFromObjects(parsed.nodes, parsed.edges, parsed.extraPropNames);
            }
        } catch (err) {
            status.textContent = '';
            this._showError('Pipeline Error', err.message);
            throw err;
        }

        console.log(`[${useGPUPath ? 'GPU' : 'CPU'}] Object pipeline (${parsed.format}): ${graph.nodeArray.length} nodes, ${graph.edges.length} edges in ${Math.round(performance.now() - t0)}ms`);

        status.textContent = 'Applying...';
        if (progressBar) progressBar.value = 85;
        await yield_();

        this._applyWorkerResult({
            nodeMeta: graph.nodeArray,
            projBuf: graph.projBuf,
            edges: graph.edges,
            groupNames: graph.groupNames,
            hasEdgeTypes: graph.hasEdgeTypes,
        });
        if (progressBar) progressBar.value = 100;
    }

    _applyWorkerResult(result) {
        const v = this.view;
        const { nodeMeta, projBuf, edges: workerEdges, groupNames, hasEdgeTypes: het } = result;

        v.groupNames = groupNames;
        v.hasEdgeTypes = het;

        // Build color maps for every property group
        v.propColors = {};
        const propValues = {};
        for (const g of groupNames) propValues[g] = new Set();
        for (const meta of nodeMeta) {
            propValues['group'].add(meta.group || 'unknown');
            propValues['label'].add(meta.label || meta.id);
            propValues['structure'].add(`deg:${meta.degree}`);
            propValues['neighbors'].add('_');
            if (meta.extraProps) {
                for (const [k, val] of Object.entries(meta.extraProps)) {
                    if (propValues[k]) propValues[k].add(val || 'unknown');
                }
            }
            if (meta.edgeTypes) {
                const types = Array.isArray(meta.edgeTypes) ? meta.edgeTypes : [];
                for (const t of types) propValues['edgetype']?.add(t);
            }
        }
        for (const g of groupNames) {
            v.propColors[g] = generateGroupColors([...propValues[g]].sort());
        }
        v.groupColors = v.propColors['group'];

        v.groupProjections = {};
        for (let i = 0; i < v.groupNames.length; i++) {
            v.groupProjections[v.groupNames[i]] = buildGaussianProjection(2001 + i, MINHASH_K);
        }

        const G = groupNames.length;
        v.nodes = nodeMeta.map((meta, i) => {
            const projections = {};
            for (let g = 0; g < G; g++) {
                const off = (i * G + g) * 2;
                projections[groupNames[g]] = [projBuf[off], projBuf[off + 1]];
            }
            return { ...meta, projections, px: 0, py: 0, gx: 0, gy: 0, x: 0, y: 0 };
        });

        v.nodeIndexFull = Object.fromEntries(v.nodes.map(n => [n.id, n]));
        v.edges = workerEdges;
        let md = 1;
        for (let i = 0; i < v.nodes.length; i++) { if (v.nodes[i].degree > md) md = v.nodes[i].degree; }
        v.maxDegree = md;

        v.adjList = Object.fromEntries(v.nodes.map(n => [n.id, []]));
        for (const e of v.edges) {
            if (v.adjList[e.src] && v.adjList[e.dst]) {
                v.adjList[e.src].push(e.dst);
                v.adjList[e.dst].push(e.src);
            }
        }

        v.propStrengths = {};
        v.propBearings = {}; // reset rotation state on fresh dataset load
        this.presets = { balanced: {} };
        for (const g of v.groupNames) {
            v.propStrengths[g] = (g === 'group') ? 3 : (g === 'label') ? 1 : 0;
            this.presets.balanced[g] = v.propStrengths[g];
        }
        for (const g of v.groupNames) {
            const preset = {};
            for (const g2 of v.groupNames) preset[g2] = (g2 === g) ? 8 : 0;
            this.presets[g] = preset;
        }

        this._buildDynamicUI();

        // Reset all view settings to defaults for new data
        v.smoothAlpha = 0;
        v.edgeMode = 'curves';
        v.heatmapMode = 'density';
        v.sizeBy = 'edges';
        v.sizeLog = false;
        v.quantMode = 'gaussian';
        v.labelProps.clear();
        v._quantStats = {};
        v._densityId = null; // force heatmap maxW recalculation
        v._refreshPropCache();
        document.getElementById('nudgeSlider').value = 0;
        document.getElementById('nudgeVal').textContent = '0';
        this._updateSizeButtons();
        this._updateLogBtn();
        this._updateQuantBtn();
        this._updateEdgeBtn();
        this._updateHeatBtn();
        // Blend is deferred to _finalizeLoad which calls v._blend() (GPU or CPU)

        this.dataLoaded = true;
        // Dataset-specific state — always reset on fresh load so nothing leaks
        // from the previous dataset. User-preference state (theme, color scheme,
        // WebGL toggle, GPU mode, showFps, showLegend) is preserved.
        v.selectedId = null;
        v.selectedIds.clear();
        v.hoveredId = null;
        v.zoomTargetId = null;
        v.pan = { x: 0, y: 0 };
        v.zoom = 1;
        v.colorBy = null; // previous colorBy may name a property group that doesn't exist here
        v.levels = new Array(ZOOM_LEVELS.length).fill(null); // invalidate any cached level
        v._navNeighbors = null;
        v._navAnchorId = null;
        v._navIndex = -1;
        v._lastMouseX = -1;
        v._lastMouseY = -1;

        // Dataset-identity state: cleared here so drop/panel loads don't leak
        // the previous dataset's id into the URL hash. loadDataset re-sets these
        // to the new dataset's values after this call returns.
        this._currentDatasetId = null;
        this._currentEdgesUrl = null;
        this._currentNodesUrl = null;

        document.getElementById('node-panel').classList.remove('open');
        // Keep loader screen visible and sidebar hidden until _finalizeLoad
        // completes blend + render. Prevents flash of sidebar-without-canvas
        // and unblended nodes at (0,0).
        document.getElementById('sidebar').style.display = 'none';
        history.replaceState(null, '', location.pathname);

        // Initial level is picked in _finalizeLoad AFTER blending/quantization
        // populates node.gx/gy (required for cell-distribution analysis). Start
        // at a safe default here; _finalizeLoad will overwrite.
        v.currentLevel = 3;
        v.baseLevel = 3;
        v._initLevel = 3;
        this._pendingSettings = null;
    }

    /** Apply settings + initial render in a single rAF after loadGraph */
    _finalizeLoad(dataset) {
        const v = this.view;
        this._finalizing = true;
        requestAnimationFrame(async () => {
            // _applyDatasetSettings calls rebuildProjections which blends.
            // If no settings, we need an explicit blend (especially for GPU mode
            // where _applyWorkerResult skips the blend).
            if (dataset?.settings) {
                await this._applyDatasetSettings(dataset.settings);
            } else {
                await v._blend();
            }
            // Pick a data-aware initial level now that gx/gy are populated by
            // the blend + quantization. Skip when the dataset preset explicitly
            // sets initialLevel (user knows best) or when the URL hash carries
            // a level to restore.
            const hasPresetLevel = dataset?.settings?.initialLevel != null;
            const hasHashLevel = this._initialHashParams?.l != null;
            if (!hasPresetLevel && !hasHashLevel) {
                const lvl = pickInitialLevel(v.nodes, ZOOM_LEVELS, RAW_LEVEL);
                v.currentLevel = lvl;
                v.baseLevel = lvl;
                v._initLevel = lvl;
            }
            v.resize();
            v.zoomForLevel(v.currentLevel);
            // Restore hash state: use saved initial params on first load, live hash after
            const params = this._initialHashParams || this._restoreFromHash();
            this._initialHashParams = null; // consumed
            // Does the hash match the loaded dataset? Curated: d=id. URL: edges=url.
            const hashMatchesDataset = params && (
                (params.d && params.d === dataset?.id) ||
                (params.edges && params.edges === this._currentEdgesUrl)
            );
            // Skip auto-tune if the hash carries settings (st= implies all
            // settings are present) — user has a specific view to reproduce.
            const hasHashSettings = hashMatchesDataset && params.st !== undefined;
            if (hashMatchesDataset) {
                await this._applyHashState(params);
                v.render();
            }
            // Reveal everything together after blend + layout are done.
            // The loader screen covered the canvas area; now swap in one
            // repaint: hide loader, show canvas + sidebar + load button.
            document.getElementById('loader-screen').classList.add('hidden');
            document.getElementById('sidebar').style.display = '';
            const canvasEl = document.getElementById('canvas');
            canvasEl.style.display = 'block';
            if (canvasEl.parentElement && canvasEl.parentElement !== document.body) {
                canvasEl.parentElement.style.display = ''; // show GL wrapper
            }
            document.getElementById('loadNewBtn').style.display = '';
            v.resize();
            v.render();
            this._finalizing = false;
            this._updateStepperUI();
            this._updateOverview();
            this._updateAlgoInfo();
            this._updateColorByUI();
            this._scheduleHashUpdate();

            // Auto-tune on fresh loads: no preset settings, no URL-hash strengths.
            // Gives the first frame meaningful defaults instead of a flat blend.
            if (this._autoTuneOnLoad !== false && !dataset?.settings && !hasHashSettings && v.nodes && v.nodes.length > 0) {
                await this._autoTuneFresh();
            }
        });
    }

    /** Run autoTuneStrengths on the freshly loaded dataset. Best-effort: logs
     *  errors but never throws. Skipped by _finalizeLoad when the dataset has
     *  preset settings or the URL hash carries explicit strengths. */
    async _autoTuneFresh() {
        const v = this.view;
        try {
            const autoBtn = document.getElementById('autoTuneBtn');
            this._tuneAbort = new AbortController();
            if (autoBtn) { autoBtn.style.background = 'var(--accent)'; autoBtn.style.color = '#fff'; autoBtn.textContent = 'Stop'; }
            const t0 = performance.now();
            // Subsample for large datasets: tune on a representative subset.
            // Strength ratios transfer — the tuner finds relative importance,
            // not absolute positions. 50K nodes is enough signal.
            const TUNE_MAX = 50000;
            let tuneNodes = v.nodes, tuneAdj = v.adjList, tuneIndex = v.nodeIndexFull;
            if (v.nodes.length > TUNE_MAX) {
                const step = v.nodes.length / TUNE_MAX;
                tuneNodes = [];
                for (let i = 0; i < v.nodes.length; i += step) tuneNodes.push(v.nodes[Math.floor(i)]);
                const idSet = new Set(tuneNodes.map(n => n.id));
                tuneAdj = {};
                tuneIndex = {};
                for (const n of tuneNodes) {
                    tuneIndex[n.id] = n;
                    tuneAdj[n.id] = (v.adjList[n.id] || []).filter(nid => idSet.has(nid));
                }
                console.log(`[auto-tune] subsampled ${v.nodes.length} → ${tuneNodes.length} nodes`);
            }
            const result = await autoTuneStrengths(tuneNodes, v.groupNames, tuneAdj, tuneIndex, {
                strengths: true, alpha: true, quant: false,
                signal: this._tuneAbort.signal,
                onProgress: (info) => {
                    const pct = Math.round(100 * info.step / Math.max(1, info.total));
                    v.showProgress(`Auto-tuning: ${pct}% — click Stop to apply`);
                },
            });
            // Apply via the shared helper so button state + UI sync + rebuild are identical
            await this._applyTuneResult(result);
            console.log(`[auto-tune] fresh load: ${result.blends} blends in ${Math.round(performance.now() - t0)}ms, score=${result.score.toFixed(3)}`);
        } catch (err) {
            console.warn('[auto-tune] failed:', err.message);
            v._progressText = null;
            this._tuneAbort = null;
            const autoBtn = document.getElementById('autoTuneBtn');
            if (autoBtn) { autoBtn.textContent = 'Auto'; autoBtn.style.background = ''; autoBtn.style.color = ''; }
            v.render();
        }
    }

    /** Apply GPU projection to already-loaded data. No re-parse, no re-load. */
    async _applyGPUToCurrentData() {
        if (!this._lastEdgesText && !this._lastParsed) return;
        const v = this.view;
        const N = v.nodes.length;
        const G = v.groupNames.length;
        const useGPUProj = v.quantMode !== 'rank' && N * G > 2000;
        console.log(`[GPU] Re-projecting current data, proj=${useGPUProj ? 'GPU' : 'CPU'}`);
        v.showProgress('Re-projecting...');
        const t0 = performance.now();
        try {
            const projFn = useGPUProj ? computeProjectionsGPU : computeProjections;
            const result = this._lastParsed
                ? await runPipelineFromObjectsGPU(this._lastParsed.nodes, this._lastParsed.edges, this._lastParsed.extraPropNames, projFn)
                : await runPipelineGPU(this._lastEdgesText, this._lastNodesText, projFn);
            const G = result.groupNames.length;
            for (let i = 0; i < v.nodes.length; i++) {
                for (let g = 0; g < G; g++) {
                    const off = (i * G + g) * 2;
                    const p = v.nodes[i].projections[result.groupNames[g]];
                    if (p) { p[0] = result.projBuf[off]; p[1] = result.projBuf[off + 1]; }
                }
            }
            v._quantStats = {};
            v.levels = new Array(ZOOM_LEVELS.length).fill(null);
            v._progressText = null;
            await this.rebuildProjections();
            this._updateOverview();
            console.log(`GPU pipeline: ${Math.round(performance.now() - t0)}ms`);
        } catch (err) {
            v._progressText = null;
            v.render();
            this._showError('GPU Pipeline Error', err.message);
        }
    }

    /** Re-pipeline current data with CPU projections, preserving user settings.
     *  Mirrors _applyGPUToCurrentData but uses CPU projection path. */
    async _reloadCPU() {
        if (!this._lastEdgesText && !this._lastParsed) return;
        const v = this.view;
        console.log('[CPU] Re-projecting current data, proj=CPU');
        v.showProgress('Re-projecting (CPU)...');
        try {
            const result = this._lastParsed
                ? runPipelineFromObjects(this._lastParsed.nodes, this._lastParsed.edges, this._lastParsed.extraPropNames)
                : runPipeline(this._lastEdgesText, this._lastNodesText);
            const G = result.groupNames.length;
            for (let i = 0; i < v.nodes.length; i++) {
                for (let g = 0; g < G; g++) {
                    const off = (i * G + g) * 2;
                    const p = v.nodes[i].projections[result.groupNames[g]];
                    if (p) { p[0] = result.projBuf[off]; p[1] = result.projBuf[off + 1]; }
                }
            }
            v._quantStats = {};
            v._progressText = null;
            await this.rebuildProjections();
            this._updateOverview();
        } catch (err) {
            v._progressText = null;
            v.render();
            this._showError('CPU Pipeline Error', err.message);
        }
    }

    async loadDataset(dataset) {
        const status = document.getElementById('loadStatus');
        const progressBar = document.getElementById('loadProgress');
        status.textContent = `Fetching ${dataset.name}...`;
        status.classList.remove('error');
        progressBar.style.display = 'block';
        progressBar.value = 0;
        document.getElementById('datasetSelect').disabled = true; document.getElementById('datasetLoadBtn').disabled = true;

        try {
            let edgesText, nodesText = null;
            let parsedFromUrl = null;
            // Support legacy dataset.stix alias (STIX URL field) + new dataset.edges URL.
            // Both paths funnel through format detection after fetch.
            const primaryUrl = dataset.stix || dataset.edges;
            status.textContent = `Fetching ${dataset.name}...`;
            const firstText = await this._fetchText(primaryUrl);
            const fmt = detectFormat(firstText, primaryUrl);
            if (isObjectFormat(fmt)) {
                try {
                    parsedFromUrl = parseAny(firstText, primaryUrl);
                } catch (err) {
                    throw new Error(`Parse error: ${err.message}`);
                }
            } else {
                // SNAP text pipeline path (edges + optional nodes)
                edgesText = firstText;
                if (dataset.nodes) {
                    nodesText = await this._fetchText(dataset.nodes).catch(() => null);
                }
            }
            const useGPUPath = this._gpuMode === 'gpu' || (this._gpuMode === 'auto' && !this._gpuUnavailable);
            console.log(`[Load] Dataset: ${dataset.name}, gpuMode: ${this._gpuMode}, gpuPath: ${useGPUPath}`);
            if (parsedFromUrl) {
                await this.loadFromParsed(parsedFromUrl);
            } else if (useGPUPath) {
                await this.loadGraphGPU(edgesText, nodesText, dataset);
            } else {
                await this.loadGraph(edgesText, nodesText);
            }
            this._currentDatasetId = dataset.id;
            if (dataset.id === '__url__') {
                this._currentEdgesUrl = dataset.edges;
                this._currentNodesUrl = dataset.nodes;
            } else {
                this._currentEdgesUrl = null;
                this._currentNodesUrl = null;
            }
            const nameEl = document.getElementById('datasetName');
            if (nameEl) nameEl.textContent = dataset.name;
            this._finalizeLoad(dataset);
        } catch (err) {
            status.textContent = '';
            progressBar.style.display = 'none';
            document.getElementById('datasetSelect').disabled = false; document.getElementById('datasetLoadBtn').disabled = false;
            this._showError('Dataset Load Error', err.message);
        }
    }

    _showError(title, message) {
        const dlg = document.getElementById('errorDialog');
        if (dlg) {
            document.getElementById('errorDialogTitle').textContent = title;
            document.getElementById('errorDialogMsg').textContent = message;
            dlg.showModal();
        }
        console.error(`[${title}]`, message);
    }

    showLoaderScreen() {
        if (this.activeWorker) { this.activeWorker.terminate(); this.activeWorker = null; }
        const hadData = this.view && this.view.nodes && this.view.nodes.length > 0;
        this.dataLoaded = false;
        this.pendingEdgesText = null;
        this.pendingNodesText = null;
        this.pendingParsed = null;
        document.getElementById('edgesFile').value = '';
        document.getElementById('nodesFile').value = '';
        document.getElementById('edgesUrl').value = '';
        this._pendingUrlEdges = null;
        document.getElementById('loadBtn').disabled = true;
        document.getElementById('loadStatus').textContent = '';
        document.getElementById('loadStatus').classList.remove('error');
        document.getElementById('loadProgress').style.display = 'none';
        document.getElementById('loadProgress').value = 0;
        const canvasEl = document.getElementById('canvas');
        canvasEl.style.display = 'none';
        if (canvasEl.parentElement && canvasEl.parentElement !== document.body) {
            canvasEl.parentElement.style.display = 'none'; // hide GL wrapper
        }
        document.getElementById('loader-screen').classList.remove('hidden');
        document.getElementById('loadNewBtn').style.display = 'none';
        document.getElementById('cancelLoadBtn').style.display = hadData ? '' : 'none';
        document.getElementById('sidebar').style.display = 'none';
        if (this._compassOpen) this._toggleCompass(false);
        document.getElementById('datasetSelect').disabled = false; document.getElementById('datasetLoadBtn').disabled = false;
    }

    // ─── Event binding ─────────────────────────────────────────────────────────

    _bindEvents() {
        const v = this.view;
        const canvas = v.canvas;
        const sig = { signal: this._abortController.signal };

        // Size-by toggle
        const sizeMemBtn = document.getElementById('sizeByMembers');
        const sizeEdgBtn = document.getElementById('sizeByEdges');
        const updateSizeButtons = () => {
            sizeMemBtn.style.background = v.sizeBy === 'members' ? 'var(--accent)' : '';
            sizeMemBtn.style.color = v.sizeBy === 'members' ? '#fff' : '';
            sizeEdgBtn.style.background = v.sizeBy === 'edges' ? 'var(--accent)' : '';
            sizeEdgBtn.style.color = v.sizeBy === 'edges' ? '#fff' : '';
        };
        this._updateSizeButtons = updateSizeButtons;
        updateSizeButtons();
        sizeMemBtn.addEventListener('click', () => { v.sizeBy = 'members'; updateSizeButtons(); v.render(); }, sig);
        sizeEdgBtn.addEventListener('click', () => { v.sizeBy = 'edges'; updateSizeButtons(); v.render(); }, sig);

        const sizeLogBtn = document.getElementById('sizeLogBtn');
        const updateLogBtn = () => {
            sizeLogBtn.style.background = v.sizeLog ? 'var(--accent)' : '';
            sizeLogBtn.style.color = v.sizeLog ? '#fff' : '';
        };
        this._updateLogBtn = updateLogBtn;
        updateLogBtn();
        sizeLogBtn.addEventListener('click', () => {
            v.sizeLog = !v.sizeLog;
            updateLogBtn();
            v.render();
        }, sig);

        // Quantization mode toggle
        const quantBtn = document.getElementById('quantModeBtn');
        const QUANT_MODES = ['rank', 'gaussian'];
        const QUANT_LABELS = { rank: 'Q:R', gaussian: 'Q:G' };
        const updateQuantBtn = () => {
            quantBtn.textContent = QUANT_LABELS[v.quantMode];
            quantBtn.style.background = v.quantMode !== 'rank' ? 'var(--accent)' : '';
            quantBtn.style.color = v.quantMode !== 'rank' ? '#fff' : '';
        };
        this._updateQuantBtn = updateQuantBtn;
        updateQuantBtn();
        quantBtn.addEventListener('click', () => {
            const idx = QUANT_MODES.indexOf(v.quantMode);
            v.quantMode = QUANT_MODES[(idx + 1) % QUANT_MODES.length];
            v._quantStats = {}; // mode change → fresh boundaries
            updateQuantBtn();
            this.rebuildProjections();
        }, sig);

        // Edge mode toggle
        const edgeBtn = document.getElementById('edgeModeBtn');
        const EDGE_MODES = ['curves', 'lines', 'none'];
        const EDGE_LABELS = { curves: 'E:C', lines: 'E:L', none: 'E:—' };
        const updateEdgeBtn = () => {
            edgeBtn.textContent = EDGE_LABELS[v.edgeMode];
            edgeBtn.style.background = v.edgeMode !== 'none' ? '' : 'var(--accent)';
            edgeBtn.style.color = v.edgeMode !== 'none' ? '' : '#fff';
        };
        this._updateEdgeBtn = updateEdgeBtn;
        updateEdgeBtn();
        edgeBtn.addEventListener('click', () => {
            const idx = EDGE_MODES.indexOf(v.edgeMode);
            v.edgeMode = EDGE_MODES[(idx + 1) % EDGE_MODES.length];
            updateEdgeBtn();
            v.render();
        }, sig);

        // Heatmap toggle
        const heatBtn = document.getElementById('heatmapBtn');
        const HEAT_MODES = ['off', 'splat', 'density'];
        const HEAT_LABELS = { off: 'H:-', splat: 'H:S', density: 'H:D' };
        const updateHeatBtn = () => {
            heatBtn.textContent = HEAT_LABELS[v.heatmapMode];
            heatBtn.style.background = v.heatmapMode !== 'off' ? 'var(--accent)' : '';
            heatBtn.style.color = v.heatmapMode !== 'off' ? '#fff' : '';
        };
        this._updateHeatBtn = updateHeatBtn;
        updateHeatBtn();
        heatBtn.addEventListener('click', () => {
            const idx = HEAT_MODES.indexOf(v.heatmapMode);
            v.heatmapMode = HEAT_MODES[(idx + 1) % HEAT_MODES.length];
            updateHeatBtn();
            v.render();
        }, sig);

        // Auto-tune button (click to start, click again to stop).
        // The abort controller lives on `this` so _autoTuneFresh (auto-run on load)
        // and the manual click path share it — Stop works for both.
        const autoBtn = document.getElementById('autoTuneBtn');
        this._applyTuneResult = async (result) => {
            for (const g of v.groupNames) v.propStrengths[g] = result.strengths[g] ?? 0;
            v.smoothAlpha = result.alpha;
            v.quantMode = result.quantMode;
            v._quantStats = {};
            if (result.labelProps) {
                v.labelProps.clear();
                for (const p of result.labelProps) {
                    if (v.groupNames.includes(p)) v.labelProps.add(p);
                }
                // label checkboxes synced via statechange → _syncControls
            }
            // Auto-tune bearings: closed-form trace maximization.
            const bearings = autoTuneBearings(v.nodes, v.groupNames, result.strengths);
            v.propBearings = bearings;
            document.getElementById('nudgeSlider').value = v.smoothAlpha;
            document.getElementById('nudgeVal').textContent = v.smoothAlpha.toFixed(2);
            this._updateQuantBtn();
            v._progressText = null;
            await this.rebuildProjections();
            // Re-pick level for the new blend distribution
            const lvl = pickInitialLevel(v.nodes, ZOOM_LEVELS, RAW_LEVEL);
            if (lvl !== v.currentLevel) this.switchLevel(lvl);
            this._updateOverview();
            autoBtn.textContent = 'Auto';
            autoBtn.style.background = '';
            autoBtn.style.color = '';
            this._tuneAbort = null;
            // Reset compass A button
            const cBtn = document.getElementById('compassWidget')?.shadowRoot?.querySelector('[data-action="auto"]');
            if (cBtn) { cBtn.textContent = 'A'; cBtn.title = 'Auto-tune strengths and bearings'; }
        };
        autoBtn.addEventListener('click', async () => {
            // If a tune is running (manual or auto-on-load), abort and apply best so far.
            if (this._tuneAbort) { this._tuneAbort.abort(); return; }

            this._tuneAbort = new AbortController();
            autoBtn.style.background = 'var(--accent)';
            autoBtn.style.color = '#fff';
            autoBtn.textContent = 'Stop';
            try {
                // Subsample for large datasets (same as _autoTuneFresh)
                const TUNE_MAX = 50000;
                let tuneNodes = v.nodes, tuneAdj = v.adjList, tuneIndex = v.nodeIndexFull;
                if (v.nodes.length > TUNE_MAX) {
                    const step = v.nodes.length / TUNE_MAX;
                    tuneNodes = [];
                    for (let i = 0; i < v.nodes.length; i += step) tuneNodes.push(v.nodes[Math.floor(i)]);
                    const idSet = new Set(tuneNodes.map(n => n.id));
                    tuneAdj = {};
                    tuneIndex = {};
                    for (const n of tuneNodes) {
                        tuneIndex[n.id] = n;
                        tuneAdj[n.id] = (v.adjList[n.id] || []).filter(nid => idSet.has(nid));
                    }
                    console.log(`[auto-tune] subsampled ${v.nodes.length} → ${tuneNodes.length} nodes`);
                }
                const result = await autoTuneStrengths(tuneNodes, v.groupNames, tuneAdj, tuneIndex, {
                    strengths: true, alpha: true, quant: false,
                    signal: this._tuneAbort.signal,
                    onProgress: (info) => {
                        const pct = Math.round(100 * info.step / Math.max(1, info.total));
                        const phase = info.phase === 'presets' ? 'scanning presets'
                            : info.phase === 'alpha' ? 'tuning topology'
                            : info.phase === 'done' ? 'done' : 'refining';
                        v.showProgress(`Auto-tuning: ${phase} (${pct}%) — click Stop to apply`);
                    },
                });
                await this._applyTuneResult(result);
                console.log(`Auto-tune: ${result.blends} blends, ${result.quants} quants in ${result.timeMs}ms, score=${result.score.toFixed(3)}`);
            } catch (err) {
                // Restore button state + clear tune state on any failure (including
                // unexpected errors — not just aborts). Without this, a thrown error
                // would leave _tuneAbort set and the button stuck in "Stop" state.
                console.warn('[auto-tune] failed:', err?.message || err);
                v._progressText = null;
                v.render();
                this._tuneAbort = null;
                autoBtn.textContent = 'Auto';
                autoBtn.style.background = '';
                autoBtn.style.color = '';
            }
        }, sig);

        // GPU tri-state: auto (adaptive thresholds) → gpu (always) → cpu (never) → auto
        const gpuBtn = document.getElementById('gpuBtn');
        if (!this._gpuMode) this._gpuMode = 'auto';
        const GPU_LABELS = { auto: 'Auto', gpu: 'GPU', cpu: 'CPU' };
        const updateGpuBtn = () => {
            if (this._gpuUnavailable) {
                gpuBtn.textContent = 'N/A';
                gpuBtn.style.background = '';
                gpuBtn.style.color = '';
                return;
            }
            gpuBtn.textContent = GPU_LABELS[this._gpuMode];
            const active = this._gpuMode === 'gpu' || (this._gpuMode === 'auto' && v.useGPU);
            gpuBtn.style.background = active ? 'var(--accent)' : '';
            gpuBtn.style.color = active ? '#fff' : '';
        };
        gpuBtn.title = 'GPU compute: Auto (adaptive) / GPU (always) / CPU (never)';
        gpuBtn.addEventListener('click', async () => {
            if (this._gpuUnavailable) return;
            // Cycle: auto → gpu → cpu → auto
            const next = { auto: 'gpu', gpu: 'cpu', cpu: 'auto' };
            this._gpuMode = next[this._gpuMode];

            if (this._gpuMode === 'cpu') {
                v.useGPU = false;
                updateGpuBtn();
                await this._reloadCPU();
            } else if (this._gpuMode === 'gpu') {
                gpuBtn.disabled = true;
                gpuBtn.textContent = '...';
                v.showProgress('Initializing GPU...');
                const ok = await initGPU();
                if (!ok) {
                    v.showProgress(null);
                    this._gpuUnavailable = true;
                    updateGpuBtn();
                    gpuBtn.disabled = true;
                    return;
                }
                v.useGPU = true;
                await this._applyGPUToCurrentData();
                updateGpuBtn();
                gpuBtn.disabled = false;
            } else {
                // auto: apply adaptive logic based on current dataset size
                const N = v.nodes ? v.nodes.length : 0;
                const G = v.groupNames ? v.groupNames.length : 0;
                const shouldUseGPU = N * G > 2000;
                if (shouldUseGPU && !v.useGPU) {
                    const ok = await initGPU().catch(() => false);
                    if (ok) {
                        v.useGPU = true;
                        await this._applyGPUToCurrentData();
                    }
                } else if (!shouldUseGPU && v.useGPU) {
                    v.useGPU = false;
                    await this._reloadCPU();
                }
                updateGpuBtn();
            }
        }, sig);

        // GL toggle: switch between Canvas 2D and WebGL2 rendering
        const glBtn = document.getElementById('glBtn');
        if (glBtn) {
            const updateGlBtn = () => {
                glBtn.style.background = v.useWebGL ? 'var(--accent)' : '';
                glBtn.style.color = v.useWebGL ? '#fff' : '';
                glBtn.textContent = isWebGL2Available() ? 'GL' : 'N/A';
            };
            if (!isWebGL2Available()) {
                glBtn.textContent = 'N/A';
                glBtn.disabled = true;
            }
            glBtn.addEventListener('click', () => {
                if (!isWebGL2Available()) return;
                v.useWebGL = !v.useWebGL;
                updateGlBtn();
            }, sig);
            updateGlBtn();
        }

        // Theme toggle (light/dark)
        // Restore saved theme
        if (localStorage.getItem('bz-theme') === 'light') {
            document.body.classList.add('light');
            document.getElementById('themeBtn').textContent = '\u263E';
            v.lightMode = true;
        }
        document.getElementById('themeBtn').addEventListener('click', () => {
            document.body.classList.toggle('light');
            const isLight = document.body.classList.contains('light');
            localStorage.setItem('bz-theme', isLight ? 'light' : 'dark');
            document.getElementById('themeBtn').textContent = isLight ? '\u263E' : '\u2606';
            v.lightMode = isLight;
        }, sig);

        // Help
        document.getElementById('helpBtn').addEventListener('click', () => {
            const dlg = document.getElementById('helpDialog');
            const content = document.getElementById('helpDialogContent');
            const rows = [];
            for (const el of document.querySelectorAll('header [title]')) {
                const label = el.textContent.trim().replace(/\s+/g, ' ').slice(0, 20);
                const desc = el.getAttribute('title');
                if (desc && label) rows.push([label, desc]);
            }
            content.innerHTML = rows.map(([label, desc]) =>
                `<div style="display:flex;gap:12px;padding:3px 0;border-bottom:1px solid var(--border)"><span style="color:var(--accent);min-width:60px;flex-shrink:0">${label}</span><span style="color:var(--text-dim)">${desc}</span></div>`
            ).join('') +
            `<div style="margin-top:12px;color:var(--text-dim)">` +
            `<div style="padding:3px 0"><span style="color:var(--accent)">Scroll</span> Zoom canvas</div>` +
            `<div style="padding:3px 0"><span style="color:var(--accent)">Drag</span> Pan view</div>` +
            `<div style="padding:3px 0"><span style="color:var(--accent)">Click</span> Select node</div>` +
            `<div style="padding:3px 0"><span style="color:var(--accent)">Ctrl+Click</span> Multi-select</div>` +
            `<div style="padding:3px 0"><span style="color:var(--accent)">Arrows</span> Jump to nearest node in direction</div>` +
            `<div style="padding:3px 0"><span style="color:var(--accent)">Shift+Arrows</span> Navigate to connected neighbor in direction</div>` +
            `<div style="padding:3px 0"><span style="color:var(--accent)">N / Shift+N</span> Walk connections by weight</div>` +
            `<div style="padding:3px 0"><span style="color:var(--accent)">Home</span> Select largest visible node</div>` +
            `<div style="padding:3px 0"><span style="color:var(--accent)">Enter</span> Open detail panel</div>` +
            `<div style="padding:3px 0"><span style="color:var(--accent)">, / .</span> Change zoom level</div>` +
            `<div style="padding:3px 0"><span style="color:var(--accent)">R</span> Toggle compass panel</div>` +
            `</div>`;
            dlg.showModal();
        }, sig);

        // Compass panel
        this._compassOpen = false;
        const compassPanel = document.getElementById('compassPanel');
        const compassBtn = document.getElementById('compassBtn');
        const compassClose = document.getElementById('compassClose');
        const compassTitlebar = document.getElementById('compassTitlebar');
        this._toggleCompass = (force) => {
            this._compassOpen = force ?? !this._compassOpen;
            if (this._compassOpen) {
                compassPanel.style.display = '';
                // Default position: center of viewport
                if (!compassPanel.dataset.placed) {
                    compassPanel.dataset.placed = '1';
                    const vw = window.innerWidth, vh = window.innerHeight;
                    compassPanel.style.left = Math.round(vw / 2 - 130) + 'px';
                    compassPanel.style.top = Math.round(vh / 2 - 140) + 'px';
                }
                compassBtn.style.background = 'var(--accent)';
                compassBtn.style.color = '#fff';
                // Defer sync so layout has computed non-zero dimensions
                requestAnimationFrame(() => this._syncCompass());
            } else {
                compassPanel.style.display = 'none';
                compassBtn.style.background = '';
                compassBtn.style.color = '';
            }
        };
        compassBtn.addEventListener('click', () => this._toggleCompass(), sig);
        compassClose.addEventListener('click', () => this._toggleCompass(false), sig);
        document.getElementById('compassHelp').addEventListener('click', () => {
            const w = document.getElementById('compassWidget');
            if (w) { w._showHelp = !w._showHelp; w._scheduleRender(); }
        }, sig);

        // Titlebar drag — listeners on window so fast moves don't escape
        let _cdrag = false, _cdx = 0, _cdy = 0;
        const startDrag = (clientX, clientY) => {
            _cdrag = true;
            const rect = compassPanel.getBoundingClientRect();
            _cdx = clientX - rect.left;
            _cdy = clientY - rect.top;
        };
        const moveDrag = (clientX, clientY) => {
            if (!_cdrag) return;
            compassPanel.style.left = (clientX - _cdx) + 'px';
            compassPanel.style.top = (clientY - _cdy) + 'px';
        };
        const endDrag = () => { _cdrag = false; };
        compassTitlebar.addEventListener('mousedown', e => {
            if (e.target === compassClose) return;
            e.preventDefault();
            startDrag(e.clientX, e.clientY);
        });
        window.addEventListener('mousemove', e => moveDrag(e.clientX, e.clientY));
        window.addEventListener('mouseup', endDrag);
        compassTitlebar.addEventListener('touchstart', e => {
            if (e.target === compassClose) return;
            e.preventDefault();
            startDrag(e.touches[0].clientX, e.touches[0].clientY);
        }, { passive: false });
        window.addEventListener('touchmove', e => {
            if (_cdrag) moveDrag(e.touches[0].clientX, e.touches[0].clientY);
        }, { passive: true });
        window.addEventListener('touchend', endDrag);
        window.addEventListener('touchcancel', endDrag);

        // Compass ↔ canvas sync
        const compassWidget = document.getElementById('compassWidget');
        const onCompassInput = (e) => {
            if (!e.detail) return;
            const { name, strength, bearing } = e.detail;
            v.propStrengths[name] = strength;
            v.propBearings[name] = bearing;
            this._scheduleRebuild();
        };
        compassWidget.addEventListener('input', onCompassInput);
        compassWidget.addEventListener('change', (e) => {
            if (e.detail) {
                v.propStrengths[e.detail.name] = e.detail.strength;
                v.propBearings[e.detail.name] = e.detail.bearing;
            }
            document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
            this.rebuildProjections(false); // full quality on drag end
        });
        compassWidget.addEventListener('colorby', (e) => {
            v.colorBy = (v.colorBy === e.detail.name) ? null : e.detail.name;
            this._updateColorByUI();
        });
        compassWidget.addEventListener('autotune', () => {
            // Trigger the same autotune flow as the Auto button
            const autoBtn2 = document.getElementById('autoTuneBtn');
            autoBtn2?.click();
            // Sync compass A button — check toolbar button text (set synchronously in click handler)
            const running = autoBtn2?.textContent === 'Stop';
            const cBtn = compassWidget.shadowRoot?.querySelector('[data-action="auto"]');
            if (cBtn) {
                cBtn.textContent = running ? '■' : 'A';
                cBtn.title = running ? 'Stop auto-tune' : 'Auto-tune strengths and bearings';
            }
        });

        // Strength controls (<bz-controls> component in sidebar)
        const strengthControls = document.getElementById('strengthControls');
        if (strengthControls) {
            strengthControls.addEventListener('input', (e) => {
                if (!e.detail) return; // ignore native input events bubbling from shadow DOM
                const { name, strength, bearing } = e.detail;
                v.propStrengths[name] = strength;
                v.propBearings[name] = bearing;
                document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
                this._scheduleRebuild();
            });
            strengthControls.addEventListener('change', (e) => {
                if (e.detail) {
                    const { name, strength, bearing } = e.detail;
                    v.propStrengths[name] = strength;
                    v.propBearings[name] = bearing;
                }
                document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
                // Full-quality rebuild on drag end (change fires on pointerup)
                this.rebuildProjections(false);
            });
            strengthControls.addEventListener('colorby', (e) => {
                v.colorBy = (v.colorBy === e.detail.name) ? null : e.detail.name;
                this._updateColorByUI();
                strengthControls.colorBy = v.colorBy;
            });
            strengthControls.addEventListener('autotune', () => {
                document.getElementById('autoTuneBtn')?.click();
            });
            strengthControls.addEventListener('labelchange', (e) => {
                v.labelProps = new Set(e.detail.labelProps);
                v._refreshPropCache();
                v.render();
            });
        }

        // Sidebar
        document.getElementById('sidebarToggle').addEventListener('click', () => this._toggleSidebar(), sig);
        document.getElementById('sidebarBackdrop')?.addEventListener('click', () => this._toggleSidebar(false), sig);
        document.getElementById('nodePanelClose').addEventListener('click', () => {
            v.selectedId = null;
            document.getElementById('node-panel').classList.remove('open');
            v.render();
        }, sig);

        // Level stepper
        document.getElementById('zoomPrev').addEventListener('click', () => {
            if (v.currentLevel > 0) this.switchLevel(v.currentLevel - 1);
        }, sig);
        document.getElementById('zoomNext').addEventListener('click', () => {
            if (v.currentLevel < LEVEL_LABELS.length - 1) this.switchLevel(v.currentLevel + 1);
        }, sig);
        document.getElementById('resetBtn').addEventListener('click', () => {
            v.resetView();
            this._updateStepperUI();
            this._deferUIUpdate();
        }, sig);

        // Topology alpha slider
        document.getElementById('nudgeSlider').addEventListener('input', e => {
            if (!this.dataLoaded) return;
            v.smoothAlpha = parseFloat(e.target.value);
            document.getElementById('nudgeVal').textContent = v.smoothAlpha.toFixed(2);
            this._scheduleRebuild();
        }, sig);

        // Load button + file inputs + drop zone
        document.getElementById('loadNewBtn').addEventListener('click', () => this.showLoaderScreen(), sig);
        document.getElementById('cancelLoadBtn').addEventListener('click', () => {
            this.dataLoaded = true;
            document.getElementById('loader-screen').classList.add('hidden');
            document.getElementById('sidebar').style.display = '';
            const canvasEl = document.getElementById('canvas');
            canvasEl.style.display = 'block';
            if (canvasEl.parentElement && canvasEl.parentElement !== document.body) {
                canvasEl.parentElement.style.display = '';
            }
            document.getElementById('loadNewBtn').style.display = '';
            v.resize();
        }, sig);
        document.getElementById('edgesFile').addEventListener('change', e => {
            const f = e.target.files[0];
            if (f) this._handleFileSelect(f);
        }, sig);
        document.getElementById('nodesFile').addEventListener('change', e => {
            if (e.target.files[0]) this._handleFileSelect(e.target.files[0], 'labels');
        }, sig);

        // URL input (single field, any format)
        const edgesUrlInput = document.getElementById('edgesUrl');
        const updateUrlState = () => {
            const url = edgesUrlInput.value.trim();
            if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
                document.getElementById('loadBtn').disabled = false;
                this._pendingUrlEdges = url;
            } else {
                this._pendingUrlEdges = null;
                // Re-check file state
                if (!this.pendingEdgesText && !this.pendingNodesText && !this.pendingParsed) {
                    document.getElementById('loadBtn').disabled = true;
                }
            }
        };
        edgesUrlInput.addEventListener('input', updateUrlState, sig);

        const dropZone = document.getElementById('dropZone');
        dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); }, sig);
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'), sig);
        dropZone.addEventListener('drop', async e => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
            await this._stageDroppedFiles(e.dataTransfer.files);
        }, sig);

        // Canvas is also a drop target — dropping a file onto the viewer mid-session
        // stages and immediately loads, bypassing the loader panel.
        const canvasEl = document.getElementById('canvas');
        const canvasDragTarget = canvasEl.parentElement || canvasEl;
        canvasDragTarget.addEventListener('dragover', e => {
            if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
                e.preventDefault();
                canvasDragTarget.classList.add('drag-hover');
            }
        }, sig);
        canvasDragTarget.addEventListener('dragleave', () => canvasDragTarget.classList.remove('drag-hover'), sig);
        canvasDragTarget.addEventListener('drop', async e => {
            if (!e.dataTransfer || !e.dataTransfer.files.length) return;
            e.preventDefault();
            canvasDragTarget.classList.remove('drag-hover');

            // Classify the incoming drop to decide whether to replace or merge.
            // SNAP .edges and .nodes can arrive as a pair across two quick drops
            // — debounce briefly so a companion file can join before the load fires.
            const files = [...e.dataTransfer.files];
            const names = files.map(f => f.name.toLowerCase());
            const hasSnapOnly = files.length > 0 && names.every(n =>
                n.endsWith('.edges') || n.endsWith('.edges.gz') ||
                n.endsWith('.nodes') || n.endsWith('.nodes.gz') ||
                n.endsWith('.labels') || n.endsWith('.labels.gz'));

            if (hasSnapOnly) {
                // First SNAP drop of a potential pair — preserve any prior pending SNAP state
                // so a previous drop can complete. Cancel any pending canvas-drop timer,
                // stage, and re-arm the timer. If the second file arrives in time, the timer
                // fires with both files staged.
                if (this._canvasDropTimer) clearTimeout(this._canvasDropTimer);
                await this._stageDroppedFiles(files);
                this._canvasDropTimer = setTimeout(async () => {
                    this._canvasDropTimer = null;
                    await this._executeCanvasLoad();
                }, 600);
            } else {
                // Non-SNAP drop (CSV / D3 / JGF / STIX / mixed) — replaces any prior state
                if (this._canvasDropTimer) { clearTimeout(this._canvasDropTimer); this._canvasDropTimer = null; }
                this.pendingEdgesText = null;
                this.pendingNodesText = null;
                this.pendingParsed = null;
                // Show loader screen before heavy work so UI doesn't appear frozen
                this.showLoaderScreen();
                const status = document.getElementById('loadStatus');
                status.textContent = 'Reading file...';
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                const file = files[0];
                const text = await readFileText(file);
                status.textContent = `Parsing ${file.name}...`;
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                const format = detectFormat(text, file.name);
                if (isObjectFormat(format)) {
                    const parsed = parseAny(text, file.name);
                    this.pendingParsed = parsed;
                    this._pendingFileName = file.name.replace(/\.[^.]+$/g, '');
                } else {
                    await this._stageDroppedFiles(files);
                }
                await this._executeCanvasLoad();
            }
        }, sig);

        document.getElementById('loadBtn').addEventListener('click', async () => {
            // URL-based loading takes priority if URL is set
            if (this._pendingUrlEdges) {
                const url = this._pendingUrlEdges;
                // For SNAP .edges URLs, infer the companion .nodes URL by convention.
                // For any other format (CSV, D3 JSON, JGF), loadDataset will detect
                // the format from fetched content and route through the object pipeline.
                let nodesUrl = url.replace(/\.edges(\.gz)?$/, (_, gz) => '.nodes' + (gz || ''));
                if (nodesUrl === url) nodesUrl = null; // URL didn't match .edges pattern
                const name = url.split('/').pop()?.replace(/\.(edges|csv|tsv|json)(\.gz)?$/, '') || 'Remote';
                this.loadDataset({ id: '__url__', name, edges: url, nodes: nodesUrl, desc: 'URL' });
                return;
            }
            const progressBar = document.getElementById('loadProgress');
            progressBar.style.display = 'block';
            progressBar.value = 0;
            document.getElementById('loadBtn').disabled = true;
            try {
                if (this.pendingParsed) {
                    // Object pipeline: CSV / D3 JSON / JGF / nodes-only SNAP
                    await this.loadFromParsed(this.pendingParsed);
                } else {
                    const gpuPath = this._gpuMode === 'gpu' || (this._gpuMode === 'auto' && !this._gpuUnavailable);
                    if (gpuPath) await this.loadGraphGPU(this.pendingEdgesText, this.pendingNodesText, null);
                    else await this.loadGraph(this.pendingEdgesText, this.pendingNodesText);
                }
                const nameEl = document.getElementById('datasetName');
                if (nameEl) nameEl.textContent = this._pendingFileName || 'Custom';
                this._finalizeLoad(null);
            }
            catch (_err) { /* shown by worker handler */ }
        }, sig);
    }

    _toggleSidebar(open) {
        const sidebar = document.querySelector('.sidebar');
        const backdrop = document.getElementById('sidebarBackdrop');
        const isOpen = open !== undefined ? open : !sidebar.classList.contains('open');
        sidebar.classList.toggle('open', isOpen);
        if (backdrop) backdrop.classList.toggle('open', isOpen);
    }

    async _fetchText(url) {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
        if (url.endsWith('.gz')) {
            const ds = new DecompressionStream('gzip');
            const reader = resp.body.pipeThrough(ds).getReader();
            const chunks = [];
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
            }
            const merged = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
            let off = 0;
            for (const c of chunks) { merged.set(c, off); off += c.length; }
            return new TextDecoder().decode(merged);
        }
        return resp.text();
    }

    /** Execute whatever is currently staged in pendingParsed / pendingEdgesText /
     *  pendingNodesText as a canvas-drop load. Shared by the immediate-load path
     *  (non-SNAP drops) and the debounced path (SNAP pair drops). */
    async _executeCanvasLoad() {
        if (!this.pendingParsed && !this.pendingEdgesText && !this.pendingNodesText) return;
        try {
            const n = this.pendingParsed ? this.pendingParsed.nodes.size : 0;
            if (n > 10000) {
                this.view.showProgress(`Building graph (${n.toLocaleString()} nodes)...`);
                await new Promise(r => setTimeout(r, 0)); // yield so progress text renders
            }
            if (this.pendingParsed) {
                await this.loadFromParsed(this.pendingParsed);
            } else {
                const gpuPath = this._gpuMode === 'gpu' || (this._gpuMode === 'auto' && !this._gpuUnavailable);
                if (gpuPath) await this.loadGraphGPU(this.pendingEdgesText, this.pendingNodesText, null);
                else await this.loadGraph(this.pendingEdgesText, this.pendingNodesText);
            }
            // Build a synthetic dataset descriptor from parsed metadata (if present)
            const meta = this.pendingParsed?.metadata;
            const nameEl = document.getElementById('datasetName');
            if (nameEl) nameEl.textContent = meta?.name || this._pendingFileName || 'Custom';
            const ds = meta?.settings ? { settings: meta.settings } : null;
            this._finalizeLoad(ds);
        } catch (err) {
            this._showError('Load Error', err.message || 'Failed to load dropped file');
        }
    }

    /** Route dropped/selected files into the pending slots via shared classifyFiles. */
    async _stageDroppedFiles(files) {
        const { edgesText, nodesText, parsed, fileName } = await classifyFiles(files);
        if (parsed) {
            this.pendingParsed = parsed;
            this.pendingEdgesText = null;
            this.pendingNodesText = null;
            this._pendingFileName = fileName;
        } else {
            if (edgesText) { this.pendingEdgesText = edgesText; this.pendingParsed = null; }
            if (nodesText) { this.pendingNodesText = nodesText; this.pendingParsed = null; }
            if (fileName) this._pendingFileName = fileName;
        }
    }

    /** Read file contents as text, transparently decompressing .gz files. */
    async _readFileText(file) { return readFileText(file); }

    /** Handle a dropped/selected file. Detects format from content + filename.
     *  SNAP files stage into pendingEdgesText/pendingNodesText for the text worker pipeline.
     *  CSV / D3 / JGF files parse via parseAny and stage into pendingParsed for the object pipeline.
     *  @param {File} file
     *  @param {'edges'|'labels'} [hintType] - legacy routing hint for ambiguous SNAP content
     */
    async _handleFileSelect(file, hintType) {
        let text;
        try {
            text = await this._readFileText(file);
        } catch (err) {
            this._showError('Read Error', err.message);
            return;
        }

        const format = detectFormat(text, file.name);
        const baseName = file.name
            .replace(/\.(csv|tsv|json|edges|nodes|labels|txt|graphml|gexf|xml|gz)$/gi, '')
            .replace(/\.(csv|tsv|json|edges|nodes|labels|txt|graphml|gexf|xml)$/gi, '');

        if (format === 'snap-edges') {
            this.pendingEdgesText = text;
            this.pendingParsed = null;
            this._pendingFileName = baseName;
        } else if (format === 'snap-nodes') {
            this.pendingNodesText = text;
            this.pendingParsed = null;
        } else if (format === 'snap') {
            // Ambiguous SNAP content — use hint or default to edges
            if (hintType === 'labels') this.pendingNodesText = text;
            else { this.pendingEdgesText = text; this._pendingFileName = baseName; }
            this.pendingParsed = null;
        } else if (isObjectFormat(format)) {
            // CSV / D3 / JGF / GraphML / GEXF / Cytoscape / bare JSON / nodes-only SNAP
            try {
                const parsed = parseAny(text, file.name);
                this.pendingParsed = parsed;
                this.pendingEdgesText = null;
                this.pendingNodesText = null;
                this._pendingFileName = baseName;
            } catch (err) {
                this._showError('Parse Error', err.message);
                return;
            }
        } else {
            this._showError('Unknown Format', `Could not detect a supported format for ${file.name}`);
            return;
        }
        this._updateLoadStatus();
    }

    _updateLoadStatus() {
        const status = document.getElementById('loadStatus');
        const parts = [];
        if (this.pendingParsed) {
            const n = this.pendingParsed.nodes.size;
            const e = this.pendingParsed.edges ? this.pendingParsed.edges.length : 0;
            parts.push(`${this.pendingParsed.format}: ${n} nodes${e ? `, ${e} edges` : ''} ready`);
        }
        if (this.pendingEdgesText) parts.push('edges file ready');
        if (this.pendingNodesText) parts.push('nodes file ready');
        status.textContent = parts.length > 0 ? parts.join(' · ') : '';
        status.classList.remove('error');
        // Allow load when any source is ready
        document.getElementById('loadBtn').disabled = !this.pendingEdgesText && !this.pendingNodesText && !this.pendingParsed;
    }

    _buildDatasetButtons() {
        const select = document.getElementById('datasetSelect');
        select.innerHTML = '';
        for (const ds of DATASETS) {
            const opt = document.createElement('option');
            opt.value = ds.id;
            opt.textContent = `${ds.name} — ${ds.desc}`;
            select.appendChild(opt);
        }
        // Pre-select current or default
        if (this._currentDatasetId) select.value = this._currentDatasetId;
        document.getElementById('datasetLoadBtn').addEventListener('click', () => {
            const ds = DATASETS.find(d => d.id === select.value);
            if (ds) this.loadDataset(ds);
        });
        // Double-click loads immediately
        select.addEventListener('dblclick', () => {
            const ds = DATASETS.find(d => d.id === select.value);
            if (ds) this.loadDataset(ds);
        });
    }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────
// Defer until stylesheets are loaded to avoid forced layout before CSS is ready.
const ready = document.readyState === 'complete'
  ? Promise.resolve()
  : new Promise(r => window.addEventListener('load', r, { once: true }));
await ready;

const bz = new BitZoom();
window.bz = bz;

// Load dataset presets, probe WebGPU, then load initial dataset
(async () => {
  try {
    DATASETS = await fetch('datasets.json').then(r => r.json());
    bz._buildDatasetButtons();
  } catch (e) {
    bz._showError('Initialization Error', 'Failed to load datasets.json: ' + e.message);
  }
  bz._gpuMode = 'auto';
  try {
    const gpuOk = await initGPU();
    if (gpuOk) setGpuBlendProfiling(true);
    const gpuBtn = document.getElementById('gpuBtn');
    if (gpuOk) {
      bz.view.useGPU = true;
      console.log('[GPU] WebGPU available — auto mode, blend profiling enabled');
      if (gpuBtn) { gpuBtn.textContent = 'Auto'; gpuBtn.style.background = 'var(--accent)'; gpuBtn.style.color = '#fff'; }
    } else {
      console.log('[GPU] WebGPU not available — CPU only');
      if (gpuBtn) { gpuBtn.textContent = 'N/A'; gpuBtn.disabled = true; bz._gpuUnavailable = true; }
    }
  } catch (err) {
    console.error('[GPU] WebGPU probe failed:', err);
    const gpuBtn = document.getElementById('gpuBtn');
    if (gpuBtn) { gpuBtn.textContent = 'N/A'; gpuBtn.disabled = true; bz._gpuUnavailable = true; }
  }

  // Save hash params before anything can overwrite them
  const hashParams = bz._restoreFromHash();
  let startDataset = null;
  if (hashParams?.edges) {
    // URL-based loading: #edges=https://...&nodes=https://...
    const edgesUrl = hashParams.edges;
    let nodesUrl = hashParams.nodes || null;
    if (!nodesUrl) {
      nodesUrl = edgesUrl.replace(/\.edges(\.gz)?$/, (_, gz) => '.nodes' + (gz || ''));
      if (nodesUrl === edgesUrl) nodesUrl = null;
    }
    const name = edgesUrl.split('/').pop()?.replace(/\.edges(\.gz)?$/, '') || 'Remote';
    startDataset = { id: '__url__', name, edges: edgesUrl, nodes: nodesUrl, desc: 'URL' };
  } else {
    const hashDataset = hashParams?.d ? DATASETS.find(d => d.id === hashParams.d) : null;
    startDataset = hashDataset || DATASETS.find(d => d.id === 'epstein');
  }
  bz._initialHashParams = hashParams; // preserved for _finalizeLoad
  if (startDataset) bz.loadDataset(startDataset);
})();

window.addEventListener('hashchange', () => {
    if (!bz.dataLoaded || bz._finalizing) return; // ignore hash changes during loading/finalization
    const params = bz._restoreFromHash();
    // Check if hash matches the currently loaded dataset (curated or URL)
    const sameDataset = params && (
        (params.d && params.d === bz._currentDatasetId) ||
        (params.edges && params.edges === bz._currentEdgesUrl)
    );
    if (sameDataset) {
        bz._applyHashState(params);
    } else if (params?.edges) {
        const edgesUrl = params.edges;
        let nodesUrl = params.nodes || null;
        if (!nodesUrl) {
            nodesUrl = edgesUrl.replace(/\.edges(\.gz)?$/, (_, gz) => '.nodes' + (gz || ''));
            if (nodesUrl === edgesUrl) nodesUrl = null;
        }
        const name = edgesUrl.split('/').pop()?.replace(/\.edges(\.gz)?$/, '') || 'Remote';
        bz.loadDataset({ id: '__url__', name, edges: edgesUrl, nodes: nodesUrl, desc: 'URL' });
    } else if (params?.d) {
        const ds = DATASETS.find(d => d.id === params.d);
        if (ds) bz.loadDataset(ds);
    }
});
