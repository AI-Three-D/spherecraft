// core/planet/surfaceFrame.js
//
// Shared tangent-frame helper: given a point on (or near) a planet's surface
// and the planet's origin, builds a flat local basis (up/right/forward) that
// can be used to approximate a small patch of the sphere as a flat plane.
// Extracted from Frontend._makeSurfaceMatrix so other systems (e.g. the
// river/water simulation) can share the exact same math.

import { Vector3 } from '../../shared/math/index.js';

export function computeSurfaceTangentFrame(worldPos, planetOrigin) {
    const up = new Vector3().subVectors(worldPos, planetOrigin).normalize();
    const ref = Math.abs(up.y) > 0.99
        ? new Vector3(0, 0, 1)
        : new Vector3(0, 1, 0);
    const right = new Vector3().crossVectors(up, ref).normalize();
    const forward = new Vector3().crossVectors(right, up);
    return { up, right, forward };
}
