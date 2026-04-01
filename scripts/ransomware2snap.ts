#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net
/**
 * Convert ransomware.live JSON data to a heterogeneous SNAP graph.
 *
 * Node types: ransomware group, sector, country, victim (organization).
 * Edge types: ATTACKED, IN_SECTOR, IN_COUNTRY, LINEAGE, DUPLICATE_CLAIM,
 *             TARGETS_SECTOR, TARGETS_COUNTRY.
 *
 * Data is fetched from data.ransomware.live or read from local files.
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-net scripts/ransomware2snap.ts [output-prefix]
 *   deno run --allow-read --allow-write scripts/ransomware2snap.ts --local groups.json victims.json [output-prefix]
 */

const clean = (s: string) => s.replace(/[\t\n\r]/g, " ").trim();

interface Group {
  name: string;
  altname?: string | null;
  lineage?: string | null;
  date?: string | null;
  meta?: string | null;
  type?: { raas?: boolean } | null;
  _victim_count?: number;
}

interface Victim {
  post_title: string;
  group_name: string;
  discovered: string;
  published: string;
  country: string;
  activity: string;
  website: string;
  duplicates?: { group: string; date: string }[];
}

async function loadJSON(url: string, localPath?: string): Promise<unknown> {
  if (localPath) {
    console.error(`Reading ${localPath}...`);
    return JSON.parse(await Deno.readTextFile(localPath));
  }
  console.error(`Fetching ${url}...`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  return resp.json();
}

function safeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_").toLowerCase();
}

// Country code → name mapping (common ones)
const COUNTRY_NAMES: Record<string, string> = {
  US: "United States", GB: "United Kingdom", DE: "Germany", FR: "France",
  CA: "Canada", AU: "Australia", IT: "Italy", ES: "Spain", BR: "Brazil",
  NL: "Netherlands", IN: "India", JP: "Japan", MX: "Mexico", SE: "Sweden",
  CH: "Switzerland", BE: "Belgium", AT: "Austria", PL: "Poland", NO: "Norway",
  DK: "Denmark", FI: "Finland", IE: "Ireland", PT: "Portugal", NZ: "New Zealand",
  SG: "Singapore", KR: "South Korea", TW: "Taiwan", IL: "Israel", ZA: "South Africa",
  AR: "Argentina", CL: "Chile", CO: "Colombia", PE: "Peru", TH: "Thailand",
  MY: "Malaysia", PH: "Philippines", ID: "Indonesia", AE: "UAE", SA: "Saudi Arabia",
  TR: "Turkey", RU: "Russia", CN: "China", HK: "Hong Kong", CZ: "Czech Republic",
  RO: "Romania", HU: "Hungary", GR: "Greece", HR: "Croatia", SK: "Slovakia",
  BG: "Bulgaria", RS: "Serbia", UA: "Ukraine", LT: "Lithuania", LV: "Latvia",
  EE: "Estonia", SI: "Slovenia", LU: "Luxembourg", MT: "Malta", CY: "Cyprus",
  EC: "Ecuador", VE: "Venezuela", CR: "Costa Rica", PA: "Panama", DO: "Dominican Republic",
  GT: "Guatemala", UY: "Uruguay", BO: "Bolivia", PY: "Paraguay", TT: "Trinidad and Tobago",
  KE: "Kenya", NG: "Nigeria", EG: "Egypt", MA: "Morocco", TN: "Tunisia",
  GH: "Ghana", BD: "Bangladesh", PK: "Pakistan", LK: "Sri Lanka", VN: "Vietnam",
};

function countryName(code: string): string {
  return COUNTRY_NAMES[code] || code;
}

// ─── Build heterogeneous graph ────────────────────────────────────────────────

function buildGraph(groups: Group[], victims: Victim[], prefix: string) {
  const groupSet = new Set<string>();
  const groupInfo = new Map<string, Group>();
  for (const g of groups) {
    groupSet.add(g.name);
    groupInfo.set(g.name, g);
  }

  // Collect sectors and countries from victims
  const sectorCounts = new Map<string, number>();
  const countryCounts = new Map<string, number>();
  const groupVictimCount = new Map<string, number>();
  const groupTopSector = new Map<string, string>();
  const groupTopCountry = new Map<string, string>();
  const groupSectors = new Map<string, Map<string, number>>();
  const groupCountries = new Map<string, Map<string, number>>();

  for (const v of victims) {
    if (v.activity) sectorCounts.set(v.activity, (sectorCounts.get(v.activity) || 0) + 1);
    if (v.country) countryCounts.set(v.country, (countryCounts.get(v.country) || 0) + 1);
    const g = v.group_name;
    if (groupSet.has(g)) {
      groupVictimCount.set(g, (groupVictimCount.get(g) || 0) + 1);
      if (v.activity) {
        if (!groupSectors.has(g)) groupSectors.set(g, new Map());
        const m = groupSectors.get(g)!;
        m.set(v.activity, (m.get(v.activity) || 0) + 1);
      }
      if (v.country) {
        if (!groupCountries.has(g)) groupCountries.set(g, new Map());
        const m = groupCountries.get(g)!;
        m.set(v.country, (m.get(v.country) || 0) + 1);
      }
    }
  }

  // Compute top sector/country per group
  for (const [g, m] of groupSectors) {
    let best = "", bestN = 0;
    for (const [k, n] of m) if (n > bestN) { best = k; bestN = n; }
    groupTopSector.set(g, best);
  }
  for (const [g, m] of groupCountries) {
    let best = "", bestN = 0;
    for (const [k, n] of m) if (n > bestN) { best = k; bestN = n; }
    groupTopCountry.set(g, best);
  }

  // Determine which sectors/countries to include as nodes (filter noise)
  const sectors = [...sectorCounts.entries()].filter(([, n]) => n >= 3).map(([s]) => s);
  const countries = [...countryCounts.entries()].filter(([, n]) => n >= 3).map(([c]) => c);
  const sectorSet = new Set(sectors);
  const countrySet = new Set(countries);

  // ─── Edges ───
  const edges: string[] = [];
  edges.push("# Ransomware ecosystem graph from ransomware.live");
  edges.push("# FromId\tToId\tEdgeType");

  // Group lineage
  for (const g of groups) {
    if (g.lineage && groupSet.has(g.lineage)) {
      edges.push(`g_${safeId(g.name)}\tg_${safeId(g.lineage)}\tLINEAGE`);
    }
  }

  // Group → sector (TARGETS_SECTOR for groups with ≥ 5 victims in a sector)
  for (const [g, m] of groupSectors) {
    for (const [sector, count] of m) {
      if (count >= 5 && sectorSet.has(sector)) {
        edges.push(`g_${safeId(g)}\ts_${safeId(sector)}\tTARGETS_SECTOR`);
      }
    }
  }

  // Group → country (TARGETS_COUNTRY for groups with ≥ 5 victims in a country)
  for (const [g, m] of groupCountries) {
    for (const [country, count] of m) {
      if (count >= 5 && countrySet.has(country)) {
        edges.push(`g_${safeId(g)}\tc_${safeId(country)}\tTARGETS_COUNTRY`);
      }
    }
  }

  // Victim → group (ATTACKED), victim → sector, victim → country
  let vidx = 0;
  for (const v of victims) {
    const vid = `v_${vidx++}`;
    if (groupSet.has(v.group_name)) {
      edges.push(`g_${safeId(v.group_name)}\t${vid}\tATTACKED`);
    }
    if (v.activity && sectorSet.has(v.activity)) {
      edges.push(`${vid}\ts_${safeId(v.activity)}\tIN_SECTOR`);
    }
    if (v.country && countrySet.has(v.country)) {
      edges.push(`${vid}\tc_${safeId(v.country)}\tIN_COUNTRY`);
    }
  }

  // Duplicate claims
  vidx = 0;
  for (const v of victims) {
    const vid = `v_${vidx++}`;
    if (!v.duplicates?.length) continue;
    for (const d of v.duplicates) {
      if (groupSet.has(d.group)) {
        edges.push(`g_${safeId(d.group)}\t${vid}\tDUPLICATE_CLAIM`);
      }
    }
  }

  // ─── Nodes ───
  const nodes: string[] = [];
  nodes.push("# NodeId\tLabel\tGroup\tRaaS\tVictims\tTopSector\tTopCountry\tYear");

  // Group nodes
  for (const g of groups) {
    const id = `g_${safeId(g.name)}`;
    const label = clean(g.name);
    const raas = g.type?.raas ? "RaaS" : "independent";
    const vc = groupVictimCount.get(g.name) || 0;
    const ts = groupTopSector.get(g.name) || "";
    const tc = groupTopCountry.get(g.name) || "";
    const year = g.date ? g.date.slice(0, 4) : "";
    nodes.push(`${id}\t${label}\tgang\t${raas}\t${vc}\t${clean(ts)}\t${tc}\t${year}`);
  }

  // Sector nodes
  for (const sector of sectors) {
    const id = `s_${safeId(sector)}`;
    const vc = sectorCounts.get(sector) || 0;
    nodes.push(`${id}\t${clean(sector)}\tsector\t\t${vc}\t${clean(sector)}\t\t`);
  }

  // Country nodes
  for (const country of countries) {
    const id = `c_${safeId(country)}`;
    const label = countryName(country);
    const vc = countryCounts.get(country) || 0;
    nodes.push(`${id}\t${label}\tcountry\t\t${vc}\t\t${country}\t`);
  }

  // Victim nodes
  vidx = 0;
  for (const v of victims) {
    const vid = `v_${vidx++}`;
    const label = clean(v.post_title).slice(0, 60) || vid;
    const sector = clean(v.activity || "");
    const country = v.country || "";
    const year = v.discovered?.slice(0, 4) || v.published?.slice(0, 4) || "";
    nodes.push(`${vid}\t${label}\tvictim\t\t\t${sector}\t${country}\t${year}`);
  }

  const edgesPath = prefix + ".edges";
  const nodesPath = prefix + ".nodes";
  Deno.writeTextFileSync(edgesPath, edges.join("\n") + "\n");
  Deno.writeTextFileSync(nodesPath, nodes.join("\n") + "\n");

  const nodeCount = groups.length + sectors.length + countries.length + victims.length;
  const edgeCount = edges.length - 2;
  console.error(`Wrote ${nodeCount} nodes (${groups.length} gangs, ${sectors.length} sectors, ${countries.length} countries, ${victims.length} victims)`);
  console.error(`  ${edgeCount} edges`);
  console.error(`  → ${edgesPath}`);
  console.error(`  → ${nodesPath}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const args = [...Deno.args];
const isLocal = args.includes("--local");
const positional = args.filter(a => !a.startsWith("--"));

let groupsJson: Group[];
let victimsJson: Victim[];

if (isLocal) {
  const groupsFile = positional[0];
  const victimsFile = positional[1];
  if (!groupsFile || !victimsFile) {
    console.error("Usage: ransomware2snap.ts [--local groups.json victims.json] [output-prefix]");
    Deno.exit(1);
  }
  groupsJson = await loadJSON("", groupsFile) as Group[];
  victimsJson = await loadJSON("", victimsFile) as Victim[];
} else {
  groupsJson = await loadJSON("https://data.ransomware.live/groups.json") as Group[];
  victimsJson = await loadJSON("https://data.ransomware.live/victims.json") as Victim[];
}

console.error(`Loaded ${groupsJson.length} groups, ${victimsJson.length} victims`);

const prefix = (isLocal ? positional[2] : positional[0]) || "ransomware";

buildGraph(groupsJson, victimsJson, prefix);
