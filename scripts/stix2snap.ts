#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Convert a STIX 2.1 bundle JSON to SNAP-style .edges and .labels files.
 *
 * Handles all STIX 2.1 object types:
 *   SDOs: attack-pattern, campaign, course-of-action, grouping, identity,
 *         indicator, infrastructure, intrusion-set, location, malware,
 *         malware-analysis, note, observed-data, opinion, report,
 *         threat-actor, tool, vulnerability
 *   SROs: relationship, sighting
 *   SCOs: ipv4-addr, ipv6-addr, domain-name, url, file, email-message,
 *         network-traffic, process, user-account, artifact, directory,
 *         windows-registry-key, etc.
 *
 * Edge extraction:
 *   - Explicit relationship objects (source_ref → target_ref)
 *   - Sighting objects (sighting_of_ref, observed_data_refs, where_sighted_refs)
 *   - Container refs (object_refs in report, grouping, opinion, note)
 *   - Implicit refs: created_by_ref, sample_ref, parent_ref, src_ref, dst_ref,
 *     from_ref, sender_ref, raw_email_ref, etc.
 *   - Container→relationship resolution (report→rel→target chains)
 *
 * Label columns: NodeId, Label, Group, SubType, KillChain, Aliases, Level
 *
 * Usage: deno run --allow-read --allow-write stix2snap.ts <input.json> [output-prefix]
 */

interface StixObject {
  type: string;
  id: string;
  name?: string;
  value?: string;
  pattern?: string;
  description?: string;
  relationship_type?: string;
  source_ref?: string;
  target_ref?: string;
  [key: string]: unknown;
}

interface StixBundle {
  type: "bundle";
  objects: StixObject[];
}

const clean = (s: string) => s.replace(/[\t\n\r]/g, " ").trim();

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

function nodeLabel(obj: StixObject): string {
  if (obj.name) return obj.name;
  if (obj.value) return obj.value;
  if (obj.pattern) return truncate(obj.pattern, 80);
  if (obj.description) return truncate(obj.description, 80);
  // SCOs: try common identifying fields
  if (obj.type === "file" && obj.name) return obj.name;
  if (obj.type === "email-message") return String(obj.subject || obj.message_id || obj.id);
  if (obj.type === "user-account") return String(obj.account_login || obj.user_id || obj.id);
  if (obj.type === "windows-registry-key") return String(obj.key || obj.id);
  return obj.id;
}

// Extract type-specific classification
function subType(obj: StixObject): string {
  for (const field of [
    "threat_actor_types", "malware_types", "tool_types",
    "infrastructure_types", "indicator_types", "report_types",
  ]) {
    const v = obj[field];
    if (Array.isArray(v) && v.length > 0) return v.join(",");
  }
  for (const field of ["identity_class", "pattern_type", "context", "opinion", "result"]) {
    const v = obj[field];
    if (typeof v === "string" && v) return v;
  }
  // Location: region/country
  if (obj.type === "location") {
    const parts = [obj.region, obj.country].filter(Boolean);
    if (parts.length > 0) return parts.join(",");
  }
  return "";
}

// Extract kill chain phases
function killChain(obj: StixObject): string {
  const phases = obj.kill_chain_phases;
  if (!Array.isArray(phases) || phases.length === 0) return "";
  return phases.map((p: { phase_name?: string }) => p.phase_name || "").filter(Boolean).join(",");
}

function aliases(obj: StixObject): string {
  const a = obj.aliases;
  if (Array.isArray(a) && a.length > 0) return a.join(",");
  return "";
}

function sophisticationLevel(obj: StixObject): string {
  const parts: string[] = [];
  if (obj.sophistication) parts.push(String(obj.sophistication));
  if (obj.resource_level) parts.push(String(obj.resource_level));
  if (obj.is_family !== undefined) parts.push(obj.is_family ? "family" : "instance");
  return parts.join(",");
}

function platforms(obj: StixObject): string {
  const p = obj.x_mitre_platforms;
  if (Array.isArray(p) && p.length > 0) return p.join(",");
  return "";
}

// All known single-ref fields across all STIX 2.1 types
const SINGLE_REF_FIELDS: Record<string, string> = {
  "created_by_ref": "created_by",
  "sample_ref": "sample_of",
  "sighting_of_ref": "sighting_of",
  "parent_ref": "parent_of",
  "src_ref": "traffic_from",
  "dst_ref": "traffic_to",
  "from_ref": "email_from",
  "sender_ref": "email_sender",
  "raw_email_ref": "raw_email",
  "content_ref": "content_of",
  "image_ref": "image_of",
  "host_vm_ref": "host_vm",
  "operating_system_ref": "runs_on",
  "installed_software_refs": "installed",
  "creator_user_ref": "created_by_user",
  "service_dll_refs": "service_dll",
  "opened_connection_refs": "opened_connection",
  "child_refs": "child_of",
  "body_raw_ref": "body_of",
  "resolves_to_refs": "resolves_to",
  "belongs_to_ref": "belongs_to",
  "encapsulates_by_ref": "encapsulated_by",
  "encapsulated_by_ref": "encapsulated_by",
};

// All known array-ref fields
const ARRAY_REF_FIELDS: Record<string, string> = {
  "object_refs": "object",
  "observed_data_refs": "observed_data",
  "where_sighted_refs": "sighted_at",
  "sample_refs": "sample_of",
  "to_refs": "email_to",
  "cc_refs": "email_cc",
  "bcc_refs": "email_bcc",
  "child_refs": "child_of",
  "opened_connection_refs": "opened_connection",
  "service_dll_refs": "service_dll",
  "resolves_to_refs": "resolves_to",
  "contains_refs": "contains",
  "values_refs": "registry_value",
  "body_multipart": "body_part", // special handling
};

function main() {
  const args = Deno.args;
  if (args.length < 1) {
    console.error("Usage: stix2snap.ts <input.json> [output-prefix]");
    Deno.exit(1);
  }

  const inputPath = args[0];
  const prefix = args[1] ?? inputPath.replace(/\.json$/i, "");

  const raw = Deno.readTextFileSync(inputPath);
  const bundle: StixBundle = JSON.parse(raw);

  if (bundle.type !== "bundle" || !Array.isArray(bundle.objects)) {
    console.error("Error: input is not a STIX 2.1 bundle");
    Deno.exit(1);
  }

  const SKIP_TYPES = new Set(["marking-definition"]);
  const objects = bundle.objects;

  // Index all objects by id
  const allById = new Map<string, StixObject>();
  for (const obj of objects) {
    allById.set(obj.id, obj);
  }

  // Nodes: everything except marking-definitions
  // Relationships and sightings go to both edges AND nodes (they can be referenced)
  const nodeMap = new Map<string, StixObject>();
  const sroList: StixObject[] = []; // relationships + sightings

  for (const obj of objects) {
    if (SKIP_TYPES.has(obj.type)) continue;
    if (obj.type === "relationship" || obj.type === "sighting") {
      sroList.push(obj);
    }
    nodeMap.set(obj.id, obj);
  }

  // Collect all edges
  interface Edge { src: string; dst: string; type: string }
  const edges: Edge[] = [];

  function ensureNode(id: string) {
    if (nodeMap.has(id)) return;
    const obj = allById.get(id);
    if (obj && !SKIP_TYPES.has(obj.type)) {
      nodeMap.set(id, obj);
    } else if (!obj) {
      nodeMap.set(id, { type: "unknown", id, name: id });
    }
  }

  // 1. Explicit relationships and sightings
  for (const sro of sroList) {
    if (sro.type === "relationship" && sro.source_ref && sro.target_ref) {
      ensureNode(sro.source_ref);
      ensureNode(sro.target_ref);
      edges.push({
        src: sro.source_ref,
        dst: sro.target_ref,
        type: sro.relationship_type ?? "related-to",
      });
    }
    if (sro.type === "sighting") {
      const sightingOf = sro.sighting_of_ref as string | undefined;
      if (sightingOf) {
        ensureNode(sightingOf);
        edges.push({ src: sro.id, dst: sightingOf, type: "sighting_of" });
      }
      // observed_data_refs
      const obsRefs = sro.observed_data_refs as string[] | undefined;
      if (obsRefs) {
        for (const ref of obsRefs) {
          ensureNode(ref);
          edges.push({ src: sro.id, dst: ref, type: "observed_data" });
        }
      }
      // where_sighted_refs
      const whereRefs = sro.where_sighted_refs as string[] | undefined;
      if (whereRefs) {
        for (const ref of whereRefs) {
          ensureNode(ref);
          edges.push({ src: sro.id, dst: ref, type: "sighted_at" });
        }
      }
    }
  }

  // 2. Implicit refs from all node objects
  for (const obj of nodeMap.values()) {
    // Skip SROs — already handled above
    if (obj.type === "relationship" || obj.type === "sighting") continue;

    // Single refs
    for (const [field, edgeType] of Object.entries(SINGLE_REF_FIELDS)) {
      const ref = obj[field];
      if (typeof ref === "string" && ref.includes("--")) {
        ensureNode(ref);
        edges.push({ src: obj.id, dst: ref, type: edgeType });
      }
    }

    // Array refs
    for (const [field, edgeType] of Object.entries(ARRAY_REF_FIELDS)) {
      const refs = obj[field];
      if (!Array.isArray(refs)) continue;
      for (const ref of refs) {
        if (typeof ref !== "string" || !ref.includes("--")) continue;
        // Resolve container→relationship refs
        const target = allById.get(ref);
        if (target && target.type === "relationship") {
          // Create edges through the relationship to both endpoints
          if (target.source_ref) {
            ensureNode(target.source_ref);
            edges.push({ src: obj.id, dst: target.source_ref, type: `${edgeType}_via_${target.relationship_type || "rel"}` });
          }
          if (target.target_ref) {
            ensureNode(target.target_ref);
            edges.push({ src: obj.id, dst: target.target_ref, type: `${edgeType}_via_${target.relationship_type || "rel"}` });
          }
        } else {
          ensureNode(ref);
          edges.push({ src: obj.id, dst: ref, type: edgeType });
        }
      }
    }

    // Kill chain phases create edges to synthetic kill-chain nodes
    const phases = obj.kill_chain_phases;
    if (Array.isArray(phases)) {
      for (const phase of phases) {
        const p = phase as { kill_chain_name?: string; phase_name?: string };
        if (p.phase_name) {
          const kcId = `kill-chain--${(p.kill_chain_name || "unknown").replace(/\s+/g, "-")}--${p.phase_name.replace(/\s+/g, "-")}`;
          if (!nodeMap.has(kcId)) {
            nodeMap.set(kcId, {
              type: "kill-chain-phase",
              id: kcId,
              name: `${p.phase_name} (${p.kill_chain_name || "unknown"})`,
            });
          }
          edges.push({ src: obj.id, dst: kcId, type: "kill_chain_phase" });
        }
      }
    }

    // External references: extract technique IDs as metadata but don't create nodes
    // (external-ref nodes add noise — they have no properties and dominate the graph)
  }

  // Remove relationship/sighting nodes that have no refs pointing TO them
  // (they're edges, not meaningful standalone nodes, unless referenced by a container)
  const referencedIds = new Set<string>();
  for (const e of edges) {
    referencedIds.add(e.src);
    referencedIds.add(e.dst);
  }
  for (const [id, obj] of nodeMap) {
    if ((obj.type === "relationship" || obj.type === "sighting") && !referencedIds.has(id)) {
      nodeMap.delete(id);
    }
  }

  // Deduplicate edges
  const edgeSet = new Set<string>();
  const dedupEdges: Edge[] = [];
  for (const e of edges) {
    if (!nodeMap.has(e.src) || !nodeMap.has(e.dst)) continue;
    const key = `${e.src}\t${e.dst}\t${e.type}`;
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      dedupEdges.push(e);
    }
  }

  // Write .edges
  const edgeLines: string[] = [];
  edgeLines.push(`# STIX 2.1 bundle converted to SNAP format`);
  edgeLines.push(`# Source: ${inputPath}`);
  edgeLines.push(`# Nodes: ${nodeMap.size} Edges: ${dedupEdges.length}`);
  edgeLines.push(`# FromId\tToId\tRelationshipType`);
  for (const e of dedupEdges) {
    edgeLines.push(`${e.src}\t${e.dst}\t${e.type}`);
  }

  const edgesPath = prefix + ".edges";
  Deno.writeTextFileSync(edgesPath, edgeLines.join("\n") + "\n");

  // Write .labels
  const labelLines: string[] = [];
  labelLines.push(`# NodeId\tLabel\tGroup\tSubType\tKillChain\tAliases\tLevel\tPlatforms`);
  for (const [id, obj] of nodeMap) {
    const label = truncate(clean(nodeLabel(obj)), 80);
    const group = obj.type;
    const st = clean(subType(obj));
    const kc = clean(killChain(obj));
    const al = clean(aliases(obj));
    const lvl = clean(sophisticationLevel(obj));
    const plat = clean(platforms(obj));
    labelLines.push(`${id}\t${label}\t${group}\t${st}\t${kc}\t${al}\t${lvl}\t${plat}`);
  }

  const labelsPath = prefix + ".labels";
  Deno.writeTextFileSync(labelsPath, labelLines.join("\n") + "\n");

  // Summary
  console.log(`Wrote ${edgesPath} (${dedupEdges.length} edges)`);
  console.log(`Wrote ${labelsPath} (${nodeMap.size} nodes)`);
  console.log();
  const typeCounts: Record<string, number> = {};
  for (const obj of nodeMap.values()) typeCounts[obj.type] = (typeCounts[obj.type] || 0) + 1;
  for (const [t, c] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(c).padStart(4)}  ${t}`);
  }
  console.log();
  const edgeTypeCounts: Record<string, number> = {};
  for (const e of dedupEdges) edgeTypeCounts[e.type] = (edgeTypeCounts[e.type] || 0) + 1;
  for (const [t, c] of Object.entries(edgeTypeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(c).padStart(4)}  ${t}`);
  }
}

main();
