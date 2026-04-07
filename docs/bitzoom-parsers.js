// bitzoom-parsers.js — format parsers for alternative input types.
//
// Exports:
//   - parseCSV / csvRowsToNodes / parseCSVToNodes — CSV with header sniffing
//   - parseD3    — D3 force JSON ({nodes, links})
//   - parseJGF   — JSON Graph Format ({graph: {nodes, edges}})
//   - detectFormat — content-based format sniffer
//   - parseAny   — unified dispatcher returning {nodes, edges, extraPropNames}

import { parseNodesFile } from './bitzoom-pipeline.js';
import { parseSTIX } from './stix2snap.js';

// ─── CSV parsing ─────────────────────────────────────────────────────────────

const BOM = 0xFEFF;

/**
 * Parse CSV/TSV/SSV text into header + rows.
 * Handles quoted fields with embedded delimiters and newlines, escaped quotes
 * (`""` inside a quoted field), UTF-8 BOM, and CRLF line endings. Delimiter is
 * auto-detected from comma/tab/semicolon/pipe occurrences in the first logical
 * line unless `opts.delimiter` is provided.
 *
 * @param {string} text
 * @param {{ delimiter?: string }} [opts]
 * @returns {{ headers: string[], rows: string[][], delimiter: string }}
 */
export function parseCSV(text, opts = {}) {
  if (!text) return { headers: [], rows: [], delimiter: ',' };
  if (text.charCodeAt(0) === BOM) text = text.slice(1);

  const delim = opts.delimiter || detectDelimiter(text);

  const allRows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const len = text.length;

  for (let i = 0; i < len; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delim) {
        row.push(field);
        field = '';
      } else if (ch === '\n') {
        // Strip trailing \r from last field (CRLF handling)
        if (field.length && field.charCodeAt(field.length - 1) === 13) {
          field = field.slice(0, -1);
        }
        row.push(field);
        field = '';
        if (!isEmptyRow(row)) allRows.push(row);
        row = [];
      } else {
        field += ch;
      }
    }
  }
  // Final field / row (no trailing newline)
  if (field.length || row.length) {
    row.push(field);
    if (!isEmptyRow(row)) allRows.push(row);
  }

  if (allRows.length === 0) return { headers: [], rows: [], delimiter: delim };
  const headers = allRows[0].map(h => h.trim());
  return { headers, rows: allRows.slice(1), delimiter: delim };
}

function isEmptyRow(row) {
  if (row.length === 0) return true;
  if (row.length === 1 && row[0] === '') return true;
  return false;
}

/**
 * Auto-detect delimiter from the first logical line (respects quoted fields
 * so delimiters inside quoted values are not counted). Scans the first 4KB.
 */
function detectDelimiter(text) {
  const scanLen = Math.min(text.length, 4096);
  let inQuotes = false;
  const counts = { ',': 0, '\t': 0, ';': 0, '|': 0 };
  for (let i = 0; i < scanLen; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') { i++; continue; }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes) {
      if (ch === '\n') break;
      if (counts[ch] !== undefined) counts[ch]++;
    }
  }
  let best = ',', max = -1;
  for (const d of [',', '\t', ';', '|']) {
    if (counts[d] > max) { max = counts[d]; best = d; }
  }
  return max > 0 ? best : ',';
}

// ─── Header sniffing ─────────────────────────────────────────────────────────

const ID_CANDIDATES = ['id', 'node_id', 'nodeid', 'uuid', 'key'];
const LABEL_CANDIDATES = ['label', 'name', 'title'];
const GROUP_CANDIDATES = ['group', 'category', 'type', 'class', 'kind'];

/**
 * Convert CSV headers + rows into a nodesMap matching parseNodesFile output.
 *
 * Role resolution (case-insensitive, first match wins per role):
 *   id:    id / node_id / nodeid / uuid / key
 *   label: label / name / title
 *   group: group / category / type / class / kind
 *
 * If NO role is matched by header name, falls back to full positional mapping
 * (col 0 = id, col 1 = label, col 2 = group). If SOME roles are matched by name
 * but id is not, id defaults to col 0; label defaults to the id value (not a
 * positional guess); group defaults to 'unknown'.
 *
 * Remaining columns become extra property groups (lowercased, spaces→underscores).
 * Rows with empty id fields get sequential anonymous ids (`row_0`, `row_1`, ...).
 *
 * @param {string[]} headers
 * @param {string[][]} rows
 * @returns {{ nodes: Map<string, object>, extraPropNames: string[] }}
 */
export function csvRowsToNodes(headers, rows) {
  const normalized = headers.map(h => (h || '').toLowerCase().trim());
  const used = new Set();

  const findRole = (candidates) => {
    for (const c of candidates) {
      const idx = normalized.indexOf(c);
      if (idx >= 0 && !used.has(idx)) { used.add(idx); return idx; }
    }
    return -1;
  };

  let idCol = findRole(ID_CANDIDATES);
  let labelCol = findRole(LABEL_CANDIDATES);
  let groupCol = findRole(GROUP_CANDIDATES);

  // Full positional fallback only if NO role was matched by header name.
  // This preserves parseNodesFile's positional convention for header-less or
  // convention-following CSVs, while trusting headers when any role is named.
  const anyNamed = idCol >= 0 || labelCol >= 0 || groupCol >= 0;
  if (!anyNamed) {
    if (headers.length > 0) { idCol = 0; used.add(0); }
    if (headers.length > 1) { labelCol = 1; used.add(1); }
    if (headers.length > 2) { groupCol = 2; used.add(2); }
  } else if (idCol < 0 && headers.length > 0) {
    // Some roles named but id wasn't — claim first unused column as id
    for (let i = 0; i < headers.length; i++) {
      if (!used.has(i)) { idCol = i; used.add(i); break; }
    }
  }

  // Uniqueness check: if the proposed id column has DUPLICATE non-empty values
  // (likely a categorical like "species"), reject it and use sequential anonymous
  // ids. Empty values are OK — the anon counter handles those. Promote the failed
  // id column to `group` since a column with a few distinct values is meaningful
  // grouping. When positional fallback was used, override any prior positional
  // group assignment (the failed id column is a better semantic group than some
  // arbitrary third column of numeric data).
  if (idCol >= 0 && rows.length > 0) {
    const seen = new Set();
    let duplicate = false;
    for (const row of rows) {
      const v = row[idCol];
      if (v == null || String(v).trim() === '') continue; // empties get anon ids, not collisions
      if (seen.has(v)) { duplicate = true; break; }
      seen.add(v);
    }
    if (duplicate) {
      const failedIdCol = idCol;
      idCol = -1;
      // Override any positional group assignment — the failed id column is semantically better.
      // Skip only if the user explicitly named a group column (anyNamed && groupCol from findRole).
      const groupWasNamed = anyNamed && GROUP_CANDIDATES.some(c => normalized.indexOf(c) === groupCol);
      if (!groupWasNamed) {
        if (groupCol >= 0) used.delete(groupCol); // release the old positional assignment
        groupCol = failedIdCol;
      } else {
        used.delete(failedIdCol); // no override; release failed id to extras
      }
    }
  }

  // Everything else becomes an extra property group
  const extraPropNames = [];
  const extraIdx = [];
  for (let i = 0; i < headers.length; i++) {
    if (!used.has(i)) {
      extraPropNames.push(normalized[i].replace(/\s+/g, '_'));
      extraIdx.push(i);
    }
  }

  const nodes = new Map();
  let anonCounter = 0;
  for (const row of rows) {
    const rawId = idCol >= 0 ? row[idCol] : undefined;
    const id = (rawId != null && String(rawId).trim()) ? String(rawId).trim() : `row_${anonCounter++}`;
    const label = labelCol >= 0 ? (row[labelCol] || id) : id;
    const group = groupCol >= 0 ? (row[groupCol] || 'unknown') : 'unknown';
    const extraProps = {};
    for (let i = 0; i < extraIdx.length; i++) {
      extraProps[extraPropNames[i]] = row[extraIdx[i]] || '';
    }
    nodes.set(id, { label, group, extraProps });
  }
  return { nodes, extraPropNames };
}

/**
 * Convenience: parse CSV text directly into a nodesMap.
 * Equivalent to parseCSV() + csvRowsToNodes().
 */
export function parseCSVToNodes(text, opts) {
  const { headers, rows } = parseCSV(text, opts);
  return csvRowsToNodes(headers, rows);
}

// ─── JSON formats ────────────────────────────────────────────────────────────

/**
 * Parse D3 force-directed JSON into the object shape consumed by
 * runPipelineFromObjects. Accepts both `{nodes, links}` (D3 convention) and
 * `{nodes, edges}` (BitZoom internal convention).
 *
 * Node shape: `{id, label?, group?, ...extras}` — any extra top-level keys
 * become property groups.
 * Edge shape: `{source, target}` (D3) or `{src, dst}` (internal). `type` or
 * `relation` becomes the edge type if present.
 *
 * @param {object} data
 * @returns {{ nodes: Map, edges: Array, extraPropNames: string[] }}
 */
export function parseD3(data) {
  if (!data || !Array.isArray(data.nodes)) {
    throw new Error('D3 JSON: missing nodes array');
  }
  const nodes = new Map();
  const extraPropSet = new Set();
  // Preserve insertion order so numeric link indices (D3 convention) can be resolved
  const idByIndex = [];
  let anonCounter = 0;

  for (const n of data.nodes) {
    // D3 convention: some files use `name` instead of `id`
    const rawId = n.id ?? n.name;
    const id = (rawId != null && String(rawId).trim()) ? String(rawId) : `row_${anonCounter++}`;
    const label = n.label || n.name || String(id);
    const group = n.group != null ? String(n.group) : 'unknown';
    const extraProps = {};
    for (const k in n) {
      if (k === 'id' || k === 'label' || k === 'group' || k === 'name') continue;
      const v = n[k];
      if (v === null || v === undefined) continue;
      extraProps[k] = typeof v === 'string' ? v : String(v);
      extraPropSet.add(k);
    }
    nodes.set(id, { label, group, extraProps });
    idByIndex.push(id);
  }

  // Resolve a link endpoint. D3 convention allows:
  //   - string id matching a node's id/name
  //   - numeric value that's either a string-id match or an index into the node array
  //   - object reference (after d3-force mutation)
  // For numeric values, prefer string-id match (e.g. nodes have id: 1, 2) and fall back
  // to index lookup (e.g. Miserables uses numeric indices into a nodes-with-name array).
  const resolveEndpoint = (v) => {
    if (v == null) return null;
    if (typeof v === 'object') {
      const inner = v.id ?? v.name;
      return inner != null ? String(inner) : null;
    }
    if (typeof v === 'number') {
      const asString = String(v);
      if (nodes.has(asString)) return asString;
      return idByIndex[v] ?? null;
    }
    return String(v);
  };

  const edgeArray = data.links || data.edges || [];
  const edges = [];
  for (const e of edgeArray) {
    const src = resolveEndpoint(e.source ?? e.src);
    const dst = resolveEndpoint(e.target ?? e.dst);
    if (src == null || dst == null) continue;
    const edge = { src, dst };
    const type = e.type || e.relation;
    if (type) edge.type = String(type);
    edges.push(edge);
  }

  // Top-level metadata: source, description, credits, BitZoom settings, etc.
  // Passed through to the viewer for display and optional preset application.
  const metadata = data.metadata || null;

  return { nodes, edges, extraPropNames: [...extraPropSet], metadata };
}

/**
 * Parse JSON Graph Format (JGF) into the object shape consumed by
 * runPipelineFromObjects. Handles both single-graph `{graph: {...}}` and
 * multi-graph `{graphs: [...]}` forms (first graph picked).
 *
 * Node shape: `{id, label?, metadata?: {group?, ...extras}}`.
 * Edge shape: `{source, target, relation?, label?}`.
 *
 * @param {object} data
 * @returns {{ nodes: Map, edges: Array, extraPropNames: string[] }}
 */
export function parseJGF(data) {
  const graph = data?.graph || (Array.isArray(data?.graphs) ? data.graphs[0] : null);
  if (!graph || graph.nodes == null) {
    throw new Error('JGF: missing graph.nodes');
  }

  // JGF v1 allows graph.nodes as either an array of {id, ...} or a dict keyed by id
  const nodeEntries = Array.isArray(graph.nodes)
    ? graph.nodes.map(n => [n.id, n])
    : Object.entries(graph.nodes);

  const nodes = new Map();
  const extraPropSet = new Set();
  let anonCounter = 0;

  for (const [rawId, n] of nodeEntries) {
    const id = (rawId != null && String(rawId).trim()) ? String(rawId) : `row_${anonCounter++}`;
    const label = n.label || String(id);
    const metadata = n.metadata || {};
    const group = metadata.group != null ? String(metadata.group) : 'unknown';
    const extraProps = {};
    for (const k in metadata) {
      if (k === 'group') continue;
      const v = metadata[k];
      if (v === null || v === undefined) continue;
      extraProps[k] = typeof v === 'string' ? v : String(v);
      extraPropSet.add(k);
    }
    nodes.set(id, { label, group, extraProps });
  }

  const edges = [];
  for (const e of graph.edges || []) {
    if (e.source == null || e.target == null) continue;
    const edge = { src: String(e.source), dst: String(e.target) };
    const type = e.relation || e.label;
    if (type) edge.type = String(type);
    edges.push(edge);
  }

  return { nodes, edges, extraPropNames: [...extraPropSet] };
}

// ─── Minimal XML parser (GraphML/GEXF subset) ────────────────────────────────
//
// Hand-rolled SAX-style parser sufficient for GraphML and GEXF files. Handles
// element tags, self-closing tags, attributes (double/single-quoted), text
// content, XML declarations, comments, CDATA, DOCTYPE. Does NOT handle entities
// beyond the five standard ones (&amp; &lt; &gt; &quot; &apos;) or numeric
// character references. Namespace prefixes are stripped (svg:node → node).
//
// Returns a tree of { tag, attrs, children, text } where:
//   tag:      local element name (namespace prefix removed)
//   attrs:    object of name → value
//   children: array of child element nodes
//   text:     concatenated text content (direct text children only)

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripNs(name) {
  const i = name.indexOf(':');
  return i >= 0 ? name.slice(i + 1) : name;
}

function parseTagHeader(s) {
  // Input: "tagname attr1=\"value1\" attr2='v2' ..."
  s = s.trim();
  let i = 0;
  while (i < s.length && !/\s/.test(s[i])) i++;
  const tag = stripNs(s.slice(0, i));
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  re.lastIndex = i;
  let m;
  while ((m = re.exec(s)) !== null) {
    const name = stripNs(m[1]);
    const value = m[2] !== undefined ? m[2] : m[3];
    attrs[name] = decodeXmlEntities(value);
  }
  return { tag, attrs };
}

export function parseXML(text) {
  if (!text) return null;
  if (text.charCodeAt(0) === BOM) text = text.slice(1);

  const root = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const len = text.length;
  let i = 0;

  while (i < len) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;

    // Text content between tags
    if (lt > i) {
      const chunk = text.slice(i, lt);
      const trimmed = chunk.trim();
      if (trimmed) {
        stack[stack.length - 1].text += decodeXmlEntities(chunk);
      }
    }

    // Comment
    if (text.substr(lt, 4) === '<!--') {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    // CDATA
    if (text.substr(lt, 9) === '<![CDATA[') {
      const end = text.indexOf(']]>', lt + 9);
      if (end < 0) break;
      stack[stack.length - 1].text += text.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    // DOCTYPE / other <! declaration
    if (text[lt + 1] === '!') {
      const end = text.indexOf('>', lt);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    // Processing instruction / XML declaration
    if (text[lt + 1] === '?') {
      const end = text.indexOf('?>', lt + 2);
      if (end < 0) break;
      i = end + 2;
      continue;
    }

    // Element tag — find closing '>' (naive; assumes no '>' inside quoted attrs)
    const gt = text.indexOf('>', lt);
    if (gt < 0) break;
    let inner = text.slice(lt + 1, gt);
    const isClose = inner[0] === '/';
    const isSelf = inner[inner.length - 1] === '/';
    if (isClose) inner = inner.slice(1);
    if (isSelf) inner = inner.slice(0, -1);

    if (isClose) {
      // Pop matching element
      const tagName = stripNs(inner.trim());
      for (let j = stack.length - 1; j > 0; j--) {
        if (stack[j].tag === tagName) { stack.length = j; break; }
      }
    } else {
      const { tag, attrs } = parseTagHeader(inner);
      const node = { tag, attrs, children: [], text: '' };
      stack[stack.length - 1].children.push(node);
      if (!isSelf) stack.push(node);
    }
    i = gt + 1;
  }

  // Return the first real element (skip the synthetic root)
  return root.children[0] || null;
}

/** Find the first descendant element with the given tag name. Depth-first. */
function findFirst(node, tag) {
  if (!node) return null;
  for (const c of node.children) {
    if (c.tag === tag) return c;
    const deep = findFirst(c, tag);
    if (deep) return deep;
  }
  return null;
}

/** Return all direct children with the given tag name. */
function childrenByTag(node, tag) {
  if (!node) return [];
  return node.children.filter(c => c.tag === tag);
}

// ─── GraphML parser ──────────────────────────────────────────────────────────

/**
 * Parse GraphML XML into {nodes, edges, extraPropNames}.
 * Supports the core GraphML subset: <key> declarations (for 'node' / 'all'),
 * <node id="..."> with <data key="..."> children, <edge source="..." target="..."/>,
 * and optional <data> on edges. Namespace prefixes are ignored.
 *
 * @param {string} text
 * @returns {{ nodes: Map, edges: Array, extraPropNames: string[] }}
 */
export function parseGraphML(text) {
  const root = parseXML(text);
  if (!root || root.tag !== 'graphml') {
    throw new Error('GraphML: root element is not <graphml>');
  }

  // Build key registry: keyId → { name, for }
  const keys = {};
  for (const k of childrenByTag(root, 'key')) {
    const id = k.attrs.id;
    if (!id) continue;
    keys[id] = {
      name: k.attrs['attr.name'] || id,
      for: k.attrs.for || 'all',
    };
  }

  const graph = findFirst(root, 'graph');
  if (!graph) throw new Error('GraphML: no <graph> element');

  const nodes = new Map();
  const extraPropSet = new Set();
  let anonCounter = 0;

  for (const nEl of childrenByTag(graph, 'node')) {
    const rawId = nEl.attrs.id;
    const id = (rawId != null && String(rawId).trim()) ? String(rawId) : `row_${anonCounter++}`;
    const extraProps = {};
    let label = null;
    let group = null;
    for (const d of childrenByTag(nEl, 'data')) {
      const k = keys[d.attrs.key];
      const name = k ? k.name : d.attrs.key;
      const value = d.text.trim();
      if (!name) continue;
      if (name === 'label' || name === 'name') label = label || value;
      else if (name === 'group' || name === 'category' || name === 'type' || name === 'class') group = group || value;
      else {
        extraProps[name] = value;
        extraPropSet.add(name);
      }
    }
    nodes.set(id, {
      label: label || id,
      group: group || 'unknown',
      extraProps,
    });
  }

  const edges = [];
  for (const eEl of childrenByTag(graph, 'edge')) {
    const src = eEl.attrs.source;
    const dst = eEl.attrs.target;
    if (src == null || dst == null) continue;
    const edge = { src: String(src), dst: String(dst) };
    // Optional edge data: take first 'type'/'label'/'relation' as the edge type
    for (const d of childrenByTag(eEl, 'data')) {
      const k = keys[d.attrs.key];
      const name = k ? k.name : d.attrs.key;
      if (name === 'type' || name === 'label' || name === 'relation') {
        edge.type = d.text.trim();
        break;
      }
    }
    edges.push(edge);
  }

  return { nodes, edges, extraPropNames: [...extraPropSet] };
}

// ─── GEXF parser ─────────────────────────────────────────────────────────────

/**
 * Parse GEXF XML into {nodes, edges, extraPropNames}.
 * Supports the core GEXF subset: <attributes class="node"> declarations with
 * <attribute id="..." title="..."/>, <nodes> with <node id="..." label="...">
 * containing <attvalues><attvalue for="..." value="..."/></attvalues>, and
 * <edges> with <edge source="..." target="..." label="..."/>.
 *
 * @param {string} text
 * @returns {{ nodes: Map, edges: Array, extraPropNames: string[] }}
 */
export function parseGEXF(text) {
  const root = parseXML(text);
  if (!root || root.tag !== 'gexf') {
    throw new Error('GEXF: root element is not <gexf>');
  }

  const graph = findFirst(root, 'graph');
  if (!graph) throw new Error('GEXF: no <graph> element');

  // Build attribute registry: attrId → title (only for class="node")
  const nodeAttrs = {};
  for (const attrBlock of childrenByTag(graph, 'attributes')) {
    if (attrBlock.attrs.class !== 'node' && attrBlock.attrs.class != null) continue;
    for (const a of childrenByTag(attrBlock, 'attribute')) {
      if (a.attrs.id != null) nodeAttrs[a.attrs.id] = a.attrs.title || a.attrs.id;
    }
  }

  const nodesEl = findFirst(graph, 'nodes');
  if (!nodesEl) throw new Error('GEXF: no <nodes> element');

  const nodes = new Map();
  const extraPropSet = new Set();
  let anonCounter = 0;

  for (const nEl of childrenByTag(nodesEl, 'node')) {
    const rawId = nEl.attrs.id;
    const id = (rawId != null && String(rawId).trim()) ? String(rawId) : `row_${anonCounter++}`;
    const label = nEl.attrs.label || id;
    const extraProps = {};
    let group = null;
    const attvalues = findFirst(nEl, 'attvalues');
    if (attvalues) {
      for (const av of childrenByTag(attvalues, 'attvalue')) {
        const forKey = av.attrs.for;
        const value = av.attrs.value;
        if (forKey == null || value == null) continue;
        const name = nodeAttrs[forKey] || forKey;
        if (name === 'group' || name === 'category' || name === 'type' || name === 'class') {
          group = group || value;
        } else {
          extraProps[name] = value;
          extraPropSet.add(name);
        }
      }
    }
    nodes.set(id, {
      label,
      group: group || 'unknown',
      extraProps,
    });
  }

  const edges = [];
  const edgesEl = findFirst(graph, 'edges');
  if (edgesEl) {
    for (const eEl of childrenByTag(edgesEl, 'edge')) {
      const src = eEl.attrs.source;
      const dst = eEl.attrs.target;
      if (src == null || dst == null) continue;
      const edge = { src: String(src), dst: String(dst) };
      if (eEl.attrs.label) edge.type = eEl.attrs.label;
      else if (eEl.attrs.kind) edge.type = eEl.attrs.kind;
      edges.push(edge);
    }
  }

  return { nodes, edges, extraPropNames: [...extraPropSet] };
}

// ─── Cytoscape JSON parser ───────────────────────────────────────────────────

/**
 * Parse Cytoscape.js JSON into {nodes, edges, extraPropNames}.
 * Supports both forms:
 *   { elements: { nodes: [...], edges: [...] } }  — grouped
 *   { elements: [...] }                           — flat array with `group: 'nodes'|'edges'`
 *
 * Each element has a `data: { id, source?, target?, ...extras }` object.
 *
 * @param {object} data
 * @returns {{ nodes: Map, edges: Array, extraPropNames: string[] }}
 */
export function parseCytoscape(data) {
  if (!data || !data.elements) throw new Error('Cytoscape: missing elements');

  let nodeList, edgeList;
  if (Array.isArray(data.elements)) {
    // Flat array form: each element has group: 'nodes' | 'edges'
    nodeList = data.elements.filter(el => el.group === 'nodes' || (el.data && el.data.source == null));
    edgeList = data.elements.filter(el => el.group === 'edges' || (el.data && el.data.source != null));
  } else {
    nodeList = Array.isArray(data.elements.nodes) ? data.elements.nodes : [];
    edgeList = Array.isArray(data.elements.edges) ? data.elements.edges : [];
  }

  const nodes = new Map();
  const extraPropSet = new Set();
  let anonCounter = 0;

  for (const el of nodeList) {
    const d = el.data || {};
    const rawId = d.id;
    const id = (rawId != null && String(rawId).trim()) ? String(rawId) : `row_${anonCounter++}`;
    const label = d.label || d.name || id;
    const group = d.group != null ? String(d.group) : 'unknown';
    const extraProps = {};
    for (const k in d) {
      if (k === 'id' || k === 'label' || k === 'group' || k === 'name' || k === 'source' || k === 'target') continue;
      const v = d[k];
      if (v === null || v === undefined) continue;
      extraProps[k] = typeof v === 'string' ? v : String(v);
      extraPropSet.add(k);
    }
    nodes.set(id, { label, group, extraProps });
  }

  const edges = [];
  for (const el of edgeList) {
    const d = el.data || {};
    if (d.source == null || d.target == null) continue;
    const edge = { src: String(d.source), dst: String(d.target) };
    const type = d.type || d.relation || d.label;
    if (type) edge.type = String(type);
    edges.push(edge);
  }

  return { nodes, edges, extraPropNames: [...extraPropSet] };
}

// ─── Format detection + dispatch ─────────────────────────────────────────────

/**
 * Sniff the input format from the text content and an optional filename hint.
 * Returns one of:
 *   'csv'         — delimited text (comma/tab/semicolon/pipe)
 *   'd3'          — D3 JSON with {nodes, links} or {nodes, edges}
 *   'd3-bare'     — bare JSON array of node objects
 *   'jgf'         — JSON Graph Format {graph: {...}} or {graphs: [...]}
 *   'cytoscape'   — Cytoscape JSON {elements: {nodes, edges}}
 *   'snap-edges'  — SNAP .edges (detected via filename hint)
 *   'snap-nodes'  — SNAP .nodes (detected via filename hint or # NodeId header)
 *   'snap'        — SNAP tab-delimited, ambiguous edges/nodes
 *   'graphml'     — GraphML XML
 *   'gexf'        — GEXF XML
 *   'xml'         — other XML (unsupported)
 *   'unknown'     — could not determine
 *
 * Filename hint takes precedence for SNAP variants since `.edges` and `.nodes`
 * can look structurally similar.
 *
 * @param {string} text
 * @param {string} [filenameHint]
 * @returns {string}
 */
export function detectFormat(text, filenameHint) {
  if (!text) return 'unknown';

  // Filename hint is authoritative for SNAP variants
  if (filenameHint) {
    const lower = String(filenameHint).toLowerCase();
    if (lower.endsWith('.edges') || lower.endsWith('.edges.gz')) return 'snap-edges';
    if (lower.endsWith('.nodes') || lower.endsWith('.nodes.gz') ||
        lower.endsWith('.labels') || lower.endsWith('.labels.gz')) return 'snap-nodes';
  }

  // Strip BOM + leading whitespace
  let s = text;
  if (s.charCodeAt(0) === BOM) s = s.slice(1);
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++;
  if (i >= s.length) return 'unknown';
  const first = s[i];

  // XML
  if (first === '<') {
    const snippet = s.slice(i, i + 500).toLowerCase();
    if (snippet.includes('<graphml')) return 'graphml';
    if (snippet.includes('<gexf')) return 'gexf';
    return 'xml';
  }

  // JSON
  if (first === '{' || first === '[') {
    let obj;
    try { obj = JSON.parse(s); } catch (_e) { return 'unknown'; }
    return detectJsonVariant(obj);
  }

  // SNAP .nodes header convention: "# NodeId\tLabel\tGroup..."
  // Check the header line before skipping past it.
  if (first === '#') {
    let headerEnd = s.indexOf('\n', i);
    if (headerEnd < 0) headerEnd = s.length;
    let headerLine = s.slice(i, headerEnd);
    if (headerLine.endsWith('\r')) headerLine = headerLine.slice(0, -1);
    if (headerLine.toLowerCase().includes('nodeid') && headerLine.includes('\t')) return 'snap-nodes';
  }

  // Find first non-comment, non-empty line for delimiter counting
  let lineStart = i;
  let dataLine = '';
  while (lineStart < s.length) {
    let eol = s.indexOf('\n', lineStart);
    if (eol < 0) eol = s.length;
    let line = s.slice(lineStart, eol);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    lineStart = eol + 1;
    if (line.length === 0) continue;
    if (line.charCodeAt(0) === 35) continue; // '#' comment
    dataLine = line;
    break;
  }
  if (!dataLine) return first === '#' ? 'snap' : 'unknown';

  // Count delimiters in the first data line (respect quoted CSV fields)
  let inQuotes = false;
  let tabs = 0, commas = 0, semis = 0, pipes = 0;
  for (let j = 0; j < dataLine.length; j++) {
    const ch = dataLine[j];
    if (ch === '"') {
      if (inQuotes && dataLine[j + 1] === '"') { j++; continue; }
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (ch === '\t') tabs++;
    else if (ch === ',') commas++;
    else if (ch === ';') semis++;
    else if (ch === '|') pipes++;
  }

  // Tab-dominant and no other delimiters → likely SNAP
  if (tabs > 0 && commas === 0 && semis === 0 && pipes === 0) return 'snap';
  // Any structured delimiter → CSV (parseCSV will auto-detect which one)
  if (commas > 0 || semis > 0 || pipes > 0 || tabs > 0) return 'csv';
  return 'unknown';
}

function detectJsonVariant(obj) {
  if (Array.isArray(obj)) return 'd3-bare';
  if (!obj || typeof obj !== 'object') return 'unknown';
  // STIX 2.x bundle: {type: "bundle", objects: [...]} or plain {objects: [...]}
  if (obj.type === 'bundle' || (Array.isArray(obj.objects) && obj.objects.length > 0 && obj.objects[0].type)) return 'stix';
  // JGF first (most specific). JGF v1 allows graph.nodes as either array or dict.
  const hasJgfNodes = (g) => g && g.nodes != null && (Array.isArray(g.nodes) || typeof g.nodes === 'object');
  if (obj.graph && hasJgfNodes(obj.graph)) return 'jgf';
  if (Array.isArray(obj.graphs) && obj.graphs.length > 0 && hasJgfNodes(obj.graphs[0])) return 'jgf';
  // Cytoscape
  if (obj.elements && (Array.isArray(obj.elements.nodes) || Array.isArray(obj.elements.edges))) return 'cytoscape';
  // Cytoscape flat array form: {elements: [{group: 'nodes', data: {...}}, ...]}
  if (Array.isArray(obj.elements) && obj.elements.length > 0 && obj.elements[0].data) return 'cytoscape';
  // D3
  if (Array.isArray(obj.nodes) && (Array.isArray(obj.links) || Array.isArray(obj.edges))) return 'd3';
  if (Array.isArray(obj.nodes)) return 'd3';
  return 'unknown';
}

// ─── Format classification and capability exports ───────────────────────────

/** Formats that parseAny returns as parsed {nodes, edges, extraPropNames} objects,
 *  suitable for runPipelineFromObjects. */
export const OBJECT_FORMATS = new Set([
  'csv', 'd3', 'd3-bare', 'jgf', 'graphml', 'gexf', 'cytoscape', 'stix', 'snap-nodes',
]);

/** Formats that go through the SNAP text worker pipeline (two-file workflow). */
export const TEXT_FORMATS = new Set(['snap-edges', 'snap']);

/** Reserved for future special-case formats. Empty after STIX was inlined. */
export const SPECIAL_FORMATS = new Set();

/** All file extensions the parsers recognize, for HTML <input accept="..."> and
 *  drop-zone filtering. Detection from content is the authoritative dispatch,
 *  but this list gives the native file picker something to filter on. */
export const FILE_EXTENSIONS = [
  '.csv', '.tsv', '.csv.gz', '.tsv.gz',
  '.json', '.json.gz',
  '.graphml', '.graphml.gz',
  '.gexf', '.gexf.gz',
  '.xml', '.xml.gz',
  '.edges', '.edges.gz',
  '.nodes', '.nodes.gz',
  '.labels', '.labels.gz',
  '.txt', '.gz',
];

export const FILE_ACCEPT_ATTR = FILE_EXTENSIONS.join(',');

/** True if the format can be parsed into the unified object shape by parseAny. */
export function isObjectFormat(format) { return OBJECT_FORMATS.has(format); }
/** True if the format needs the SNAP two-file text-worker pipeline. */
export function isTextFormat(format) { return TEXT_FORMATS.has(format); }
/** True if the format requires a special converter (STIX). */
export function isSpecialFormat(format) { return SPECIAL_FORMATS.has(format); }

/**
 * Unified parser dispatch. Sniffs the format and returns a uniform shape
 * compatible with runPipelineFromObjects.
 *
 * Supported (returns parsed result):
 *   - CSV / TSV / SSV
 *   - D3 JSON ({nodes, links}) and bare array form
 *   - JGF ({graph: {nodes, edges}})
 *   - SNAP .nodes (nodes-only, edgeless)
 *
 * Throws for:
 *   - SNAP .edges (use two-file workflow or existing text pipeline)
 *   - GraphML, GEXF, Cytoscape, generic XML (not yet supported)
 *   - Unknown formats
 *
 * @param {string} text
 * @param {string} [filenameHint] - original filename for tiebreaking SNAP variants
 * @returns {{ nodes: Map, edges: Array|null, extraPropNames: string[], format: string }}
 */
export function parseAny(text, filenameHint) {
  const format = detectFormat(text, filenameHint);
  switch (format) {
    case 'csv': {
      const { nodes, extraPropNames } = parseCSVToNodes(text);
      return { nodes, edges: null, extraPropNames, format };
    }
    case 'd3': {
      const data = JSON.parse(text);
      return { ...parseD3(data), format };
    }
    case 'd3-bare': {
      const arr = JSON.parse(text);
      return { ...parseD3({ nodes: arr, links: [] }), format };
    }
    case 'jgf': {
      const data = JSON.parse(text);
      return { ...parseJGF(data), format };
    }
    case 'snap-nodes': {
      const { nodes, extraPropNames } = parseNodesFile(text);
      return { nodes, edges: null, extraPropNames, format };
    }
    case 'snap-edges':
    case 'snap':
      throw new Error(`SNAP edges/ambiguous format: use parseEdgesFile/parseNodesFile directly or provide both files`);
    case 'cytoscape': {
      const data = JSON.parse(text);
      return { ...parseCytoscape(data), format };
    }
    case 'stix': {
      const data = JSON.parse(text);
      const { nodes, edges, extraPropNames } = parseSTIX(data);
      return { nodes, edges, extraPropNames, format };
    }
    case 'graphml':
      return { ...parseGraphML(text), format };
    case 'gexf':
      return { ...parseGEXF(text), format };
    case 'xml':
      throw new Error('Unknown XML format (expected <graphml> or <gexf> root)');
    default:
      throw new Error('Unknown format: could not detect input type');
  }
}

// ─── File utilities (shared by bz-graph and viewer) ─────────────────────────

/** Read a File object as text, transparently decompressing .gz files. */
export async function readFileText(file) {
  if (file.name.endsWith('.gz')) {
    const buf = await file.arrayBuffer();
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(new Uint8Array(buf));
    writer.close();
    const reader = ds.readable.getReader();
    const chunks = [];
    while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
    const merged = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    return new TextDecoder().decode(merged);
  }
  return await file.text();
}

/** Classify an array of dropped/selected Files by format.
 *  Returns { edgesText, nodesText, parsed, fileName }.
 *  - SNAP .edges/.nodes go to edgesText/nodesText (text pipeline)
 *  - CSV/JSON/GraphML/GEXF/STIX go through parseAny → parsed (object pipeline)
 */
export async function classifyFiles(files) {
  let edgesText = null, nodesText = null, parsed = null, fileName = null;
  for (const f of files) {
    const text = await readFileText(f);
    const name = f.name;
    const format = detectFormat(text, name);
    const baseName = name
      .replace(/\.(csv|tsv|json|edges|nodes|labels|txt|graphml|gexf|xml|gz)$/gi, '')
      .replace(/\.(csv|tsv|json|edges|nodes|labels|txt|graphml|gexf|xml)$/gi, '');

    if (format === 'snap-edges' || (format === 'snap' && name.toLowerCase().match(/\.edges/))) {
      edgesText = text;
      fileName = baseName;
    } else if (format === 'snap-nodes' || name.toLowerCase().match(/\.(nodes|labels)/)) {
      nodesText = text;
    } else if (isObjectFormat(format)) {
      try {
        parsed = parseAny(text, name);
        fileName = baseName;
      } catch (e) {
        console.warn(`[classifyFiles] Failed to parse ${name}: ${e.message}`);
      }
    } else if (format === 'snap') {
      edgesText = text;
      fileName = baseName;
    } else {
      console.warn(`[classifyFiles] Unknown format for ${name}`);
    }
  }
  return { edgesText, nodesText, parsed, fileName };
}
