#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Generate a SNAP graph from the BitZoom source code.
 *
 * Nodes = files, functions, classes, constants, methods
 * Edges = defines (file→symbol), calls (symbol→symbol), imports (file→file)
 *
 * Usage: deno run --allow-read --allow-write src2snap.ts [output-prefix]
 */

import { walk } from "https://deno.land/std/fs/walk.ts";

const prefix = Deno.args[0] || "data/bitzoom-source";

interface Symbol {
  id: string;
  name: string;
  kind: string;    // file, function, class, method, constant, variable
  file: string;    // which file it's in
  line: number;
  size: number;    // lines of code (approx)
  bytes: number;   // file size in bytes (0 for non-file symbols)
  ageHours: number; // age of file in hours (from mtime)
}

interface Edge {
  src: string;
  dst: string;
  type: string;
}

const symbols: Map<string, Symbol> = new Map();
const edges: Edge[] = [];
const edgeSet = new Set<string>();

function addSymbol(s: Symbol) {
  symbols.set(s.id, s);
}

function addEdge(src: string, dst: string, type: string) {
  const key = `${src}\t${dst}\t${type}`;
  if (edgeSet.has(key)) return;
  edgeSet.add(key);
  edges.push({ src, dst, type });
}

// Scan extensions
const EXTENSIONS = new Set([".js", ".ts", ".css", ".html", ".json", ".md"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "stix", "tmp"]);

// Collect all project files
const files: { path: string; relPath: string; content: string; ext: string }[] = [];

for await (const entry of walk(".", {
  includeDirs: false,
  skip: [...SKIP_DIRS].map(d => new RegExp(`(^|/)${d}(/|$)`)),
})) {
  const ext = entry.path.slice(entry.path.lastIndexOf("."));
  if (!EXTENSIONS.has(ext)) continue;
  // Skip data files
  if (entry.path.startsWith("data/")) continue;

  const relPath = entry.path.startsWith("./") ? entry.path.slice(2) : entry.path;
  const content = Deno.readTextFileSync(entry.path);
  files.push({ path: entry.path, relPath, content, ext });
}

// Create file nodes
for (const f of files) {
  const lines = f.content.split("\n").length;
  const bytes = new TextEncoder().encode(f.content).length;
  const stat = Deno.statSync(f.path);
  const ageHours = stat.mtime ? Math.round((Date.now() - stat.mtime.getTime()) / 3600000) : 0;
  const dir = f.relPath.includes("/") ? f.relPath.slice(0, f.relPath.lastIndexOf("/")) : ".";
  addSymbol({
    id: `file:${f.relPath}`,
    name: f.relPath,
    kind: "file",
    file: dir,
    line: 0,
    size: lines,
    bytes,
    ageHours,
  });
}

// Parse JS/TS files for symbols
for (const f of files) {
  if (f.ext !== ".js" && f.ext !== ".ts") continue;
  const fileId = `file:${f.relPath}`;
  const lines = f.content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Top-level functions: function name(
    const funcMatch = line.match(/^(?:export\s+)?function\s+(\w+)\s*\(/);
    if (funcMatch) {
      // Count lines until next top-level function/class/const or EOF
      let end = i + 1;
      while (end < lines.length && !lines[end].match(/^(?:export\s+)?(?:function|class|const|let|var)\s+\w/)) end++;
      const id = `fn:${f.relPath}:${funcMatch[1]}`;
      addSymbol({ id, name: funcMatch[1], kind: "function", file: f.relPath, line: i + 1, size: end - i, bytes: 0, ageHours: 0 });
      addEdge(fileId, id, "defines");
      continue;
    }

    // Class: class Name
    const classMatch = line.match(/^(?:export\s+)?class\s+(\w+)/);
    if (classMatch) {
      let end = i + 1;
      let braceDepth = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
      while (end < lines.length && braceDepth > 0) {
        braceDepth += (lines[end].match(/{/g) || []).length;
        braceDepth -= (lines[end].match(/}/g) || []).length;
        end++;
      }
      const id = `class:${f.relPath}:${classMatch[1]}`;
      addSymbol({ id, name: classMatch[1], kind: "class", file: f.relPath, line: i + 1, size: end - i, bytes: 0, ageHours: 0 });
      addEdge(fileId, id, "defines");

      // Parse methods inside the class
      for (let j = i + 1; j < end; j++) {
        const methodMatch = lines[j].match(/^\s+(?:async\s+)?(?:get\s+|set\s+)?(\w+)\s*\(/);
        if (methodMatch && methodMatch[1] !== "if" && methodMatch[1] !== "for" && methodMatch[1] !== "while" && methodMatch[1] !== "switch" && methodMatch[1] !== "return" && methodMatch[1] !== "new") {
          let mEnd = j + 1;
          let mDepth = (lines[j].match(/{/g) || []).length - (lines[j].match(/}/g) || []).length;
          while (mEnd < end && mDepth > 0) {
            mDepth += (lines[mEnd].match(/{/g) || []).length;
            mDepth -= (lines[mEnd].match(/}/g) || []).length;
            mEnd++;
          }
          const mId = `method:${f.relPath}:${classMatch[1]}.${methodMatch[1]}`;
          addSymbol({ id: mId, name: `${classMatch[1]}.${methodMatch[1]}`, kind: "method", file: f.relPath, line: j + 1, size: mEnd - j, bytes: 0, ageHours: 0 });
          addEdge(id, mId, "has_method");
        }
      }
      i = end - 1;
      continue;
    }

    // Top-level const/let/var: const NAME = ...
    const constMatch = line.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/);
    if (constMatch) {
      // Check if it's a significant constant (ALL_CAPS or multi-line)
      const isConst = constMatch[1] === constMatch[1].toUpperCase() && constMatch[1].length > 2;
      const isMultiLine = !line.includes(";");
      if (isConst || isMultiLine) {
        let end = i + 1;
        if (isMultiLine) {
          let braceDepth = (line.match(/[[{(]/g) || []).length - (line.match(/[\]})/]/g) || []).length;
          while (end < lines.length && braceDepth > 0) {
            braceDepth += (lines[end].match(/[[{(]/g) || []).length;
            braceDepth -= (lines[end].match(/[\]})/]/g) || []).length;
            end++;
          }
        }
        const id = `const:${f.relPath}:${constMatch[1]}`;
        addSymbol({ id, name: constMatch[1], kind: "constant", file: f.relPath, line: i + 1, size: end - i, bytes: 0, ageHours: 0 });
        addEdge(fileId, id, "defines");
      }
    }
  }
}

// Parse deno.json for tasks
for (const f of files) {
  if (f.relPath !== "deno.json") continue;
  const fileId = `file:${f.relPath}`;
  try {
    const json = JSON.parse(f.content);
    if (json.tasks) {
      for (const [taskName, cmd] of Object.entries(json.tasks)) {
        const id = `task:${taskName}`;
        addSymbol({ id, name: taskName, kind: "task", file: f.relPath, line: 0, size: 1, bytes: 0, ageHours: 0 });
        addEdge(fileId, id, "defines");
        // Link task → script file it runs
        const fileMatch = String(cmd).match(/(?:scripts|tests)\/\S+\.(?:ts|js)/);
        if (fileMatch) {
          const targetId = `file:${fileMatch[0]}`;
          if (symbols.has(targetId)) addEdge(id, targetId, "runs");
        }
      }
    }
    if (json.imports) {
      for (const [specifier, _target] of Object.entries(json.imports)) {
        const id = `import:${specifier}`;
        addSymbol({ id, name: specifier, kind: "import-map", file: f.relPath, line: 0, size: 1, bytes: 0, ageHours: 0 });
        addEdge(fileId, id, "defines");
      }
    }
  } catch { /* not valid JSON */ }
}

// Parse HTML files for elements and structure
for (const f of files) {
  if (f.ext !== ".html") continue;
  const fileId = `file:${f.relPath}`;
  const lines = f.content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Elements with id attributes
    const idMatches = line.matchAll(/id=["']([^"']+)["']/g);
    for (const m of idMatches) {
      const elemId = m[1];
      // Determine tag name
      const tagMatch = line.match(/<(\w+)[^>]*id=["']/ + elemId);
      const tag = line.match(/<(\w+)/)?.[1] || "element";
      const id = `elem:${f.relPath}:#${elemId}`;
      addSymbol({ id, name: `#${elemId}`, kind: "element", file: f.relPath, line: i + 1, size: 1, bytes: 0, ageHours: 0 });
      addEdge(fileId, id, "defines");
    }

    // Inline <script> and <style> blocks as regions
    if (line.match(/<script(?:\s[^>]*)?>/) && !line.match(/src=/)) {
      let end = i + 1;
      while (end < lines.length && !lines[end].includes("</script>")) end++;
      const id = `region:${f.relPath}:script:${i + 1}`;
      addSymbol({ id, name: `inline-script:${i + 1}`, kind: "script", file: f.relPath, line: i + 1, size: end - i + 1, bytes: 0, ageHours: 0 });
      addEdge(fileId, id, "defines");
    }
    if (line.match(/<style(?:\s[^>]*)?>/) && !line.match(/src=/)) {
      let end = i + 1;
      while (end < lines.length && !lines[end].includes("</style>")) end++;
      const id = `region:${f.relPath}:style:${i + 1}`;
      addSymbol({ id, name: `inline-style:${i + 1}`, kind: "style", file: f.relPath, line: i + 1, size: end - i + 1, bytes: 0, ageHours: 0 });
      addEdge(fileId, id, "defines");
    }
  }
}

// Parse CSS files for selectors, keyframes, and custom properties
for (const f of files) {
  if (f.ext !== ".css") continue;
  const fileId = `file:${f.relPath}`;
  const lines = f.content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // @keyframes name {
    const keyframeMatch = line.match(/@keyframes\s+([\w-]+)/);
    if (keyframeMatch) {
      let end = i + 1;
      let depth = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
      while (end < lines.length && depth > 0) {
        depth += (lines[end].match(/{/g) || []).length;
        depth -= (lines[end].match(/}/g) || []).length;
        end++;
      }
      const id = `keyframe:${f.relPath}:${keyframeMatch[1]}`;
      addSymbol({ id, name: keyframeMatch[1], kind: "keyframe", file: f.relPath, line: i + 1, size: end - i, bytes: 0, ageHours: 0 });
      addEdge(fileId, id, "defines");
      i = end - 1;
      continue;
    }

    // Top-level selectors (lines with { that aren't inside a rule, @-rules, or comments)
    const trimmed = line.trimStart();
    const isTopLevel = !trimmed.startsWith("@") && !trimmed.startsWith("/*") && !trimmed.startsWith("*") && !trimmed.startsWith("//");
    const selectorMatch = isTopLevel ? trimmed.match(/^([^{/]+)\s*\{/) : null;
    if (selectorMatch) {
      const selector = selectorMatch[1].trim();
      const indent = line.length - trimmed.length;
      if (selector && indent <= 2) {
        let end = i + 1;
        let depth = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
        while (end < lines.length && depth > 0) {
          depth += (lines[end].match(/{/g) || []).length;
          depth -= (lines[end].match(/}/g) || []).length;
          end++;
        }
        const ruleId = `rule:${f.relPath}:${i + 1}`;
        addSymbol({ id: ruleId, name: selector, kind: "rule", file: f.relPath, line: i + 1, size: end - i, bytes: 0, ageHours: 0 });
        addEdge(fileId, ruleId, "defines");
        // Extract CSS custom properties defined within this rule
        for (let j = i + 1; j < end; j++) {
          const varMatch = lines[j].match(/(--[\w-]+)\s*:/);
          if (varMatch) {
            const varId = `cssvar:${f.relPath}:${varMatch[1]}`;
            if (!symbols.has(varId)) {
              addSymbol({ id: varId, name: varMatch[1], kind: "variable", file: f.relPath, line: j + 1, size: 1, bytes: 0, ageHours: 0 });
              addEdge(ruleId, varId, "defines");
            }
          }
        }
        i = end - 1;
        continue;
      }
    }
    // Standalone CSS custom properties (not inside a rule block)
    const varMatch = line.match(/(--[\w-]+)\s*:/);
    if (varMatch) {
      const varId = `cssvar:${f.relPath}:${varMatch[1]}`;
      if (!symbols.has(varId)) {
        addSymbol({ id: varId, name: varMatch[1], kind: "variable", file: f.relPath, line: i + 1, size: 1, bytes: 0, ageHours: 0 });
        addEdge(fileId, varId, "defines");
      }
    }
  }
}

// Cross-reference: CSS selectors ↔ HTML elements
for (const [id, sym] of symbols) {
  if (sym.kind !== "rule") continue;
  // Extract #id references from CSS selector
  const idRefs = sym.name.matchAll(/#([\w-]+)/g);
  for (const m of idRefs) {
    // Find matching HTML element
    for (const [eid, esym] of symbols) {
      if (esym.kind === "element" && esym.name === `#${m[1]}`) {
        addEdge(id, eid, "styles");
      }
    }
  }
}

// Cross-reference: JS getElementById/querySelector → HTML elements
for (const f of files) {
  if (f.ext !== ".js" && f.ext !== ".ts") continue;
  const getByIdPattern = /getElementById\(["']([^"']+)["']\)/g;
  const querySelectorPattern = /querySelector\(["']#([^"']+)["']\)/g;
  let m;
  while ((m = getByIdPattern.exec(f.content)) !== null) {
    for (const [eid, esym] of symbols) {
      if (esym.kind === "element" && esym.name === `#${m[1]}`) {
        // Find the JS symbol that contains this reference
        const jsSymbols = [...symbols.values()].filter(s => s.file === f.relPath && s.kind !== "file" && s.line <= f.content.slice(0, m.index).split("\n").length);
        const closest = jsSymbols.sort((a, b) => b.line - a.line)[0];
        if (closest) addEdge(closest.id, eid, "references");
        else addEdge(`file:${f.relPath}`, eid, "references");
      }
    }
  }
  while ((m = querySelectorPattern.exec(f.content)) !== null) {
    for (const [eid, esym] of symbols) {
      if (esym.kind === "element" && esym.name === `#${m[1]}`) {
        addEdge(`file:${f.relPath}`, eid, "references");
      }
    }
  }
}

// Build a name→id map for cross-reference resolution
const nameToIds: Map<string, string[]> = new Map();
for (const [id, sym] of symbols) {
  const shortName = sym.name.includes(".") ? sym.name.split(".").pop()! : sym.name;
  for (const n of [sym.name, shortName]) {
    if (!nameToIds.has(n)) nameToIds.set(n, []);
    nameToIds.get(n)!.push(id);
  }
}

// Scan for call references between symbols
for (const f of files) {
  if (f.ext !== ".js" && f.ext !== ".ts") continue;
  const lines = f.content.split("\n");

  // For each symbol defined in this file, find what it references
  const fileSymbols = [...symbols.values()].filter(s => s.file === f.relPath && s.kind !== "file");

  for (const sym of fileSymbols) {
    const startLine = sym.line - 1;
    const endLine = Math.min(startLine + sym.size, lines.length);
    const body = lines.slice(startLine, endLine).join("\n");

    // Find function/method calls
    const callPattern = /\b([a-zA-Z_]\w*)\s*\(/g;
    let match;
    while ((match = callPattern.exec(body)) !== null) {
      const calledName = match[1];
      // Skip language keywords and self-references
      if (["if", "for", "while", "switch", "return", "new", "typeof", "instanceof",
           "catch", "throw", "delete", "void", "await", "Math", "Array", "Object",
           "String", "Number", "parseInt", "parseFloat", "setTimeout", "clearTimeout",
           "requestAnimationFrame", "console", "Map", "Set", "Float32Array",
           "Float64Array", "Int32Array", "ImageData", "OffscreenCanvas",
          ].includes(calledName)) continue;

      const targets = nameToIds.get(calledName);
      if (!targets) continue;
      for (const targetId of targets) {
        if (targetId === sym.id) continue; // skip self-calls
        addEdge(sym.id, targetId, "calls");
      }
    }

    // Find this.method() calls within class methods
    const thisCallPattern = /this\.(\w+)\s*\(/g;
    while ((match = thisCallPattern.exec(body)) !== null) {
      const methodName = match[1];
      const targets = nameToIds.get(methodName);
      if (!targets) continue;
      for (const targetId of targets) {
        if (targetId === sym.id) continue;
        addEdge(sym.id, targetId, "calls");
      }
    }

    // Find this.property reads (non-call)
    const thisPropPattern = /this\.(\w+)(?!\s*\()/g;
    while ((match = thisPropPattern.exec(body)) !== null) {
      const propName = match[1];
      const targets = nameToIds.get(propName);
      if (!targets) continue;
      for (const targetId of targets) {
        if (targetId === sym.id) continue;
        addEdge(sym.id, targetId, "reads");
      }
    }
  }
}

// File→file edges from importScripts / script src / import
for (const f of files) {
  const fileId = `file:${f.relPath}`;

  // importScripts('file.js')
  const importPattern = /importScripts\(['"]([^'"]+)['"]\)/g;
  let m;
  while ((m = importPattern.exec(f.content)) !== null) {
    const target = f.relPath.includes("/")
      ? f.relPath.slice(0, f.relPath.lastIndexOf("/") + 1) + m[1]
      : m[1];
    const targetId = `file:${target}`;
    if (symbols.has(targetId)) addEdge(fileId, targetId, "imports");
  }

  // <script src="file.js">
  const scriptPattern = /src=["']([^"']+\.js)["']/g;
  while ((m = scriptPattern.exec(f.content)) !== null) {
    const target = f.relPath.includes("/")
      ? f.relPath.slice(0, f.relPath.lastIndexOf("/") + 1) + m[1]
      : m[1];
    const targetId = `file:${target}`;
    if (symbols.has(targetId)) addEdge(fileId, targetId, "loads");
  }

  // <link href="file.css">
  const linkPattern = /href=["']([^"']+\.css)["']/g;
  while ((m = linkPattern.exec(f.content)) !== null) {
    const target = f.relPath.includes("/")
      ? f.relPath.slice(0, f.relPath.lastIndexOf("/") + 1) + m[1]
      : m[1];
    const targetId = `file:${target}`;
    if (symbols.has(targetId)) addEdge(fileId, targetId, "loads");
  }

  // import from "..." (Deno/TS)
  const esImportPattern = /from\s+["']\.\/([^"']+)["']/g;
  while ((m = esImportPattern.exec(f.content)) !== null) {
    const targetId = `file:${m[1]}`;
    if (symbols.has(targetId)) addEdge(fileId, targetId, "imports");
  }
}

// Filter out edges pointing to nonexistent symbols
const validEdges = edges.filter(e => symbols.has(e.src) && symbols.has(e.dst));

// Write .edges
const edgeLines = [
  "# BitZoom source code graph",
  `# Nodes: ${symbols.size} Edges: ${validEdges.length}`,
  "# FromId\tToId\tRelationshipType",
];
for (const e of validEdges) {
  edgeLines.push(`${e.src}\t${e.dst}\t${e.type}`);
}
Deno.writeTextFileSync(prefix + ".edges", edgeLines.join("\n") + "\n");

// Write .labels — Lines, Bytes, AgeHours are numeric, auto-binned by pipeline
const labelLines = [
  "# NodeId\tLabel\tGroup\tKind\tFile\tLines\tBytes\tAgeHours",
];
for (const [id, sym] of symbols) {
  const label = sym.name.replace(/\t/g, " ");
  const group = sym.file;
  const bytesStr = sym.bytes > 0 ? String(sym.bytes) : '';
  const ageStr = sym.ageHours > 0 ? String(sym.ageHours) : '';
  labelLines.push(`${id}\t${label}\t${group}\t${sym.kind}\t${sym.file}\t${sym.size}\t${bytesStr}\t${ageStr}`);
}
Deno.writeTextFileSync(prefix + ".labels", labelLines.join("\n") + "\n");

// Summary
console.log(`Wrote ${prefix}.edges (${validEdges.length} edges)`);
console.log(`Wrote ${prefix}.labels (${symbols.size} nodes)`);
console.log();

const kindCounts: Record<string, number> = {};
for (const s of symbols.values()) kindCounts[s.kind] = (kindCounts[s.kind] || 0) + 1;
for (const [k, c] of Object.entries(kindCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(c).padStart(4)}  ${k}`);
}
console.log();

const edgeTypeCounts: Record<string, number> = {};
for (const e of validEdges) edgeTypeCounts[e.type] = (edgeTypeCounts[e.type] || 0) + 1;
for (const [t, c] of Object.entries(edgeTypeCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(c).padStart(4)}  ${t}`);
}
