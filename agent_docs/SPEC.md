# BitZoom

A deterministic layout and hierarchical aggregation system for large property graphs. Nodes are positioned in a 2D grid such that similar nodes occupy nearby cells. The hierarchy gives stable zoom levels derived purely from stored coordinates — no layout recomputation on navigation; only level lookup and aggregation.

---

## Motivation

Classical graph layout optimises for topological fidelity. For property graphs this is often wrong — meaningful neighbours are frequently semantically similar nodes with no edge between them. BitZoom defaults to property similarity first, topology second. Proximity means semantic similarity, not graph distance. Topology influence is an explicit tunable parameter rather than the primary organising principle.

Scale is a second motivation. Force-directed is O(n²) without approximation; spectral layout requires eigenvector computation. BitZoom is near-linear preprocessing with O(1) per-node zoom-cell derivation.

---

## Similarity

Property similarity is estimated via Jaccard on token sets, sketched with MinHash at k=128. Jaccard is a simple and robust baseline for sparse categorical properties — it handles missing values gracefully and requires no distance metric. It is a reasonable default, not a uniquely correct choice. Continuous properties require discretisation and results are bin-sensitive. Common tokens dominate unless downweighted. Ordinal structure and near-matches are not captured.

Treating MinHash integer values as a vector and applying Gaussian projection has no direct geometric justification from MinHash theory. In practice, similar signatures produce correlated projected coordinates — an empirical observation rather than a proven property. Any method producing a fixed-dimensional vector per node can replace MinHash at the same point in the pipeline.

The practical performance of the system depends heavily on tokenisation and grouping quality — schema-aware field naming, sensible discretisation of numeric fields, downweighting of common tokens, and grouping of properties by semantic independence. These choices determine whether the notion of similarity the pipeline faithfully preserves is actually the one users want.

---

## Per-node fixed projections *(computed once)*

Properties are partitioned into semantically independent groups. For each group, compute a MinHash signature, z-score normalize it, and project to 2D via a fixed Gaussian random matrix — one matrix per group, independently seeded. Store only the resulting 2D point, two floats per group. Discard the signatures.

Z-score normalization (subtract mean, divide by standard deviation) is essential, not cosmetic. MinHash values are integers in [0, p) with a large common offset (~p/2). Without normalization, the projection is dominated by this offset — all nodes project to nearly the same point, with the discriminative signal buried in the noise floor. Normalization extracts the relative pattern and scales it to unit magnitude, making the projection usable. It also discards token set size information, which is intentional: position should reflect which properties nodes share, not how many they have. As a secondary benefit, normalizing to unit variance ensures each signature component contributes equally to the Gaussian projection sum, improving CLT convergence — the projected coordinates are more accurately Gaussian, which strengthens the justification for Gaussian quantization.

These projections are permanently fixed. No weight change, topology change, or graph update alters them. They are the coordinate anchors for each node.

The projection does not preserve pairwise distances — Johnson-Lindenstrauss requires target dimension O(log n / ε²), not 2. What it provides is a stable ordering signal sufficient for the quantization step. Independent matrices per group help the group projections span the 2D space rather than collapsing onto the same directions.

---

## Unified blend *(runs on any parameter change)*

Let W = Σ_g w_g be the sum of property weights. Define the blended position as:

```
px_i = (1 − α) · (Σ_g w_g · p_g(i) / W)  +  α · avg_{j∈N(i)}(px_j)
```

where α ∈ [0,1] is the topology weight. At α=0 position is determined entirely by property similarity. At α=1 it is determined entirely by the neighbor average. The property term is a convex combination of fixed group anchors; in continuous space, weight changes move each node affinely as a blend of those fixed anchors.

For degree-zero nodes the neighbor average is undefined; the topology term is omitted and position is determined by the property term alone.

Run synchronously for k passes, each using the previous pass's positions as the neighbor signal. This is closely related to degree-normalised graph smoothing. At high α with many passes, well-connected components collapse toward their degree-weighted centroid — the standard oversmoothing failure mode of iterative graph smoothing.

After quantization the mapping is piecewise constant. Small weight changes produce either no cell movement or discrete steps, never catastrophic global reorganisation.

---

## Grid quantization

Two designs are viable with different tradeoffs.

**Rank-based:** sort all nodes by final px, assign `gx = floor(rank / n × GRID_SIZE)`. Ties broken by node identifier for determinism. Guarantees equal occupancy per bucket regardless of position distribution. Invariant to global position shifts — only genuine reorderings cause cell changes. Globally sensitive to node insertion: adding one node shifts every rank above it, potentially moving many cells. Best for static graphs.

**Fixed Gaussian boundaries:** place boundaries at Φ⁻¹(i / GRID_SIZE). Gives a fixed coordinate system — node insertion does not shift other nodes' cells. Concentrates resolution near the distribution center. Assumes approximately Gaussian positions after blending, which weakens when one weight dominates and the distribution becomes multimodal.

The current implementation defaults to Gaussian quantization — the matched CDF for the distribution that Gaussian random projection produces (via the Central Limit Theorem). This preserves density structure: clusters stay tight, sparse regions stay sparse. Rank-based quantization is available as a toggle for cases where the post-blend distribution departs significantly from Gaussian (e.g., high α with topology smoothing, or when a single weight dominates and the distribution becomes multimodal).

Either way the output is a uint16 coordinate pair (gx, gy) — four stored bytes per node. All zoom cell indices derive from these stored uint16 coordinates via bit shifts.

---

## Hierarchical zoom levels

At level L: `cx = gx >> (16 − L)`, cell ID = `(cx << L) | cy`. Level 1 is a 2×2 grid; level 14 is 16384×16384. Bit-prefix containment is exact and unconditional — a node's cell at level L is always a sub-cell of its cell at level L−1, for every node at every level regardless of data distribution or parameter values.

---

## Supernode aggregation

Nodes sharing a cell at level L form a supernode. Cross-cell edges become weighted supernode edges with weight equal to the count of underlying cross-cell edges. Supernode position is the centroid of member continuous coordinates before quantization. Level structures are built lazily on first access and invalidated on parameter change.

---

## Known limitations

- Jaccard is crude for continuous or ordinal properties; results are discretisation-sensitive
- 2D projection does not preserve pairwise distances; layout reflects coarse ordering, not metric geometry
- Rank quantization (when selected) destroys density information; Gaussian quantization preserves it but assumes approximately normal marginals
- High topology weight causes oversmoothing in well-connected components
- Rank quantization is globally unstable under node insertion; Gaussian quantization is locally stable but nodes in distribution tails may cluster at grid boundaries
- **Undefined values cluster when their property dominates.** Empty fields produce neutral `[0,0]` projections — correct when that group has low weight, but when heavily weighted, all undefined nodes collapse to the same pre-quantization position. Rank quantization spreads them along each axis independently but preserves the 2D correlation, creating visible edge pile-up. Gaussian quantization with fixed boundaries (frozen from dataset-tuned weights) is worse: the degenerate cluster shifts far from the stored μ, pushing nodes to grid extremes. This is inherent to the neutral-projection design — no quantization scheme can decorrelate axes that are correlated in the input.
- Layout quality depends heavily on tokenisation and grouping quality; the pipeline faithfully preserves whatever similarity it is given

---

## Open validation questions

The system requires empirical evaluation against: semantic neighbourhood preservation metrics; stability under weight changes and node insertion; oversmoothing onset as a function of α, passes, and graph structure; and task-based user evaluation for property graph exploration compared against force-directed, spectral, and embedding-based baselines.

---

## Complexity

| Phase | Cost |
|---|---|
| Group projections | O(n · k · G) |
| Unified blend | O(passes · (n + E)) |
| Quantization (rank) | O(n log n) |
| Quantization (gaussian) | O(n) |
| Level construction | O(n + E) per level, lazy |
| Per-node zoom-cell derivation | O(1) |

**Memory per node:** 2G floats for fixed projections + four bytes for uint16 grid coordinates.
