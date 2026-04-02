# Keyboard Node Navigation

## Key Map

| Key | Action |
|-----|--------|
| **Arrow Up/Down/Left/Right** | Spatial: jump to nearest connected neighbor in that direction |
| **N** | Graph walk: next neighbor in sorted order |
| **Shift+N** | Graph walk: previous neighbor in sorted order |
| **Enter** | Open detail panel |
| **, / .** | Zoom level down / up (replaces Arrow Left/Right) |
| **Escape** | Deselect, exit node nav |
| **Home** | Select highest-degree visible node (entry point) |

## Neighbor Sort Order

When selection changes, build a sorted neighbor list once:

1. Primary: edge weight descending (strongest connection first)
2. Tiebreak: angle from 12 o'clock, clockwise (0° = up, 90° = right, 180° = down, 270° = left)

Angles computed from selected node's screen position to each neighbor's screen position.

## Navigation Modes

**N / Shift+N (graph walk):** Steps through the sorted neighbor list sequentially. First N goes to the highest-weight neighbor (or 12 o'clock if equal weight). Wraps at ends.

**Arrow keys (spatial):** From the same neighbor list, pick the candidate with the best angular match to the arrow direction. Score by angular proximity to target direction, weighted against distance. Skip if no neighbor within a ±90° cone.

Both modes share the same sorted neighbor list.

## Interaction Flow

1. User tabs to canvas (normal browser focus)
2. **Home** or any **Arrow** to select first node — node nav mode active
3. **Arrows** to explore spatially, **N/Shift+N** to walk connections
4. **Escape** deselects, exits node nav
5. **Enter** opens detail panel (viewer only)

## Edge Cases

- **No selection + Arrow/N/Home**: select highest-degree visible node
- **No neighbors in arrow direction** (±90° cone empty): no-op
- **Disconnected node**: N does nothing, announce "no connections"
- **Level change while navigating**: clear neighbor list, keep selection. Next N/Arrow rebuilds from new level's edges
- **snEdges not ready** (async build): fall back to member-level adjList overlap, or announce "edges loading"
- **Off-screen neighbor**: pan to center it after selecting
- **Wrap**: N past last neighbor wraps to first

## Data Sources

- **Raw level**: `adjList` for neighbor ids, `nodeIndexFull` for lookup
- **Aggregated levels**: `snEdges` for neighbor bids + weights, `level._snByBid` for lookup
- **Screen positions**: `worldToScreen(node.x, node.y)` for angle/distance calculations

## Files to Change

| File | Change |
|------|--------|
| `bitzoom-canvas.js` | Add `_navNeighbors` list, `_navIndex`. Add N/Shift+N/Arrow/Home/Enter handlers. Change , / . for level. Build neighbor list on selection change. Pan + select + announce on each step. Update help text. |
| `bitzoom-renderer.js` | No changes — selected node already renders with full highlight |
| `bitzoom-viewer.js` | Wire Enter to `_showDetail()`. Change level key handlers from Arrow to , / . |
