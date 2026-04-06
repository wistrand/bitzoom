# BitZoom

A deterministic layout and hierarchical aggregation system for large property graphs. Nodes are positioned in a 2D grid such that similar nodes occupy nearby cells. The hierarchy gives stable zoom levels derived purely from stored coordinates — no layout recomputation on navigation; only level lookup and aggregation.

---

## Motivation

Classical graph layout optimises for topological fidelity. For property graphs this is often wrong — meaningful neighbours are frequently semantically similar nodes with no edge between them. BitZoom defaults to property similarity first, topology second. Proximity means semantic similarity, not graph distance. Topology influence is an explicit tunable parameter rather than the primary organising principle.

Scale is a second motivation. Force-directed is O(n²) without approximation; spectral layout requires eigenvector computation. BitZoom is near-linear preprocessing with O(1) per-node zoom-cell derivation.

---

## Similarity

Property similarity is estimated via Jaccard on token sets, sketched with MinHash at k=128. Jaccard is a simple and robust baseline for sparse categorical properties — it handles missing values gracefully and requires no distance metric. It is a reasonable default, not a uniquely correct choice. Continuous properties require discretisation and results are bin-sensitive. Common tokens dominate unless downweighted. Ordinal structure and near-matches are not captured.

A design convention: J(∅, ∅) is defined as 1 (mathematically it is 0/0, undefined). This causes nodes with no tokens in a property group to cluster together via their shared NaN signature, grouping "unknown" nodes where users can see them. The alternative J(∅, ∅) = 0 would scatter them randomly.

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

Let W = Σ_g w_g be the sum of property strengths. Define the blended position as:

```
px_i = (1 − α) · (Σ_g w_g · p_g(i) / W)  +  α · avg_{j∈N(i)}(px_j)
```

and analogously for py_i. Here α ∈ [0,1] is the topology weight. At α=0 position is determined entirely by property similarity. At α=1 it is determined entirely by the neighbor average. The property term is a convex combination of fixed group anchors; in continuous space, strength changes move each node affinely as a blend of those fixed anchors.

For degree-zero nodes the neighbor average is undefined; the topology term is omitted and position is determined by the property term alone.

Strengths use an adaptive floor to prevent low-entropy collapse and ensure smooth transitions. Each group's effective strength is max(w_g, floor) where floor = max(maxStrength × 0.10, 0.10). This guarantees that zero-strength high-entropy groups still contribute 10% spreading, preventing nodes with identical low-entropy properties from collapsing to the same position. When all input strengths are zero, the absolute minimum floor produces an equal blend with no discontinuity — sliding a strength from zero upward produces continuous position changes.

Run synchronously for k passes, each using the previous pass's positions as the neighbor signal. This is closely related to degree-normalised graph smoothing. At high α with many passes, well-connected components collapse toward their degree-weighted centroid — the standard oversmoothing failure mode of iterative graph smoothing.

After quantization the mapping is piecewise constant. Small strength changes produce either no cell movement or discrete steps, never catastrophic global reorganisation.

---

## Grid quantization

Two designs are viable with different tradeoffs.

**Rank-based:** sort all nodes by final px, assign `gx = floor(rank / n × GRID_SIZE)`. Ties broken by node identifier for determinism. Guarantees equal occupancy per bucket regardless of position distribution. Invariant to global position shifts — only genuine reorderings cause cell changes. Globally sensitive to node insertion: adding one node shifts every rank above it, potentially moving many cells. Best for static graphs.

**Fixed Gaussian boundaries:** place boundaries at Φ⁻¹(i / GRID_SIZE). Gives a fixed coordinate system — node insertion does not shift other nodes' cells. Concentrates resolution near the distribution center. Assumes approximately Gaussian positions after blending, which weakens when one weight dominates and the distribution becomes multimodal.

The current implementation defaults to Gaussian quantization, using a Gaussian CDF as a fixed coordinate mapping. This is a reasonable fit when blended coordinates are roughly bell-shaped, but it is an approximation rather than a guarantee. In practice it tends to preserve density structure better than rank quantization: clusters remain tighter and sparse regions remain more spread out. Rank-based quantization is available as a toggle for cases where the post-blend distribution departs significantly from Gaussian (e.g., high α with topology smoothing, or when a single weight dominates and the distribution becomes multimodal).

Either way the output is a uint16 coordinate pair (gx, gy) — four stored bytes per node. All zoom cell indices derive from these stored uint16 coordinates via bit shifts.

---

## Hierarchical zoom levels

At level L: `cx = gx >> (16 − L)`, cell ID = `(cx << L) | cy`. Level 1 is a 2×2 grid; level 14 is 16384×16384. Bit-prefix containment is exact and unconditional — a node's cell at level L is always a sub-cell of its cell at level L−1, for every node at every level regardless of data distribution or parameter values.

---

## Supernode aggregation

Nodes sharing a cell at level L form a supernode. Cross-cell edges become weighted supernode edges with weight equal to the count of underlying cross-cell edges. Supernode position is the centroid of member post-quantization display coordinates, not the original continuous blended coordinates. This is an approximation: the quantization transform (rank ordering or Φ(z)) is nonlinear, so centroids in quantized space differ from centroids in blended space. The discrepancy is typically small at fine zoom levels, where each cell covers a narrow local region, and can be more noticeable at coarse levels (L1-L3). Storing pre-quantization coordinates would fix this at a cost of 8 bytes per node. Level structures are built lazily on first access and invalidated on parameter change.

---

## Known limitations

- Jaccard is crude for continuous or ordinal properties; results are discretisation-sensitive
- 2D projection does not preserve pairwise distances; layout reflects coarse ordering, not metric geometry
- Rank quantization (when selected) destroys density information; Gaussian quantization preserves it but assumes approximately normal marginals
- High topology weight causes oversmoothing in well-connected components
- Rank quantization is globally unstable under node insertion; Gaussian quantization is locally stable but nodes in distribution tails may cluster at grid boundaries
- **Low-entropy and undefined-value collapse mitigated by adaptive weight floor.** Empty fields produce neutral `[0,0]` projections; low-entropy properties (few distinct values) produce few distinct projection points. The adaptive weight floor (10% of max weight, minimum 0.10) ensures zero-weight high-entropy groups always contribute spreading. With 3 zero-weight groups, the dominant group controls ~77% of layout — enough to preserve intent while preventing degenerate clustering. Trade-off: the floor spreads nodes using dimensions the user deprioritized, so the spreading axis does not reflect the user's stated preferences. When many nodes share the same undefined value under a dominant group, some edge concentration still occurs.
- Layout quality depends heavily on tokenisation and grouping quality; the pipeline faithfully preserves whatever similarity it is given

---

## Open validation questions

The system requires empirical evaluation against: semantic neighbourhood preservation metrics; stability under strength changes and node insertion; oversmoothing onset as a function of α, passes, and graph structure; and task-based user evaluation for property graph exploration compared against force-directed, spectral, and embedding-based baselines.

---

## Complexity

| Phase                         | Cost                   |
| ----------------------------- | ---------------------- |
| Group projections             | O(n · k · G)           |
| Unified blend                 | O(passes · (n + E))    |
| Quantization (rank)           | O(n log n)             |
| Quantization (gaussian)       | O(n)                   |
| Level construction            | O(n + E) per level, lazy |
| Per-node zoom-cell derivation | O(1)                   |

**Memory per node:** 2G floats for fixed projections + four bytes for uint16 grid coordinates.

---

## References

- E. Cohen, "MinHash Sketches: A Brief Survey," *Encyclopedia of Algorithms*, 2016.
  Survey of MinHash sketch variants (k-mins, bottom-k, k-partition), Jaccard
  estimation, mergeability, and weighted extensions. BitZoom uses k-mins sketches
  at k=128 as described in this survey.
- E. Cohen, "Size-estimation framework with applications to transitive closure and
  reachability," *J. Comput. System Sci.*, 55:441-453, 1997. First application of
  MinHash sketches to estimate set relations in graphs — the foundational technique
  BitZoom builds on.
- E. Cohen, D. Delling, F. Fuchs, A. Goldberg, M. Goldszmidt, and R. Werneck,
  "Scalable similarity estimation in social networks: closeness, node labels, and
  random edge lengths," *COSN*, ACM, 2013. Combines structural (graph distance)
  and label-based similarity using sketches — conceptually close to BitZoom's
  property + topology blend.
- A. Z. Broder, "On the resemblance and containment of documents," *Compression and
  Complexity of Sequences*, IEEE, 1997. Coined the term MinHash; classic application
  for near-duplicate detection via set similarity.
- P. Li, A. B. Owen, and C-H Zhang, "One permutation hashing," *NIPS*, 2012.
  OPH with densification, used by BitZoom for nodes with >= 12 tokens to reduce
  from k hash evaluations per token to one.