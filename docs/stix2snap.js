// stix2snap.js — Parse STIX 2.1 bundle JSON into the unified object pipeline shape.
// Browser-compatible, no DOM. Exports parseSTIX(data) returning
// { nodes: Map, edges: Array, extraPropNames: string[], stats }.

const clean = (s) => s.replace(/[\t\n\r]/g, ' ').trim();

function truncate(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}

function nodeLabel(obj) {
  if (obj.name) return obj.name;
  if (obj.value) return obj.value;
  if (obj.pattern) return truncate(obj.pattern, 80);
  if (obj.description) return truncate(obj.description, 80);
  if (obj.type === 'file' && obj.name) return obj.name;
  if (obj.type === 'email-message') return String(obj.subject || obj.message_id || obj.id);
  if (obj.type === 'user-account') return String(obj.account_login || obj.user_id || obj.id);
  if (obj.type === 'windows-registry-key') return String(obj.key || obj.id);
  return obj.id;
}

function subType(obj) {
  for (const field of [
    'threat_actor_types', 'malware_types', 'tool_types',
    'infrastructure_types', 'indicator_types', 'report_types',
  ]) {
    const v = obj[field];
    if (Array.isArray(v) && v.length > 0) return v.join(',');
  }
  for (const field of ['identity_class', 'pattern_type', 'context', 'opinion', 'result']) {
    const v = obj[field];
    if (typeof v === 'string' && v) return v;
  }
  if (obj.type === 'location') {
    const parts = [obj.region, obj.country].filter(Boolean);
    if (parts.length > 0) return parts.join(',');
  }
  return '';
}

function killChain(obj) {
  const phases = obj.kill_chain_phases;
  if (!Array.isArray(phases) || phases.length === 0) return '';
  return phases.map(p => p.phase_name || '').filter(Boolean).join(',');
}

function aliases(obj) {
  const a = obj.aliases;
  if (Array.isArray(a) && a.length > 0) return a.join(',');
  return '';
}

function sophisticationLevel(obj) {
  const parts = [];
  if (obj.sophistication) parts.push(String(obj.sophistication));
  if (obj.resource_level) parts.push(String(obj.resource_level));
  if (obj.is_family !== undefined) parts.push(obj.is_family ? 'family' : 'instance');
  return parts.join(',');
}

function platforms(obj) {
  const p = obj.x_mitre_platforms;
  if (Array.isArray(p) && p.length > 0) return p.join(',');
  return '';
}

const SINGLE_REF_FIELDS = {
  'created_by_ref': 'created_by', 'sample_ref': 'sample_of',
  'sighting_of_ref': 'sighting_of', 'parent_ref': 'parent_of',
  'src_ref': 'traffic_from', 'dst_ref': 'traffic_to',
  'from_ref': 'email_from', 'sender_ref': 'email_sender',
  'raw_email_ref': 'raw_email', 'content_ref': 'content_of',
  'image_ref': 'image_of', 'host_vm_ref': 'host_vm',
  'operating_system_ref': 'runs_on', 'installed_software_refs': 'installed',
  'creator_user_ref': 'created_by_user', 'service_dll_refs': 'service_dll',
  'opened_connection_refs': 'opened_connection', 'child_refs': 'child_of',
  'body_raw_ref': 'body_of', 'resolves_to_refs': 'resolves_to',
  'belongs_to_ref': 'belongs_to', 'encapsulates_by_ref': 'encapsulated_by',
  'encapsulated_by_ref': 'encapsulated_by',
};

const ARRAY_REF_FIELDS = {
  'object_refs': 'object', 'observed_data_refs': 'observed_data',
  'where_sighted_refs': 'sighted_at', 'sample_refs': 'sample_of',
  'to_refs': 'email_to', 'cc_refs': 'email_cc', 'bcc_refs': 'email_bcc',
  'child_refs': 'child_of', 'opened_connection_refs': 'opened_connection',
  'service_dll_refs': 'service_dll', 'resolves_to_refs': 'resolves_to',
  'contains_refs': 'contains', 'values_refs': 'registry_value',
  'body_multipart': 'body_part',
};

/**
 * Parse a STIX 2.1 bundle into the unified object pipeline shape.
 * @param {object|string} input — already-parsed bundle object, or raw JSON string
 * @returns {{ nodes: Map, edges: Array<{src,dst,type}>, extraPropNames: string[], stats: object }}
 * @throws {Error} if input is not a valid STIX 2.1 bundle
 */
export function parseSTIX(input) {
  const bundle = typeof input === 'string' ? JSON.parse(input) : input;

  // Accept both { type: 'bundle', objects: [...] } and raw arrays of objects
  let objects;
  if (bundle && bundle.type === 'bundle' && Array.isArray(bundle.objects)) {
    objects = bundle.objects;
  } else if (Array.isArray(bundle)) {
    objects = bundle;
  } else if (bundle && Array.isArray(bundle.objects)) {
    objects = bundle.objects;
  } else {
    throw new Error('Input is not a STIX 2.1 bundle (expected { type: "bundle", objects: [...] })');
  }

  const SKIP_TYPES = new Set(['marking-definition']);

  const allById = new Map();
  for (const obj of objects) allById.set(obj.id, obj);

  const nodeMap = new Map();
  const sroList = [];

  for (const obj of objects) {
    if (SKIP_TYPES.has(obj.type)) continue;
    if (obj.type === 'relationship' || obj.type === 'sighting') sroList.push(obj);
    nodeMap.set(obj.id, obj);
  }

  const edges = [];

  function ensureNode(id) {
    if (nodeMap.has(id)) return;
    const obj = allById.get(id);
    if (obj && !SKIP_TYPES.has(obj.type)) nodeMap.set(id, obj);
    else if (!obj) nodeMap.set(id, { type: 'unknown', id, name: id });
  }

  // Explicit relationships and sightings
  for (const sro of sroList) {
    if (sro.type === 'relationship' && sro.source_ref && sro.target_ref) {
      ensureNode(sro.source_ref);
      ensureNode(sro.target_ref);
      edges.push({ src: sro.source_ref, dst: sro.target_ref, type: sro.relationship_type ?? 'related-to' });
    }
    if (sro.type === 'sighting') {
      if (sro.sighting_of_ref) {
        ensureNode(sro.sighting_of_ref);
        edges.push({ src: sro.id, dst: sro.sighting_of_ref, type: 'sighting_of' });
      }
      if (Array.isArray(sro.observed_data_refs)) {
        for (const ref of sro.observed_data_refs) { ensureNode(ref); edges.push({ src: sro.id, dst: ref, type: 'observed_data' }); }
      }
      if (Array.isArray(sro.where_sighted_refs)) {
        for (const ref of sro.where_sighted_refs) { ensureNode(ref); edges.push({ src: sro.id, dst: ref, type: 'sighted_at' }); }
      }
    }
  }

  // Implicit refs from all node objects
  for (const obj of nodeMap.values()) {
    if (obj.type === 'relationship' || obj.type === 'sighting') continue;
    for (const [field, edgeType] of Object.entries(SINGLE_REF_FIELDS)) {
      const ref = obj[field];
      if (typeof ref === 'string' && ref.includes('--')) {
        ensureNode(ref);
        edges.push({ src: obj.id, dst: ref, type: edgeType });
      }
    }
    for (const [field, edgeType] of Object.entries(ARRAY_REF_FIELDS)) {
      const refs = obj[field];
      if (!Array.isArray(refs)) continue;
      for (const ref of refs) {
        if (typeof ref !== 'string' || !ref.includes('--')) continue;
        const target = allById.get(ref);
        if (target && target.type === 'relationship') {
          if (target.source_ref) { ensureNode(target.source_ref); edges.push({ src: obj.id, dst: target.source_ref, type: `${edgeType}_via_${target.relationship_type || 'rel'}` }); }
          if (target.target_ref) { ensureNode(target.target_ref); edges.push({ src: obj.id, dst: target.target_ref, type: `${edgeType}_via_${target.relationship_type || 'rel'}` }); }
        } else {
          ensureNode(ref);
          edges.push({ src: obj.id, dst: ref, type: edgeType });
        }
      }
    }
    // Kill chain phase nodes
    const phases = obj.kill_chain_phases;
    if (Array.isArray(phases)) {
      for (const phase of phases) {
        if (phase.phase_name) {
          const kcId = `kill-chain--${(phase.kill_chain_name || 'unknown').replace(/\s+/g, '-')}--${phase.phase_name.replace(/\s+/g, '-')}`;
          if (!nodeMap.has(kcId)) nodeMap.set(kcId, { type: 'kill-chain-phase', id: kcId, name: `${phase.phase_name} (${phase.kill_chain_name || 'unknown'})` });
          edges.push({ src: obj.id, dst: kcId, type: 'kill_chain_phase' });
        }
      }
    }
  }

  // Remove unreferenced relationship/sighting nodes
  const referencedIds = new Set();
  for (const e of edges) { referencedIds.add(e.src); referencedIds.add(e.dst); }
  for (const [id, obj] of nodeMap) {
    if ((obj.type === 'relationship' || obj.type === 'sighting') && !referencedIds.has(id)) nodeMap.delete(id);
  }

  // Deduplicate edges
  const edgeSet = new Set();
  const dedupEdges = [];
  for (const e of edges) {
    if (!nodeMap.has(e.src) || !nodeMap.has(e.dst)) continue;
    const key = `${e.src}\t${e.dst}\t${e.type}`;
    if (!edgeSet.has(key)) { edgeSet.add(key); dedupEdges.push(e); }
  }

  // Build object-pipeline output
  const nodes = new Map();
  const extraPropSet = new Set();
  for (const [id, obj] of nodeMap) {
    const extraProps = {};
    const addExtra = (name, value) => {
      const v = clean(value || '');
      if (v) { extraProps[name] = v; extraPropSet.add(name); }
    };
    addExtra('subtype', subType(obj));
    addExtra('killchain', killChain(obj));
    addExtra('aliases', aliases(obj));
    addExtra('level', sophisticationLevel(obj));
    addExtra('platforms', platforms(obj));
    nodes.set(id, {
      label: truncate(clean(nodeLabel(obj)), 80),
      group: obj.type,
      extraProps,
    });
  }

  const types = {};
  for (const obj of nodeMap.values()) types[obj.type] = (types[obj.type] || 0) + 1;

  return {
    nodes,
    edges: dedupEdges,
    extraPropNames: [...extraPropSet],
    stats: { nodes: nodeMap.size, edges: dedupEdges.length, types },
  };
}
