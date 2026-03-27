export function adjustCliffBorderVertices(feature, chunkData, chunkSize, cliffDropHeight) {
    const path = feature.parameters.path;
    if (!path || path.length === 0) return;
    const baseHeight = chunkData.getHeight(Math.floor(path[0].x), Math.floor(path[0].y));
    const dropHeight = cliffDropHeight;
    const topHeight = baseHeight;
    const bottomHeight = baseHeight - dropHeight;
    feature.parameters.dropHeight = dropHeight;

    for (const point of path) {
        const x = Math.floor(point.x);
        const y = Math.floor(point.y);

        if (x >= 0 && x < chunkSize && y >= 0 && y < chunkSize) {
            chunkData.setHeight(x, y, topHeight);
            if (y + 1 < chunkSize) {
                chunkData.setHeight(x, y + 1, bottomHeight);
            }
            feature.borderVertices.push({
                x: x,
                y: y,
                z: topHeight,
                type: 'cliff_top'
            });
            if (y + 1 < chunkSize) {
                feature.borderVertices.push({
                    x: x,
                    y: y + 1,
                    z: bottomHeight,
                    type: 'cliff_bottom'
                });
            }
            // Smooth transition on adjacent vertices
            const transitionDistance = 2;
            for (let dy = -transitionDistance; dy <= transitionDistance; dy++) {
                for (let dx = -transitionDistance; dx <= transitionDistance; dx++) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (
                        nx >= 0 && nx < chunkSize &&
                        ny >= 0 && ny < chunkSize &&
                        (dx !== 0 || dy !== 0)
                    ) {
                        const distance = Math.sqrt(dx * dx + dy * dy);
                        if (distance <= transitionDistance) {
                            const factor = 1 - (distance / transitionDistance);
                            const currentHeight = chunkData.getHeight(nx, ny);
                            const targetHeight = dy > 0 ? bottomHeight : topHeight;
                            const blendedHeight = currentHeight + (targetHeight - currentHeight) * factor * 0.3;
                            chunkData.setHeight(nx, ny, blendedHeight);
                        }
                    }
                }
            }
        }
    }
}

export function adjustRockBorderVertices(/* feature, chunkData, chunkSize */) {
    // Optional: flatten region, decorate, or leave as-is for rocks.
}