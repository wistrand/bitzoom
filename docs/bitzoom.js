// bitzoom.js — Public API entrypoint for BitZoom.
// Import this file (unbundled) or dist/bitzoom.bundle.js (minified single file).

// Core factories and class
export { createBitZoomView, createBitZoomFromGraph, BitZoomCanvas } from './bitzoom-canvas.js';

// Web component (<bz-graph> custom element, auto-registers on import)
export { BzGraph } from './bz-graph.js';

// Utilities
export { autoTuneStrengths, autoTuneStrengths as autoTuneWeights, autoTuneBearings } from './bitzoom-utils.js';
export { exportSVG, createSVGView } from './bitzoom-svg.js';

// Feature probes
export { isWebGL2Available } from './bitzoom-gl-renderer.js';
export { initGPU } from './bitzoom-gpu.js';

// Color schemes
export {
  generateGroupColors,
  SCHEME_VIVID, SCHEME_VIRIDIS, SCHEME_PLASMA, SCHEME_INFERNO, SCHEME_THERMAL,
  SCHEME_GRAYSCALE, SCHEME_DIVERGING, SCHEME_GREENS, SCHEME_REDS,
  COLOR_SCHEME_NAMES,
} from './bitzoom-colors.js';
