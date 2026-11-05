// What the flow costs at a pose: the field's last bake, and the solver's blocks.
export function flowCost() {
    const g = window.gameEngine, s = g.riverFieldService?.stats, w = g.whitewater;
    return { bakeMs: s?.ms ? Math.round(s.ms.total) : null, bakeMainMs: s?.ms ? Math.round(s.ms.main) : null, pages: g.riverFieldService?.pages?.size, blocks: w?.activeCount };
}
