// bz-graph.js — <bz-graph> web component for BitZoom.
//
// Usage:
//   <!-- Prevent flash of inline text before component loads -->
//   <style>bz-graph:not(:defined) { visibility: hidden; }</style>
//
//   <bz-graph edges="data/karate.edges" nodes="data/karate.nodes"
//             level="3" heatmap="density" legend color-scheme="viridis">
//   </bz-graph>
//
//   <bz-graph format="json">
//     {"nodes":[{"id":"a","group":"x"},{"id":"b","group":"y"}],
//      "edges":[{"src":"a","dst":"b"}]}
//   </bz-graph>
//
//   <bz-graph format="snap">
//     # From	To
//     alice	bob
//     bob	carol
//   </bz-graph>

import { createBitZoomView, createBitZoomFromGraph } from './bitzoom-canvas.js';
import { SCHEME_VIVID } from './bitzoom-colors.js';

const ATTR_MAP = {
  'level':        { prop: 'initialLevel', type: 'int', default: 3 },
  'heatmap':      { prop: 'heatmapMode',  type: 'string', default: 'off' },
  'edge-mode':    { prop: 'edgeMode',     type: 'string', default: 'curves' },
  'quant':        { prop: 'quantMode',    type: 'string', default: 'gaussian' },
  'alpha':        { prop: 'smoothAlpha',  type: 'float', default: 0 },
  'color-scheme': { prop: 'colorScheme',  type: 'int', default: SCHEME_VIVID },
  'size-by':      { prop: 'sizeBy',       type: 'string', default: 'edges' },
  'webgl':        { prop: 'webgl',        type: 'bool', default: false },
  'auto-gpu':     { prop: 'autoGPU',      type: 'bool', default: true },
  'auto-tune':    { prop: 'autoTune',     type: 'json', default: null },
};

const BOOL_ATTRS = ['legend', 'reset-btn', 'light-mode', 'size-log', 'webgl', 'auto-gpu'];

function parseAttr(value, type) {
  if (value === null || value === undefined) return undefined;
  switch (type) {
    case 'int': return parseInt(value, 10) || 0;
    case 'float': return parseFloat(value) || 0;
    case 'bool': return value !== 'false' && value !== '0';
    case 'string': return value;
    case 'json': try { return JSON.parse(value); } catch { return null; }
    default: return value;
  }
}

class BzGraph extends HTMLElement {
  static get observedAttributes() {
    return ['edges', 'nodes', 'format', ...Object.keys(ATTR_MAP), ...BOOL_ATTRS];
  }

  constructor() {
    super();
    this._view = null;
    this._shadow = this.attachShadow({ mode: 'open' });
    this._shadow.innerHTML = `<style>
      :host { display: block; position: relative; }
      canvas { width: 100%; height: 100%; display: block; background: var(--bz-bg, #12122a); }
    </style><canvas></canvas>`;
    this._canvas = this._shadow.querySelector('canvas');
  }

  connectedCallback() {
    // Defer to allow inner text content to be parsed
    requestAnimationFrame(() => this._init());
  }

  disconnectedCallback() {
    if (this._view) { this._view.destroy(); this._view = null; }
  }

  async _init() {
    if (this._view) return;
    const opts = this._buildOpts();
    const edgesUrl = this.getAttribute('edges');
    const nodesUrl = this.getAttribute('nodes');
    const format = this.getAttribute('format');
    const inline = this.textContent.trim();

    if (edgesUrl) {
      // File mode: fetch SNAP files
      const [edgesText, nodesText] = await Promise.all([
        fetch(edgesUrl).then(r => r.text()),
        nodesUrl ? fetch(nodesUrl).then(r => r.text()).catch(() => null) : Promise.resolve(null),
      ]);
      this._view = createBitZoomView(this._canvas, edgesText, nodesText, opts);
    } else if (inline && format === 'json') {
      // Inline JSON mode
      const data = JSON.parse(inline);
      const nodes = data.nodes || [];
      const edges = data.edges || [];
      this._view = createBitZoomFromGraph(this._canvas, nodes, edges, opts);
    } else if (inline) {
      // Inline SNAP mode (default for raw text)
      const lines = inline.split('\n');
      // Split into edges text and optional nodes text (separated by blank line + # header)
      let edgesText = inline;
      let nodesText = null;
      const sepIdx = lines.findIndex((l, i) => i > 0 && l.startsWith('# ') && lines[i - 1].trim() === '');
      if (sepIdx > 0) {
        edgesText = lines.slice(0, sepIdx - 1).join('\n');
        nodesText = lines.slice(sepIdx).join('\n');
      }
      this._view = createBitZoomView(this._canvas, edgesText, nodesText, opts);
    }
  }

  _buildOpts() {
    const opts = {};
    // Weights from attribute: weights="group:5,kind:8"
    const weightsAttr = this.getAttribute('weights');
    if (weightsAttr) {
      opts.weights = {};
      for (const pair of weightsAttr.split(',')) {
        const [k, v] = pair.split(':');
        if (k && v) opts.weights[k.trim()] = parseFloat(v.trim()) || 0;
      }
    }
    // Label props from attribute: label-props="label,group"
    const labelPropsAttr = this.getAttribute('label-props');
    if (labelPropsAttr) {
      opts.labelProps = labelPropsAttr.split(',').map(s => s.trim());
    }
    // Mapped attributes
    for (const [attr, def] of Object.entries(ATTR_MAP)) {
      const raw = this.getAttribute(attr);
      if (raw !== null) opts[def.prop] = parseAttr(raw, def.type);
    }
    // Boolean attributes (presence = true)
    if (this.hasAttribute('legend')) opts.showLegend = true;
    if (this.hasAttribute('reset-btn')) opts.showResetBtn = true;
    if (this.hasAttribute('light-mode')) opts.lightMode = true;
    if (this.hasAttribute('size-log')) opts.sizeLog = true;
    return opts;
  }

  // Public API: access the underlying BitZoomCanvas
  get view() { return this._view; }

  attributeChangedCallback(name, oldVal, newVal) {
    if (!this._view || oldVal === newVal) return;
    const v = this._view;
    switch (name) {
      case 'level': v.switchLevel(parseInt(newVal) || 0); break;
      case 'alpha': v.setAlpha(parseFloat(newVal) || 0); break;
      case 'color-scheme': v.colorScheme = parseInt(newVal) || 0; break;
      case 'light-mode': v.lightMode = this.hasAttribute('light-mode'); break;
      case 'legend': v.showLegend = this.hasAttribute('legend') ? 1 : 0; v.render(); break;
      case 'heatmap': v.setOptions({ heatmapMode: newVal || 'off' }); v.render(); break;
      case 'edge-mode': v.setOptions({ edgeMode: newVal || 'curves' }); v.render(); break;
    }
  }
}

customElements.define('bz-graph', BzGraph);

export { BzGraph };
