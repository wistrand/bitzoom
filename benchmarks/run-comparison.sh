#!/bin/bash
# Run full layout comparison: export BitZoom layouts (Deno), then compare (Python in Docker).
#
# Usage:
#   cd bitzoom && bash benchmarks/run-comparison.sh

set -euo pipefail
cd "$(dirname "$0")/.."

LAYOUTS=benchmarks/layouts
RESULTS=benchmarks/results
mkdir -p "$LAYOUTS" "$RESULTS"

# ─── Step 1: Export BitZoom layouts (Deno, native) ───────────────────────────

echo "=== Exporting BitZoom layouts ==="

export_bz() {
  local name="$1" alpha="$2" tag="$3"
  shift 3
  deno run --allow-read --allow-write benchmarks/export-layout.ts \
    --edges "docs/data/${name}.edges" --alpha "$alpha" --quant rank \
    "$@" --out "$LAYOUTS/${name}-${tag}.tsv"
}

# Email-EU
export_bz email-eu 0    a000
export_bz email-eu 0.5  a050
export_bz email-eu 0.75 a075
export_bz email-eu 1.0  a100

# Facebook
export_bz facebook 0    a000
export_bz facebook 0.75 a075
export_bz facebook 1.0  a100

# Power Grid
export_bz powergrid 0    a000
export_bz powergrid 0.75 a075
export_bz powergrid 1.0  a100

# Epstein (properties + edge types)
deno run --allow-read --allow-write benchmarks/export-layout.ts \
  --edges docs/data/epstein.edges --nodes docs/data/epstein.nodes \
  --alpha 0 --quant rank \
  --out "$LAYOUTS/epstein-a000.tsv"

deno run --allow-read --allow-write benchmarks/export-layout.ts \
  --edges docs/data/epstein.edges --nodes docs/data/epstein.nodes \
  --alpha 0 --quant rank --strength group=5 --strength edgetype=8 \
  --out "$LAYOUTS/epstein-a000-weighted.tsv"

deno run --allow-read --allow-write benchmarks/export-layout.ts \
  --edges docs/data/epstein.edges --nodes docs/data/epstein.nodes \
  --alpha 0.5 --quant rank --strength group=5 --strength edgetype=8 \
  --out "$LAYOUTS/epstein-a050-weighted.tsv"

deno run --allow-read --allow-write benchmarks/export-layout.ts \
  --edges docs/data/epstein.edges --nodes docs/data/epstein.nodes \
  --autotune \
  --out "$LAYOUTS/epstein-autotune.tsv"

# Pokemon (nodes-only, multiple property groups, no meaningful edges)
deno run --allow-read --allow-write benchmarks/export-layout.ts \
  --edges docs/data/pokemon.edges --nodes docs/data/pokemon.nodes \
  --alpha 0 --quant rank \
  --out "$LAYOUTS/pokemon-a000.tsv"

deno run --allow-read --allow-write benchmarks/export-layout.ts \
  --edges docs/data/pokemon.edges --nodes docs/data/pokemon.nodes \
  --alpha 0 --quant rank --strength type1=8 --strength type2=4 --strength generation=3 --strength rarity=2 \
  --out "$LAYOUTS/pokemon-a000-weighted.tsv"

deno run --allow-read --allow-write benchmarks/export-layout.ts \
  --edges docs/data/pokemon.edges --nodes docs/data/pokemon.nodes \
  --autotune \
  --out "$LAYOUTS/pokemon-autotune.tsv"

# MITRE ATT&CK (with properties)
deno run --allow-read --allow-write benchmarks/export-layout.ts \
  --edges docs/data/mitre-attack.edges --nodes docs/data/mitre-attack.nodes \
  --alpha 0 --quant rank \
  --out "$LAYOUTS/mitre-a000.tsv"

deno run --allow-read --allow-write benchmarks/export-layout.ts \
  --edges docs/data/mitre-attack.edges --nodes docs/data/mitre-attack.nodes \
  --alpha 0 --quant rank --strength group=5 --strength platforms=6 --strength killchain=4 \
  --out "$LAYOUTS/mitre-a000-weighted.tsv"

deno run --allow-read --allow-write benchmarks/export-layout.ts \
  --edges docs/data/mitre-attack.edges --nodes docs/data/mitre-attack.nodes \
  --alpha 0.5 --quant rank --strength group=5 --strength platforms=6 --strength killchain=4 \
  --out "$LAYOUTS/mitre-a050-weighted.tsv"

deno run --allow-read --allow-write benchmarks/export-layout.ts \
  --edges docs/data/mitre-attack.edges --nodes docs/data/mitre-attack.nodes \
  --autotune \
  --out "$LAYOUTS/mitre-autotune.tsv"

# Synth Packages (with properties)
deno run --allow-read --allow-write benchmarks/export-layout.ts \
  --edges docs/data/synth-packages.edges --nodes docs/data/synth-packages.nodes \
  --alpha 0 --quant rank \
  --out "$LAYOUTS/synth-pkg-a000.tsv"

deno run --allow-read --allow-write benchmarks/export-layout.ts \
  --edges docs/data/synth-packages.edges --nodes docs/data/synth-packages.nodes \
  --alpha 0 --quant rank --strength group=5 --strength downloads=3 --strength license=2 \
  --out "$LAYOUTS/synth-pkg-a000-weighted.tsv"

deno run --allow-read --allow-write benchmarks/export-layout.ts \
  --edges docs/data/synth-packages.edges --nodes docs/data/synth-packages.nodes \
  --alpha 0.5 --quant rank --strength group=5 --strength downloads=3 --strength license=2 \
  --out "$LAYOUTS/synth-pkg-a050-weighted.tsv"

deno run --allow-read --allow-write benchmarks/export-layout.ts \
  --edges docs/data/synth-packages.edges --nodes docs/data/synth-packages.nodes \
  --autotune \
  --out "$LAYOUTS/synth-pkg-autotune.tsv"

# BitZoom Source (with properties)
deno run --allow-read --allow-write benchmarks/export-layout.ts \
  --edges docs/data/bitzoom-source.edges --nodes docs/data/bitzoom-source.nodes \
  --alpha 0 --quant rank \
  --out "$LAYOUTS/bz-source-a000.tsv"

deno run --allow-read --allow-write benchmarks/export-layout.ts \
  --edges docs/data/bitzoom-source.edges --nodes docs/data/bitzoom-source.nodes \
  --alpha 0 --quant rank --strength kind=8 --strength group=3 \
  --out "$LAYOUTS/bz-source-a000-weighted.tsv"

deno run --allow-read --allow-write benchmarks/export-layout.ts \
  --edges docs/data/bitzoom-source.edges --nodes docs/data/bitzoom-source.nodes \
  --alpha 0.5 --quant rank --strength kind=8 --strength group=3 \
  --out "$LAYOUTS/bz-source-a050-weighted.tsv"

deno run --allow-read --allow-write benchmarks/export-layout.ts \
  --edges docs/data/bitzoom-source.edges --nodes docs/data/bitzoom-source.nodes \
  --autotune \
  --out "$LAYOUTS/bz-source-autotune.tsv"

echo

# ─── Step 2: Run Python comparison in Docker ─────────────────────────────────

echo "=== Running Python comparison (Docker) ==="

DOCKER_IMG="bitzoom-bench"

# Build image if needed
if ! docker image inspect "$DOCKER_IMG" &>/dev/null; then
  echo "Building Docker image..."
  docker build -t "$DOCKER_IMG" -f benchmarks/Dockerfile benchmarks/
fi

run_compare() {
  local dataset="$1"
  shift
  echo "--- $dataset ---"
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$(pwd)/docs/data:/data:ro" \
    -v "$(pwd)/benchmarks:/bench" \
    "$DOCKER_IMG" \
    python3 /bench/compare-layouts.py "$@"
}

# Helper: expand host glob to docker paths
docker_bz() {
  local pattern="$1"
  local host_files=( $LAYOUTS/${pattern}-*.tsv )
  local docker_files=()
  for f in "${host_files[@]}"; do
    [[ -f "$f" ]] && docker_files+=("/bench/layouts/$(basename "$f")")
  done
  echo "${docker_files[@]}"
}

# Epstein (small, properties + edge types)
run_compare "Epstein" \
  --edges /data/epstein.edges \
  --bitzoom $(docker_bz epstein) \
  --tokens /bench/layouts/epstein.tokens \
  --out /bench/results/epstein.txt

# Pokemon (nodes-only, multiple property groups)
run_compare "Pokemon" \
  --edges /data/pokemon.edges \
  --bitzoom $(docker_bz pokemon) \
  --tokens /bench/layouts/pokemon.tokens \
  --out /bench/results/pokemon.txt

# Email-EU (with ground truth)
run_compare "Email-EU" \
  --edges /data/email-eu.edges \
  --bitzoom $(docker_bz email-eu) \
  --tokens /bench/layouts/email-eu.tokens \
  --ground-truth /bench/ground-truth/email-eu-departments.txt \
  --out /bench/results/email-eu.txt

# Facebook (skip UMAP — 4K×4K dense adjacency too slow)
run_compare "Facebook" \
  --edges /data/facebook.edges \
  --bitzoom $(docker_bz facebook) \
  --tokens /bench/layouts/facebook.tokens \
  --skip-umap \
  --out /bench/results/facebook.txt

# Power Grid (skip UMAP — 5K×5K dense adjacency too slow)
run_compare "Power Grid" \
  --edges /data/powergrid.edges \
  --bitzoom $(docker_bz powergrid) \
  --tokens /bench/layouts/powergrid.tokens \
  --skip-umap \
  --out /bench/results/powergrid.txt

# MITRE ATT&CK (skip UMAP — 5K×5K dense adjacency too slow)
run_compare "MITRE ATT&CK" \
  --edges /data/mitre-attack.edges \
  --bitzoom $(docker_bz mitre) \
  --tokens /bench/layouts/mitre.tokens \
  --skip-umap \
  --out /bench/results/mitre.txt

# Synth Packages (skip UMAP — 2K×2K dense adjacency slow)
run_compare "Synth Packages" \
  --edges /data/synth-packages.edges \
  --bitzoom $(docker_bz synth-pkg) \
  --tokens /bench/layouts/synth-pkg.tokens \
  --skip-umap \
  --out /bench/results/synth-pkg.txt

# BitZoom Source (small enough for UMAP)
run_compare "BitZoom Source" \
  --edges /data/bitzoom-source.edges \
  --bitzoom $(docker_bz bz-source) \
  --tokens /bench/layouts/bz-source.tokens \
  --out /bench/results/bz-source.txt

echo
echo "=== Done. Results in $RESULTS/ ==="
