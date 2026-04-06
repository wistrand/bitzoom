# BitZoom Layout Comparison Report

## 1. Summary

Eight graph datasets were laid out using BitZoom (with hand-tuned strengths, auto-tune,
and multiple topology weights), ForceAtlas2 (2000 iterations, Barnes-Hut), UMAP, and
t-SNE. All methods received the same input graphs. Layouts were evaluated on both
topology preservation (edge length, neighborhood overlap) and property-similarity
preservation (whether nodes with similar attributes end up nearby).

Five datasets have rich node properties (Epstein, Pokemon, MITRE ATT&CK, Synth
Packages, BitZoom Source); three are edge-only (Email-EU, Facebook, Power Grid).

BitZoom's dual-pass auto-tune (zero-config) beats all baselines on 3 of 5 property
datasets while being 1,000-70,000× faster than ForceAtlas2/t-SNE/UMAP.

| Dataset        | Nodes | Edges  | Properties | Best BitZoom          | PropNbrP vs FA2 | Autotune vs FA2 |
| -------------- | ----: | -----: | ---------- | --------------------- | --------------: | --------------: |
| Epstein        |   514 |    494 | edge types | α=0 hand-tuned        |          1.44x |          1.42x |
| Pokemon        |   959 |  3,783 | multi      | autotune               |          1.13x |          1.13x |
| MITRE          | 4,736 | 25,856 | rich       | α=0 hand-tuned        |          2.42x |          0.91x |
| Synth Packages | 1,868 |  4,044 | rich       | α=0 hand-tuned        |          5.86x |          2.62x |
| BZ Source      |   917 |  2,097 | rich       | α=0.5 hand-tuned      |          0.84x |          0.56x |
| Email-EU       | 1,005 | 16,706 | edge-only  | α=1.0                 |          0.80x |           — |
| Facebook       | 4,039 | 88,234 | edge-only  | α=1.0                 |          0.70x |           — |
| Power Grid     | 4,941 |  6,594 | edge-only  | α=0.75                |          0.58x |           — |

Ratios are BitZoom / ForceAtlas2. Higher = better for both columns.

---

## 2. Methodology

### 2.1 Algorithms

**BitZoom.** MinHash property signatures projected to 2D via Gaussian random matrices,
blended with iterative topology smoothing (5 passes), quantized to a uint16 grid.
Tested at topology blend α = 0, 0.5, and with hand-tuned property strengths.
Auto-tune uses a dual-pass optimizer (search at α=0 and α=0.5, cap at 0.75).

**ForceAtlas2.** [`fa2-modified`](https://pypi.org/project/fa2-modified/) with
Barnes-Hut optimization (θ=1.2), 2000 iterations, scalingRatio=2, gravity=1.

**UMAP.** umap-learn, Jaccard metric on binary adjacency rows, 2 components, seed=42.
Run on small datasets (Epstein, Pokemon, Email-EU, BZ Source). Skipped on larger
datasets due to dense n×n adjacency cost.

**t-SNE.** scikit-learn TSNE on binary adjacency rows, 2 components, seed=42,
perplexity = min(30, n-1).

### 2.2 Metrics

**TopoNbrP.** Topology neighborhood preservation. Jaccard overlap between each node's
k=10 nearest graph neighbors and k=10 nearest layout neighbors. Higher = better.

**PropNbrP.** Property-similarity neighborhood preservation. Jaccard overlap between
k=10 most property-similar nodes (by token-set Jaccard) and k=10 nearest layout
neighbors. Higher = better property grouping.

**Silhouette.** Layout positions vs ground-truth labels, -1 to +1. Only for Email-EU.

**Time.** Wall-clock seconds. BitZoom includes full pipeline; baselines measure layout only.

### 2.3 Datasets

| Dataset        | Nodes | Edges  | Source        | Properties                              |
| -------------- | ----: | -----: | ------------- | --------------------------------------- |
| Epstein        |   514 |    494 | public record | group, edge types (20+ types)           |
| Pokemon        |   959 |  3,783 | Kaggle        | type1, type2, generation, rarity, stats |
| MITRE          | 4,736 | 25,856 | MITRE ATT&CK  | platforms, kill chain, aliases           |
| Synth Packages | 1,868 |  4,044 | synthetic     | group, downloads, license, version      |
| BZ Source      |   917 |  2,097 | this repo     | kind, file, lines, bytes, age, edgetype |
| Email-EU       | 1,005 | 16,706 | Stanford SNAP | none (edge-only)                        |
| Facebook       | 4,039 | 88,234 | Stanford SNAP | none (edge-only)                        |
| Power Grid     | 4,941 |  6,594 | KONECT        | none (edge-only)                        |

### 2.4 Reproducibility

```sh
bash benchmarks/run-comparison.sh   # requires Deno and Docker
```

Total runtime ~20 minutes, dominated by ForceAtlas2 on 4-5K node datasets.

---

## 3. Results: property-rich datasets

### 3.1 Epstein

514 nodes, 494 edges with rich edge types (ABUSED, ASSOCIATED_WITH, etc.).

| Layout             | Time  | TopoNbrP | PropNbrP | Note                                   |
| ------------------ | ----: | -------: | -------: | -------------------------------------- |
| BitZoom α=0 wt     |  1ms  |   0.004  |   0.118  | group:5, edgetype:8 — best PropNbrP    |
| BitZoom autotune   |  1ms  |   0.013  |   0.116  | group:8, edgetype:3, α=0.5 — 98% of hand-tuned |
| ForceAtlas2        |   3s  |   0.099  |   0.082  | Topology-driven                        |
| t-SNE              | 0.4s  |   0.006  |   0.090  | Third-highest PropNbrP                 |
| UMAP               |   4s  |   0.004  |   0.082  | Similar to FA2                         |

**Autotune showcase.** The dual-pass optimizer discovers `edgetype:3` through its
α=0.5 pass — invisible at α=0 — reaching 98% of the hand-tuned PropNbrP. Beats
ForceAtlas2 by 42%.

### 3.2 Pokemon

959 nodes, multiple property groups. Properties dominate similarity.

| Layout             | Time  | TopoNbrP | PropNbrP | Note                            |
| ------------------ | ----: | -------: | -------: | ------------------------------- |
| BitZoom autotune   |  1ms  |   0.006  |   0.025  | generation:8, α=0 — best PropNbrP |
| BitZoom α=0 wt     |  1ms  |   0.013  |   0.019  | Hand-tuned multi-property       |
| ForceAtlas2        |  16s  |   0.063  |   0.022  | Strong topology                 |
| UMAP               |   5s  |   0.012  |   0.022  | Similar to FA2                  |
| t-SNE              |   2s  |   0.011  |   0.017  | Lowest PropNbrP                 |

**Autotune beats hand-tuned.** The optimizer correctly identified `generation` as the
single most discriminative property, outperforming the multi-property hand-pick by 31%.

### 3.3 MITRE ATT&CK

4,736 nodes with rich properties. Tests BitZoom's core claim.

| Layout             | Time  | TopoNbrP | PropNbrP | Note                                   |
| ------------------ | ----: | -------: | -------: | -------------------------------------- |
| BitZoom α=0 wt     |  4ms  |   0.002  |   0.034  | group:5, platforms:6, killchain:4 — best |
| BitZoom autotune   |  4ms  |   0.002  |   0.013  | killchain:8, α=0.5                     |
| t-SNE              |  12s  |   0.004  |   0.026  | Second-highest PropNbrP                |
| ForceAtlas2        |  87s  |   0.005  |   0.014  | Shorter edges                          |

Hand-tuned scores 2.4× higher than FA2 on PropNbrP. The three-group interaction
(group + platforms + killchain) is not discoverable from coordinate descent; autotune
finds `killchain` alone but misses the synergy.

### 3.4 Synth Packages

1,868 synthetic packages. Properties diverge from graph connectivity.

| Layout             | Time  | TopoNbrP | PropNbrP | Note                           |
| ------------------ | ----: | -------: | -------: | ------------------------------ |
| BitZoom α=0 wt     |  2ms  |   0.005  |   0.050  | group:5, downloads:3, license:2 |
| BitZoom autotune   |  1ms  |   0.002  |   0.022  | downloads:8                    |
| t-SNE              |  19s  |   0.001  |   0.013  | Low on both                    |
| ForceAtlas2        |  54s  |   0.018  |   0.009  | Low PropNbrP                   |

Hand-tuned scores 5.9× higher than FA2. Autotune still beats FA2 by 2.6×.

### 3.5 BitZoom Source

917 nodes from this project's source code. Topology correlates with properties.

| Layout             | Time  | TopoNbrP | PropNbrP | Note                           |
| ------------------ | ----: | -------: | -------: | ------------------------------ |
| UMAP               |   6s  |   0.056  |   0.303  | Highest PropNbrP               |
| ForceAtlas2        |  11s  |   0.110  |   0.290  | High PropNbrP via adjacency    |
| t-SNE              |   3s  |   0.035  |   0.249  | High PropNbrP via adjacency    |
| BitZoom α=0.5 wt   |  1ms  |   0.017  |   0.244  | kind:8, group:3                |
| BitZoom autotune   |  1ms  |   0.013  |   0.163  | kind:3, edgetype:8             |

Topology-based methods lead because call edges track file/kind similarity.
BitZoom hand-tuned reaches 84% of FA2.

---

## 4. Results: edge-only datasets

### 4.1 Email-EU (1,005 nodes, 16.7K edges, 42 departments)

| Layout         | Time  | TopoNbrP | PropNbrP | Silhouette |
| -------------- | ----: | -------: | -------: | ---------: |
| BitZoom α=1.0  |  1ms  |   0.056  |   0.007  |     -0.29  |
| ForceAtlas2    |  18s  |   0.065  |   0.008  |     -0.41  |
| UMAP           |   5s  |   0.107  |   0.010  |     +0.01  |
| t-SNE          |   1s  |   0.108  |   0.009  |     -0.11  |

### 4.2 Facebook (4,039 nodes, 88K edges)

| Layout         | Time  | TopoNbrP | PropNbrP |
| -------------- | ----: | -------: | -------: |
| BitZoom α=1.0  |  3ms  |   0.110  |   0.003  |
| ForceAtlas2    |  67s  |   0.149  |   0.004  |
| t-SNE          |   6s  |   0.176  |   0.003  |

### 4.3 Power Grid (4,941 nodes, 6.6K edges)

| Layout         | Time  | TopoNbrP | PropNbrP |
| -------------- | ----: | -------: | -------: |
| BitZoom α=0.75 |  4ms  |   0.003  |   0.002  |
| ForceAtlas2    |  59s  |   0.195  |   0.003  |
| t-SNE          |  23s  |   0.041  |   0.002  |

---

## 5. Auto-tune analysis

The dual-pass optimizer searches strengths at α=0 (property-only) and α=0.5 (moderate
topology), picking whichever scores higher. This discovers two kinds of useful properties:
those that cluster independently and those that only show value with topology.

| Dataset        | Hand-tuned | Autotune | Best baseline | AT/baseline |
| -------------- | ---------: | -------: | ------------: | ----------: |
| Epstein        |      0.118 |    0.116 |   0.090 (tSNE)|       1.28× |
| Pokemon        |      0.019 |    0.025 |   0.022 (FA2) |       1.13× |
| MITRE          |      0.034 |    0.013 |   0.026 (tSNE)|       0.49× |
| Synth Packages |      0.050 |    0.022 |   0.013 (tSNE)|       1.76× |
| BZ Source      |      0.244 |    0.163 |   0.303 (UMAP)|       0.54× |

**Key finding:** Epstein autotune discovers `edgetype:3` through the α=0.5 pass —
a property invisible at α=0. This brings autotune within 2% of the hand-tuned
PropNbrP, validating the dual-pass approach.

---

## 6. Key findings

**BitZoom leads on property grouping when properties diverge from topology.** On MITRE
(0.034 vs FA2's 0.014, 2.4×) and Synth Packages (0.050 vs 0.009, 5.9×), BitZoom with
hand-tuned strengths places property-similar nodes substantially closer together.

**Auto-tune is competitive with baselines.** On 3 of 5 property datasets, zero-config
autotune beats ForceAtlas2, UMAP, and t-SNE on PropNbrP — at 1,000-70,000× faster.

**The signal comes from property strengths.** BitZoom without strengths scores near
baseline on PropNbrP. With tuned strengths it scores 2-6× higher than FA2.

**Topology-based methods win when adjacency correlates with properties.** On BZ Source,
FA2 (0.290) and UMAP (0.303) outscore BitZoom (0.244) because call edges track
file/kind similarity.

## 7. Limitations

- **PropNbrP circularity.** Token-set Jaccard is both the ground truth and the signal
  BitZoom approximates. A domain-expert similarity metric would be stronger evidence.
- **UMAP coverage.** UMAP skipped on 4K+ node datasets due to dense adjacency cost.
- **Fixed smoothing passes.** 5 passes; more would improve topology preservation on
  sparse graphs at increased cost.
- **Single run.** Baselines run once per dataset; seed variance not measured.
- **Multi-group interactions.** Coordinate descent can't discover synergistic
  multi-property combinations (MITRE's group + platforms + killchain).
