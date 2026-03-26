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

Properties are partitioned into semantically independent groups. For each group, compute a MinHash signature and project to 2D via a fixed Gaussian random matrix — one matrix per group, independently seeded. Store only the resulting 2D point, two floats per group. Discard the signatures.

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

The current implementation uses rank-based quantization because the graph is static and post-blend distribution is not reliably Gaussian. For live graphs, fixed boundaries computed from an initial snapshot are preferable — update stability outweighs the occupancy guarantee. Operational questions remain open: nodes whose projections fall outside the initial range, distribution drift over time, and schema changes all require explicit policy.

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
- Rank quantization destroys density information; dense and sparse regions are visually indistinguishable by position alone
- High topology weight causes oversmoothing in well-connected components
- Rank quantization is globally unstable under node insertion; fixed Gaussian boundaries solve this at the cost of occupancy guarantees and require update policy for distribution drift
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
| Rank quantization | O(n log n) |
| Level construction | O(n + E) per level, lazy |
| Per-node zoom-cell derivation | O(1) |

**Memory per node:** 2G floats for fixed projections + four bytes for uint16 grid coordinates.
