#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Convert an OpenCTI CSV export (semicolon-delimited) to SNAP .edges and .labels.
 *
 * Builds a container-only graph:
 *   - Nodes = Report/Grouping rows from the CSV (with all their rich properties)
 *   - Edges = Jaccard similarity of shared entity references between containers
 *     (weighted, with edge type indicating overlap strength)
 *
 * This avoids flooding the graph with anonymous UUID entities that have no
 * metadata in the CSV export.
 *
 * Labels columns: NodeId, Label, Group, CreatedBy, Marking, ReportType,
 *                 Tags, Published, Confidence, EntityCount
 *
 * Usage: deno run --allow-read --allow-write csv2snap.ts <input.csv> [output-prefix]
 */

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ";") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

const clean = (s: string) => s.replace(/[\t\n\r]/g, " ").trim();

function main() {
  const args = Deno.args;
  if (args.length < 1) {
    console.error("Usage: csv2snap.ts <input.csv> [output-prefix]");
    Deno.exit(1);
  }

  const inputPath = args[0];
  const prefix = args[1] ?? inputPath.replace(/\.csv$/i, "");

  const raw = Deno.readTextFileSync(inputPath);
  const lines = raw.split("\n").filter(l => l.trim());
  if (lines.length < 2) {
    console.error("Error: CSV has no data rows");
    Deno.exit(1);
  }

  const headers = parseCsvLine(lines[0]);
  const colIdx: Record<string, number> = {};
  headers.forEach((h, i) => colIdx[h] = i);

  for (const col of ["id", "entity_type", "name"]) {
    if (!(col in colIdx)) {
      console.error(`Error: missing column "${col}"`);
      Deno.exit(1);
    }
  }

  function field(fields: string[], col: string): string {
    return col in colIdx ? (fields[colIdx[col]] || "").trim() : "";
  }

  // Parse rows
  interface Row {
    id: string;
    name: string;
    entityType: string;
    refs: Set<string>;
    confidence: string;
    createdBy: string;
    objectMarking: string;
    reportTypes: string;
    tags: string[];
    published: string;
  }

  const rows: Row[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const id = field(fields, "id");
    if (!id) continue;

    const refsStr = field(fields, "objectsIds");
    const refs = new Set(refsStr ? refsStr.split(",").map(r => r.trim()).filter(r => r) : []);
    const rawLabels = field(fields, "objectLabel");
    const tags = rawLabels ? rawLabels.split(",").map(l => l.trim()).filter(l => l) : [];
    const objectMarking = (field(fields, "objectMarking").split(",")[0] || "").trim();
    const reportTypes = (field(fields, "report_types").split(",")[0] || "").trim();
    const published = field(fields, "published").slice(0, 7); // YYYY-MM for grouping

    rows.push({
      id,
      name: field(fields, "name") || id,
      entityType: field(fields, "entity_type") || "unknown",
      refs,
      confidence: field(fields, "confidence"),
      createdBy: field(fields, "createdBy"),
      objectMarking,
      reportTypes,
      tags,
      published,
    });
  }

  // Build inverted index: entity → set of container indices
  const entityToRows = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    for (const ref of rows[i].refs) {
      if (!entityToRows.has(ref)) entityToRows.set(ref, []);
      entityToRows.get(ref)!.push(i);
    }
  }

  // Compute pairwise Jaccard similarity — only for pairs sharing >= 1 entity.
  // Use inverted index to avoid O(n²) all-pairs comparison.
  interface Edge { src: string; dst: string; type: string; jaccard: number }
  const edgeMap = new Map<string, { overlap: number; aSize: number; bSize: number; ai: number; bi: number }>();

  for (const [_entity, rowIdxs] of entityToRows) {
    // Skip entities in too many containers (ubiquitous = noise)
    if (rowIdxs.length > rows.length * 0.7) continue;

    for (let x = 0; x < rowIdxs.length; x++) {
      for (let y = x + 1; y < rowIdxs.length; y++) {
        const ai = rowIdxs[x], bi = rowIdxs[y];
        const key = ai < bi ? `${ai}:${bi}` : `${bi}:${ai}`;
        if (!edgeMap.has(key)) {
          edgeMap.set(key, { overlap: 0, aSize: rows[ai].refs.size, bSize: rows[bi].refs.size, ai, bi });
        }
        edgeMap.get(key)!.overlap++;
      }
    }
  }

  const edges: Edge[] = [];
  for (const [_key, v] of edgeMap) {
    const union = v.aSize + v.bSize - v.overlap;
    const jaccard = union > 0 ? v.overlap / union : 0;
    if (jaccard < 0.02) continue; // skip very weak overlap

    let type: string;
    if (jaccard >= 0.5) type = "strong-overlap";
    else if (jaccard >= 0.15) type = "overlap";
    else type = "weak-overlap";

    edges.push({ src: rows[v.ai].id, dst: rows[v.bi].id, type, jaccard });
  }

  // Also add tag-based edges: containers sharing 3+ tags are related
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].tags.length === 0) continue;
    const setA = new Set(rows[i].tags);
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j].tags.length === 0) continue;
      let shared = 0;
      for (const t of rows[j].tags) if (setA.has(t)) shared++;
      if (shared >= 3) {
        const key = `${rows[i].id}\t${rows[j].id}\ttag-overlap`;
        if (!edges.some(e => e.src === rows[i].id && e.dst === rows[j].id && e.type === 'tag-overlap')) {
          edges.push({ src: rows[i].id, dst: rows[j].id, type: "tag-overlap", jaccard: shared / (setA.size + rows[j].tags.length - shared) });
        }
      }
    }
  }

  // Write .edges
  const edgeLines: string[] = [];
  edgeLines.push(`# OpenCTI CSV export — container similarity graph`);
  edgeLines.push(`# Source: ${inputPath}`);
  edgeLines.push(`# Nodes: ${rows.length} Edges: ${edges.length}`);
  edgeLines.push(`# FromId\tToId\tRelationshipType`);
  for (const e of edges) {
    edgeLines.push(`${e.src}\t${e.dst}\t${e.type}`);
  }
  const edgesPath = prefix + ".edges";
  Deno.writeTextFileSync(edgesPath, edgeLines.join("\n") + "\n");

  // Write .labels
  const labelLines: string[] = [];
  labelLines.push(`# NodeId\tLabel\tGroup\tCreatedBy\tMarking\tReportType\tTags\tPublished\tConfidence\tEntityCount`);

  for (const r of rows) {
    const label = truncate(clean(r.name), 80);
    const tags = r.tags.slice(0, 8).join(",");
    labelLines.push([
      r.id,
      label,
      r.entityType,
      clean(r.createdBy),
      clean(r.objectMarking),
      clean(r.reportTypes),
      clean(tags),
      r.published,
      r.confidence,
      String(r.refs.size),
    ].join("\t"));
  }

  const labelsPath = prefix + ".labels";
  Deno.writeTextFileSync(labelsPath, labelLines.join("\n") + "\n");

  // Summary
  console.log(`Wrote ${edgesPath} (${edges.length} edges)`);
  console.log(`Wrote ${labelsPath} (${rows.length} nodes)`);
  console.log();

  const edgeTypeCounts: Record<string, number> = {};
  for (const e of edges) edgeTypeCounts[e.type] = (edgeTypeCounts[e.type] || 0) + 1;
  for (const [t, c] of Object.entries(edgeTypeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(c).padStart(5)}  ${t}`);
  }

  // Source breakdown
  console.log();
  const srcCounts: Record<string, number> = {};
  for (const r of rows) srcCounts[r.createdBy || "(none)"] = (srcCounts[r.createdBy || "(none)"] || 0) + 1;
  console.log("Sources:");
  for (const [s, c] of Object.entries(srcCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(c).padStart(4)}  ${s}`);
  }
}

main();
