export function selectBestCandidates(
    candidates, 
    maxFeaturesPerChunk, 
    minFeatureDistance
) {
    candidates.sort((a, b) => b.priority - a.priority);
    const selected = [];
    const minDistanceSquared = minFeatureDistance * minFeatureDistance;
    for (const candidate of candidates) {
        if (selected.length >= maxFeaturesPerChunk) break;
        let tooClose = false;
        for (const existing of selected) {
            const dx = candidate.x - existing.x;
            const dy = candidate.y - existing.y;
            if (dx * dx + dy * dy < minDistanceSquared) {
                tooClose = true;
                break;
            }
        }
        if (!tooClose) selected.push(candidate);
    }
    return selected;
}