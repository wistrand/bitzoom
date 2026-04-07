#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Convert midi.guide CSV data into a BitZoom SNAP graph.
 *
 * Nodes = devices (synths, drum machines, effects).
 * Edges = shared CC-to-section mappings between devices.
 * Properties = manufacturer, param count, section profile, has_nrpn, etc.
 *
 * Usage: deno run --allow-read --allow-write scripts/midi2graph.js [midi-dir] [output-prefix]
 *   Default: midi-dir = tmp/midi, output = docs/data/midi-synths
 */

import { walk } from 'https://deno.land/std/fs/walk.ts';
import { resolve, basename, dirname } from 'https://deno.land/std/path/mod.ts';

const midiDir = Deno.args[0] || 'tmp/midi';
const prefix = Deno.args[1] || 'docs/data/midi-synths';

// ─── Section normalizer ─────────────────────────────────────────────────────
// Maps the ~950 raw section names to ~15 canonical categories.
// Order matters: first match wins. More specific patterns before general ones.

const SECTION_RULES = [
  // Oscillator variants
  [/\b(osc|vco|dco|dds|wave(?:table|form|shape|finder)?|sub.?osc|super.?saw|detune|pitch|tune|portamento|glide|operator|fm.?tone|emitter|motif)\b/i, 'oscillator'],
  // Filter variants (SVF, LPF, HPF, BPF are filter types)
  [/\b(filt|vcf|tvf|svf|lpf|hpf|bpf|cutoff|reson|comb|ladder|steiner|multi.?mode|low.?pass|high.?pass|band.?pass)\b/i, 'filter'],
  // Amplifier / VCA
  [/\b(amp(?!le)|vca|tva|amplif|gain|volume|level(?!.*lfo))\b/i, 'amp'],
  // Envelope (EG = envelope generator)
  [/\b(env|adsr|attack|decay|sustain|release|\beg\b|contour)\b/i, 'envelope'],
  // LFO
  [/\b(lfo|vibrato)\b/i, 'lfo'],
  // Modulation (mod matrix, mod wheel, cross mod, ring mod, virtual patch)
  [/\b(mod(?:ulation|.?matrix|.?wheel|.?depth|.?source|.?dest)?|matrix|ring\b|mutator|virtual.?patch|cross.?mod|animate)\b/i, 'modulation'],
  // Effects (delay, reverb, chorus, distortion, phaser, flanger, granular, etc.)
  [/\b(fx|effect|delay|reverb|chorus|phaser|flang|dist(?:ortion)?|overdrive|saturation|bit.?crush|compress|eq(?:ualiz)?|looper|tremolo|wah|shader|gator|granular|grain|mosaic|chorder|warp)\b/i, 'effects'],
  // Arpeggiator / sequencer / trigger
  [/\b(arp|seq(?:uenc)?|step|pattern|motion|euclidean|trig\b)\b/i, 'sequencer'],
  // Mixer / routing / aux
  [/\b(mix|rout|bus|pan(?:ning)?|send|balance|cross.?fade|master|output|aux\b)\b/i, 'mixer'],
  // Drums / percussion / sampler playback
  [/\b(drum|kick|snare|hi.?hat|clap|cymbal|tom|perc|bd\b|sd\b|hh\b|cp\b|one.?shot|loop.?track|playback|sample)\b/i, 'drums'],
  // Performance (aftertouch, velocity, expression, pedals)
  [/\b(perform|express|velocity|aftertouch|pressure|bend|ribbon|touch|breath|wheel|pedal)\b/i, 'performance'],
  // Vocoder / vocal
  [/\b(vocod|vocal)\b/i, 'vocoder'],
  // Voice / polyphony / unison
  [/\b(voice|voic|poly|mono\b|unison)\b/i, 'voice'],
  // Global / system / MIDI / general / setup
  [/\b(global|system|midi|channel|program|bank|clock|sync|transport|tempo|bpm|general|memory|hidden|block.?edit|utility|cv\b|sound.?design|setup|misc|instrument|config|dip.?switch)\b/i, 'global'],
  // Noise
  [/\b(noise)\b/i, 'noise'],
  // Organ / keys
  [/\b(organ|piano|key|clav|drawbar)\b/i, 'keys'],
  // Track / part (generic multi-track)
  [/\b(track|part\b|subtrack|ch\+|rc.?channel)\b/i, 'track'],
  // Synth (generic catch-all)
  [/\b(synth)\b/i, 'synth'],
];

// Fallback: classify by parameter name when section is empty/unclassified
const PARAM_NAME_RULES = [
  [/\b(cutoff|filter|reson|vcf|frequency)\b/i, 'filter'],
  [/\b(osc|pitch|tune|detune|wave|pulse.?width|pwm|shape|octave|transpose|semi)\b/i, 'oscillator'],
  [/\b(attack|decay|sustain|release|env)\b/i, 'envelope'],
  [/\b(lfo|rate|depth|vibrato)\b/i, 'lfo'],
  [/\b(amp|volume|level|gain|vca)\b/i, 'amp'],
  [/\b(delay|reverb|chorus|phaser|flang|dist|overdrive|fx|effect|feedback|size|time|damping)\b/i, 'effects'],
  [/\b(mod.?wheel|modulation|mod.?depth|ring)\b/i, 'modulation'],
  [/\b(pan|mix|balance|send|dry.?wet)\b/i, 'mixer'],
  [/\b(arp|tempo|seq|bpm|clock|swing|gate.?length)\b/i, 'sequencer'],
  [/\b(portamento|glide)\b/i, 'oscillator'],
  [/\b(expression|aftertouch|velocity|breath|pedal|sustain.?pedal|sostenuto|soft)\b/i, 'performance'],
  [/\b(noise)\b/i, 'noise'],
  [/\b(drive)\b/i, 'effects'],
  [/\b(bypass|on.?off|mute)\b/i, 'global'],
  [/\b(spread|unison)\b/i, 'voice'],
];

function normalizeSection(raw, paramName) {
  const s = (raw || '').trim().replace(/^["']|["']$/g, '');
  // Try section name first
  if (s) {
    for (const [re, cat] of SECTION_RULES) {
      if (re.test(s)) return cat;
    }
    if (/\b(knob|macro|assign|map|learn|param|control)\b/i.test(s)) return 'assignable';
    if (/\b(toggle|switch|button|on.?off)\b/i.test(s)) return 'toggles';
    if (/\b(other|sound)\b/i.test(s) && paramName) {
      // "Other" or "Sound" sections — try param name
      for (const [re, cat] of PARAM_NAME_RULES) {
        if (re.test(paramName)) return cat;
      }
    }
    return 'other';
  }
  // Empty section — classify by parameter name
  if (paramName) {
    for (const [re, cat] of PARAM_NAME_RULES) {
      if (re.test(paramName)) return cat;
    }
  }
  return 'other';
}

// ─── Parse all CSV files ────────────────────────────────────────────────────

const devices = new Map(); // deviceKey → { manufacturer, device, params: [], sections: Set }

for await (const entry of walk(midiDir, { exts: ['.csv'] })) {
  if (basename(entry.path) === 'template.csv') continue;
  const text = await Deno.readTextFile(entry.path);
  const lines = text.split('\n');
  if (lines.length < 2) continue;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Parse CSV respecting quotes
    const fields = [];
    let field = '', inQuote = false;
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (c === '"') { inQuote = !inQuote; continue; }
      if (c === ',' && !inQuote) { fields.push(field); field = ''; continue; }
      field += c;
    }
    fields.push(field);

    const [manufacturer, device, section, paramName, , ccMsb, , , , , nrpnMsb] = fields;
    if (!manufacturer || !device) continue;

    const key = `${manufacturer}|||${device}`;
    if (!devices.has(key)) {
      devices.set(key, {
        manufacturer: manufacturer.trim(),
        device: device.trim(),
        params: [],
        rawSections: new Set(),
        normSections: new Set(),
        hasNrpn: false,
        ccSet: new Set(),
      });
    }
    const dev = devices.get(key);
    const normSection = normalizeSection(section, paramName);
    dev.rawSections.add((section || '').trim());
    dev.normSections.add(normSection);
    const cc = parseInt(ccMsb);
    if (!isNaN(cc) && cc >= 0 && cc <= 127) {
      dev.ccSet.add(cc);
      dev.params.push({ normSection, cc, paramName: (paramName || '').trim() });
    }
    if (nrpnMsb && nrpnMsb.trim()) dev.hasNrpn = true;
  }
}

console.log(`Parsed ${devices.size} devices`);

// ─── Build edges: shared CC-to-section mappings ─────────────────────────────
// Two devices share an edge when they use the same CC number for the same
// normalized section. Weight = number of shared (cc, section) pairs.

// Universal CCs that nearly all devices implement — these don't signal real
// similarity, they're just the MIDI spec baseline.
const UNIVERSAL_CCS = new Set([
  0,   // Bank Select MSB
  1,   // Mod Wheel
  7,   // Volume
  10,  // Pan
  11,  // Expression
  32,  // Bank Select LSB
  64,  // Sustain Pedal
  120, // All Sound Off
  121, // Reset All Controllers
  123, // All Notes Off
]);

// Build per-device fingerprint: Set of "cc:section" strings (excluding universal CCs)
const fingerprints = new Map();
for (const [key, dev] of devices) {
  const fp = new Set();
  for (const p of dev.params) {
    if (!UNIVERSAL_CCS.has(p.cc)) fp.add(`${p.cc}:${p.normSection}`);
  }
  fingerprints.set(key, fp);
}

// Compute edges — higher threshold for meaningful similarity
const MIN_SHARED = 15;
const deviceKeys = [...devices.keys()];
const edges = [];
for (let i = 0; i < deviceKeys.length; i++) {
  const fpA = fingerprints.get(deviceKeys[i]);
  if (fpA.size === 0) continue;
  for (let j = i + 1; j < deviceKeys.length; j++) {
    const fpB = fingerprints.get(deviceKeys[j]);
    if (fpB.size === 0) continue;
    let shared = 0;
    for (const s of fpA) {
      if (fpB.has(s)) shared++;
    }
    if (shared >= MIN_SHARED) {
      edges.push({ src: deviceKeys[i], dst: deviceKeys[j], weight: shared });
    }
  }
}

console.log(`Built ${edges.length} edges (min ${MIN_SHARED} shared CC:section pairs)`);

// ─── Compute node properties ────────────────────────────────────────────────

// Dominant section: which normalized section has the most parameters
function dominantSection(dev) {
  const counts = {};
  for (const p of dev.params) {
    counts[p.normSection] = (counts[p.normSection] || 0) + 1;
  }
  let best = 'other', bestCount = 0;
  for (const [s, c] of Object.entries(counts)) {
    if (c > bestCount) { bestCount = c; best = s; }
  }
  return best;
}

// Section profile: comma-separated sorted list of sections with >1 param
function sectionProfile(dev) {
  const counts = {};
  for (const p of dev.params) {
    counts[p.normSection] = (counts[p.normSection] || 0) + 1;
  }
  return Object.entries(counts)
    .filter(([, c]) => c > 1)
    .sort((a, b) => b[1] - a[1])
    .map(([s]) => s)
    .join('+') || 'minimal';
}

// Device type heuristic based on sections and param names
function deviceType(dev) {
  const sects = dev.normSections;
  const hasOsc = sects.has('oscillator');
  const hasFilter = sects.has('filter');
  const hasDrums = sects.has('drums');
  const hasFx = sects.has('effects');
  const hasSeq = sects.has('sequencer');
  if (hasDrums && !hasOsc) return 'drum machine';
  if (hasDrums && hasOsc) return 'groovebox';
  if (hasOsc && hasFilter) return 'synthesizer';
  if (hasOsc && !hasFilter) return 'synth (simple)';
  if (hasFx && !hasOsc) return 'effects';
  if (hasSeq && !hasOsc) return 'sequencer';
  if (dev.params.length < 10) return 'controller';
  return 'synthesizer';
}

// CC density: what fraction of 0-127 range is used
function ccDensity(dev) {
  return dev.ccSet.size;
}

// Parameter complexity: total param count bucketed
function paramBucket(count) {
  if (count <= 10) return 'tiny';
  if (count <= 30) return 'small';
  if (count <= 80) return 'medium';
  if (count <= 200) return 'large';
  return 'massive';
}

// ─── Write D3 JSON ──────────────────────────────────────────────────────────

function nodeId(key) {
  const [mfr, dev] = key.split('|||');
  return `${mfr} ${dev}`;
}

const d3nodes = [];
for (const [key, dev] of devices) {
  d3nodes.push({
    id: nodeId(key),
    name: dev.device,
    group: dev.manufacturer,
    type: deviceType(dev),
    params: dev.params.length,
    sections: sectionProfile(dev),
    ccs: ccDensity(dev),
    nrpn: dev.hasNrpn ? 'yes' : 'no',
    dominant: dominantSection(dev),
    complexity: paramBucket(dev.params.length),
  });
}

const d3links = edges.map(e => ({
  source: nodeId(e.src),
  target: nodeId(e.dst),
}));

const d3json = {
  metadata: {
    name: 'MIDI Synths',
    description: 'MIDI CC implementation similarity across 324 synthesizers, drum machines, and effects units. Edges connect devices sharing ≥15 non-universal CC-to-section mappings.',
    source: 'https://midi.guide',
    credits: 'Data from midi.guide (Pencil Research) and community contributors.',
    settings: {
      strengths: { dominant: 9, nrpn: 3 },
      bearings: { dominant: 51, nrpn: 97 },
      labelProps: ['label', 'group'],
    },
  },
  nodes: d3nodes,
  links: d3links,
};

const outPath = prefix.replace(/\.(edges|nodes)$/, '') + '.json';
await Deno.writeTextFile(outPath, JSON.stringify(d3json, null, 2) + '\n');

console.log(`Written ${outPath} (${d3nodes.length} nodes, ${d3links.length} links)`);

// ─── Stats ──────────────────────────────────────────────────────────────────

const typeCounts = {};
const mfrCounts = {};
for (const [, dev] of devices) {
  const t = deviceType(dev);
  typeCounts[t] = (typeCounts[t] || 0) + 1;
  mfrCounts[dev.manufacturer] = (mfrCounts[dev.manufacturer] || 0) + 1;
}
console.log('\nDevice types:', Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t}:${c}`).join(', '));
console.log('Top manufacturers:', Object.entries(mfrCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([m, c]) => `${m}:${c}`).join(', '));

// Section normalization coverage
const normCounts = {};
let totalParams = 0, otherParams = 0;
for (const [, dev] of devices) {
  for (const p of dev.params) {
    normCounts[p.normSection] = (normCounts[p.normSection] || 0) + 1;
    totalParams++;
    if (p.normSection === 'other') otherParams++;
  }
}
console.log('\nSection categories:', Object.entries(normCounts).sort((a, b) => b[1] - a[1]).map(([s, c]) => `${s}:${c}`).join(', '));
console.log(`Normalization coverage: ${totalParams - otherParams}/${totalParams} (${((1 - otherParams / totalParams) * 100).toFixed(1)}% classified)`);
