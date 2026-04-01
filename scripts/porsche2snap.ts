#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Convert automobile-models-and-specs Porsche data to SNAP format.
 *
 * Nodes = Porsche model variants with specs (one node per model, using primary engine)
 * Edges = shared model line (911↔911), shared generation, shared engine layout
 *
 * Expects automobiles.csv and engines.csv in data/raw/porsche/
 * (from https://github.com/ilyasozkurt/automobile-models-and-specs)
 *
 * Usage: deno run --allow-read --allow-write scripts/porsche2snap.ts [output-prefix]
 */

const prefix = Deno.args[0] || "docs/data/porsche";
const RAW = "data/raw/porsche";

// ─── CSV parser ─────────────────────────────────────────────────────────────

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split("\n");
  if (lines.length < 2) return [];
  const headers: string[] = [];
  // Parse header
  const hdr = lines[0];
  let cur = "", inQ = false;
  for (let i = 0; i < hdr.length; i++) {
    const ch = hdr[i];
    if (inQ) { if (ch === '"') { if (hdr[i+1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch; }
    else { if (ch === '"') inQ = true; else if (ch === ',') { headers.push(cur); cur = ""; } else cur += ch; }
  }
  headers.push(cur.replace(/\r$/, ""));

  const rows: Record<string, string>[] = [];
  for (let li = 1; li < lines.length; li++) {
    const line = lines[li];
    if (!line.trim()) continue;
    const fields: string[] = [];
    cur = ""; inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) { if (ch === '"') { if (line[i+1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch; }
      else { if (ch === '"') inQ = true; else if (ch === ',') { fields.push(cur); cur = ""; } else cur += ch; }
    }
    fields.push(cur.replace(/\r$/, ""));
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = fields[j] || "";
    rows.push(row);
  }
  return rows;
}

// ─── Load data ──────────────────────────────────────────────────────────────

console.log("Loading automobiles...");
const autos = parseCsv(Deno.readTextFileSync(`${RAW}/automobiles.csv`));
console.log("Loading engines...");
const engines = parseCsv(Deno.readTextFileSync(`${RAW}/engines.csv`));

// Find Porsche models (image field has the actual model name in this dataset)
const porscheAutos = autos.filter(r =>
  (r.name + r.image).toLowerCase().includes("porsche")
);
console.log(`Porsche models: ${porscheAutos.length}`);

// Index engines by automobile_id — keep the one with most HP
const engineByAuto = new Map<string, { name: string; specs: Record<string, Record<string, string>> }>();
for (const e of engines) {
  if (!porscheAutos.some(a => a.id === e.automobile_id)) continue;
  let specs: Record<string, Record<string, string>> = {};
  try { specs = JSON.parse(e.specs); } catch { continue; }

  const existing = engineByAuto.get(e.automobile_id);
  if (!existing) {
    engineByAuto.set(e.automobile_id, { name: e.name, specs });
  } else {
    // Keep higher-HP variant
    const newHp = parseHp(specs);
    const oldHp = parseHp(existing.specs);
    if (newHp > oldHp) {
      engineByAuto.set(e.automobile_id, { name: e.name, specs });
    }
  }
}

function parseHp(specs: Record<string, Record<string, string>>): number {
  const power = specs["Engine Specs"]?.["Power:"] || specs["Engine Specs"]?.["Total Maximum Power:"] || "";
  const match = power.match(/(\d+)\s*Hp/i);
  return match ? parseInt(match[1]) : 0;
}

function parseNum(s: string | undefined, pattern: RegExp): number {
  if (!s) return 0;
  const m = s.match(pattern);
  return m ? parseFloat(m[1]) : 0;
}

// ─── Build nodes ────────────────────────────────────────────────────────────

interface PNode {
  id: string;
  label: string;
  modelLine: string;
  generation: string;
  bodyType: string;
  engineType: string;
  drivetrain: string;
  hp: number;
  topSpeed: number;
  accel060: number;
  weight: number;
  year: number;
}

// Extract model line and body type from name
function parseModelName(raw: string): { label: string; line: string; generation: string; body: string; year: number } {
  const clean = raw.replace(/&amp;/g, "&").replace(/\s*Photos.*$/, "").trim();
  // Extract year — may be at start ("2025 Porsche 911") or at end ("PORSCHE 911 (992) 2020-Present")
  let year = 0;
  let rest = clean;
  const yearStartMatch = clean.match(/^(\d{4})\s+(?:Porsche\s+)?(.*)$/i);
  const yearEndMatch = clean.match(/(\d{4})-(?:Present|\d{4})\s*$/);
  if (yearStartMatch) {
    year = parseInt(yearStartMatch[1]);
    rest = yearStartMatch[2];
  } else if (yearEndMatch) {
    year = parseInt(yearEndMatch[1]);
    rest = clean.replace(/\s*\d{4}-(?:Present|\d{4})\s*$/, "");
  }
  // Strip "PORSCHE" / "Porsche" prefix
  rest = rest.replace(/^PORSCHE\s+/i, "").trim();
  // Strip generation codes in parens: "(992)", "(95B)", "(PO536)"
  rest = rest.replace(/\s*\([A-Z0-9.]+\)\s*/g, " ").trim();

  // Model line
  let line = "other";
  for (const l of ["Carrera GT", "918 Spyder", "911", "718", "Cayenne", "Macan", "Panamera", "Taycan", "Boxster", "Cayman", "928", "944", "968", "959", "356"]) {
    if (rest.startsWith(l)) { line = l; break; }
  }
  // Merge 718 Boxster/Cayman into 718
  if (line === "Boxster" || line === "Cayman") line = "718";

  // Body type
  let body = "coupe";
  const lower = rest.toLowerCase();
  if (lower.includes("cabriolet") || lower.includes("cabrio") || lower.includes("speedster") || lower.includes("spyder")) body = "convertible";
  else if (lower.includes("targa")) body = "targa";
  else if (lower.includes("sport turismo") || lower.includes("cross turismo") || lower.includes("shooting brake")) body = "wagon";
  else if (line === "Cayenne" || line === "Macan") body = "suv";
  else if (line === "Panamera") body = "sedan";

  // Generation from year
  let gen = "";
  if (line === "911") {
    if (year >= 2019) gen = "992";
    else if (year >= 2012) gen = "991";
    else if (year >= 2005) gen = "997";
    else if (year >= 1998) gen = "996";
    else if (year >= 1994) gen = "993";
    else if (year >= 1989) gen = "964";
    else if (year >= 1974) gen = "G";
    else gen = "classic";
  } else if (line === "Cayenne") {
    if (year >= 2024) gen = "E3.2";
    else if (year >= 2018) gen = "E3";
    else if (year >= 2011) gen = "958";
    else gen = "955";
  } else if (line === "Panamera") {
    if (year >= 2024) gen = "972.2";
    else if (year >= 2017) gen = "971";
    else gen = "970";
  } else if (line === "Macan") {
    if (year >= 2024) gen = "EV";
    else gen = "95B";
  } else if (line === "Taycan") {
    gen = year >= 2025 ? "J1.2" : "J1";
  } else if (line === "718") {
    gen = year >= 2016 ? "982" : "981";
  }

  return { label: clean, line, generation: gen, body, year };
}

const nodes: PNode[] = [];
const nodeIds = new Set<string>();

for (const auto of porscheAutos) {
  const engine = engineByAuto.get(auto.id);
  if (!engine) continue;

  const specs = engine.specs;
  const es = specs["Engine Specs"] || {};
  const ps = specs["Performance Specs"] || {};
  const ws = specs["Weight Specs"] || {};
  const ts = specs["Transmission Specs"] || {};

  const { label, line, generation, body, year } = parseModelName(auto.image || auto.name);
  const id = label.replace(/\t/g, " ");

  // Skip exact duplicates
  if (nodeIds.has(id)) continue;
  nodeIds.add(id);

  // Engine type
  const fuel = (es["Fuel:"] || "").toLowerCase();
  const cylinders = es["Cylinders:"] || "";
  let engineType = "unknown";
  if (fuel.includes("electric")) engineType = "electric";
  else if (fuel.includes("hybrid") || es["Electrical Motor Power:"]) engineType = "hybrid";
  else if (cylinders.includes("H6") || cylinders.includes("flat") || cylinders.toLowerCase().includes("boxer")) engineType = "flat-6";
  else if (cylinders.includes("6")) engineType = "6-cyl";
  else if (cylinders.includes("V8") || cylinders.includes("8")) engineType = "V8";
  else if (cylinders.includes("V10") || cylinders.includes("10")) engineType = "V10";
  else if (cylinders.includes("4")) engineType = "4-cyl";
  else engineType = cylinders || "unknown";

  const hp = parseHp(specs);
  const topSpeed = parseNum(ps["Top Speed:"] || ps["Top Speed (Electrical):"], /(\d+)\s*Mph/i);
  const accel = parseNum(ps["Acceleration 0-62 Mph (0-100 Kph):"], /([\d.]+)\s*S/i);
  const weight = parseNum(ws["Unladen Weight:"], /(\d+)\s*Lbs/i);
  const drivetrain = (ts["Drive Type:"] || "").replace(/ Drive$/, "") || "";

  nodes.push({
    id, label: label, modelLine: line, generation, bodyType: body,
    engineType, drivetrain, hp, topSpeed, accel060: accel, weight, year,
  });
}

console.log(`Nodes: ${nodes.length}`);

// ─── Build edges ────────────────────────────────────────────────────────────

interface Edge { src: string; dst: string; type: string; }
const edges: Edge[] = [];
const edgeSet = new Set<string>();

function addEdge(a: string, b: string, type: string) {
  if (a === b) return;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const key = `${lo}\t${hi}`;
  if (edgeSet.has(key)) return;
  edgeSet.add(key);
  edges.push({ src: lo, dst: hi, type });
}

// Same model line + generation = sibling (strongest connection)
// Same model line, different generation = lineage
for (let i = 0; i < nodes.length; i++) {
  for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j];
    if (a.modelLine === b.modelLine && a.generation === b.generation && a.generation) {
      addEdge(a.id, b.id, "sibling");
    } else if (a.modelLine === b.modelLine && a.generation !== b.generation && a.generation && b.generation) {
      // Only connect adjacent generations
      const yearDiff = Math.abs(a.year - b.year);
      if (yearDiff <= 3) {
        addEdge(a.id, b.id, "lineage");
      }
    }
  }
}

// Platform sharing: 718 and 911 share some tech
for (const a of nodes) {
  for (const b of nodes) {
    if (a.id >= b.id) continue;
    if (a.modelLine === "718" && b.modelLine === "911" && Math.abs(a.year - b.year) <= 1) {
      addEdge(a.id, b.id, "platform");
    }
    if (a.modelLine === "Cayenne" && b.modelLine === "Macan" && Math.abs(a.year - b.year) <= 1) {
      addEdge(a.id, b.id, "platform");
    }
  }
}

console.log(`Edges: ${edges.length}`);

// ─── Write .edges ───────────────────────────────────────────────────────────

const edgeLines = [
  "# Porsche model variant network",
  `# Nodes: ${nodes.length} Edges: ${edges.length}`,
  "# FromId\tToId\tEdgeType",
];
for (const e of edges) edgeLines.push(`${e.src}\t${e.dst}\t${e.type}`);
Deno.writeTextFileSync(prefix + ".edges", edgeLines.join("\n") + "\n");

// ─── Write .nodes ───────────────────────────────────────────────────────────

const nodeLines = [
  "# NodeId\tLabel\tGroup\tGeneration\tBody\tEngine\tDrivetrain\tHP\tTopSpeed\t0-60\tWeight\tYear",
];
for (const n of nodes) {
  nodeLines.push([
    n.id, n.label, n.modelLine, n.generation, n.bodyType, n.engineType,
    n.drivetrain, n.hp || "", n.topSpeed || "", n.accel060 || "", n.weight || "", n.year || "",
  ].join("\t"));
}
Deno.writeTextFileSync(prefix + ".nodes", nodeLines.join("\n") + "\n");

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\nWrote ${prefix}.edges (${edges.length} edges)`);
console.log(`Wrote ${prefix}.nodes (${nodes.length} nodes)`);

const count = (arr: string[]) => {
  const c: Record<string, number> = {};
  for (const v of arr) c[v || "(empty)"] = (c[v || "(empty)"] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1]);
};

console.log("\nModel lines:");
for (const [k, v] of count(nodes.map(n => n.modelLine))) console.log(`  ${String(v).padStart(4)}  ${k}`);

console.log("\nEngine types:");
for (const [k, v] of count(nodes.map(n => n.engineType))) console.log(`  ${String(v).padStart(4)}  ${k}`);

console.log("\nBody types:");
for (const [k, v] of count(nodes.map(n => n.bodyType))) console.log(`  ${String(v).padStart(4)}  ${k}`);

console.log("\nEdge types:");
for (const [k, v] of count(edges.map(e => e.type))) console.log(`  ${String(v).padStart(4)}  ${k}`);
