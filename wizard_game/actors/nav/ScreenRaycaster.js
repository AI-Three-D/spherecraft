// js/actors/nav/ScreenRaycaster.js
//
// Unprojects a screen-space click to a world-space ray.
// Also provides a CPU sphere-intersect for the planet surface
// as a fast first-pass before GPU terrain raycasting.

export class ScreenRaycaster {
    /**
     * @param {number} screenX  pixel X (0..canvasW)
     * @param {number} screenY  pixel Y (0..canvasH)
     * @param {object} camera   Frontend camera with matrixWorldInverse, projectionMatrix, position
     * @param {number} canvasW
     * @param {number} canvasH
     * @returns {{ origin:{x,y,z}, dir:{x,y,z} }}
     */
    static cast(screenX, screenY, camera, canvasW, canvasH) {
        // NDC: WebGPU y-up in clip space, y-down in framebuffer
        const ndcX = (screenX / canvasW) * 2 - 1;
        const ndcY = 1 - (screenY / canvasH) * 2;

        const ip = _invert4(camera.projectionMatrix.elements);
        // WebGPU NDC Z: near=0 far=1
        const vNear = _transformPoint(ip, ndcX, ndcY, 0);
        const vFar  = _transformPoint(ip, ndcX, ndcY, 1);

        const iv = _invert4(camera.matrixWorldInverse.elements);
        const wNear = _transformPoint(iv, vNear[0], vNear[1], vNear[2]);
        const wFar  = _transformPoint(iv, vFar[0],  vFar[1],  vFar[2]);

        const dx = wFar[0] - wNear[0];
        const dy = wFar[1] - wNear[1];
        const dz = wFar[2] - wNear[2];
        const len = Math.hypot(dx, dy, dz) || 1;

        return {
            origin: { x: wNear[0], y: wNear[1], z: wNear[2] },
            dir:    { x: dx / len, y: dy / len, z: dz / len },
        };
    }

    /**
     * Intersect ray with a sphere. Returns t (distance) or -1 if miss.
     * Used to get a rough terrain hit before GPU refinement.
     */
    static intersectSphere(origin, dir, center, radius) {
        const ox = origin.x - center.x;
        const oy = origin.y - center.y;
        const oz = origin.z - center.z;
        const a = dir.x * dir.x + dir.y * dir.y + dir.z * dir.z;
        const b = 2 * (ox * dir.x + oy * dir.y + oz * dir.z);
        const c = ox * ox + oy * oy + oz * oz - radius * radius;
        const disc = b * b - 4 * a * c;
        if (disc < 0) return -1;
        const sq = Math.sqrt(disc);
        const t0 = (-b - sq) / (2 * a);
        const t1 = (-b + sq) / (2 * a);
        // Return nearest positive
        if (t0 > 0.01) return t0;
        if (t1 > 0.01) return t1;
        return -1;
    }

    /**
     * Convenience: cast + intersect planet sphere, return approximate world pos.
     * @returns {{ hit:boolean, position:{x,y,z}, ray:{origin,dir}, t:number }}
     */
    static castToSphere(screenX, screenY, camera, canvasW, canvasH, planetCenter, planetRadius) {
        const ray = ScreenRaycaster.cast(screenX, screenY, camera, canvasW, canvasH);
        const t = ScreenRaycaster.intersectSphere(ray.origin, ray.dir, planetCenter, planetRadius);
        if (t < 0) return { hit: false, position: null, ray, t: -1 };
        return {
            hit: true,
            position: {
                x: ray.origin.x + ray.dir.x * t,
                y: ray.origin.y + ray.dir.y * t,
                z: ray.origin.z + ray.dir.z * t,
            },
            ray,
            t,
        };
    }
}

// ── Internal math helpers ────────────────────────────────────────────

function _transformPoint(m, x, y, z) {
    const w = m[3]*x + m[7]*y + m[11]*z + m[15];
    const iw = 1 / (w || 1);
    return [
        (m[0]*x + m[4]*y + m[8]*z  + m[12]) * iw,
        (m[1]*x + m[5]*y + m[9]*z  + m[13]) * iw,
        (m[2]*x + m[6]*y + m[10]*z + m[14]) * iw,
    ];
}

function _invert4(a) {
    const b00=a[0]*a[5]-a[1]*a[4], b01=a[0]*a[6]-a[2]*a[4];
    const b02=a[0]*a[7]-a[3]*a[4], b03=a[1]*a[6]-a[2]*a[5];
    const b04=a[1]*a[7]-a[3]*a[5], b05=a[2]*a[7]-a[3]*a[6];
    const b06=a[8]*a[13]-a[9]*a[12], b07=a[8]*a[14]-a[10]*a[12];
    const b08=a[8]*a[15]-a[11]*a[12], b09=a[9]*a[14]-a[10]*a[13];
    const b10=a[9]*a[15]-a[11]*a[13], b11=a[10]*a[15]-a[11]*a[14];
    const id = 1/(b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06);
    return [
        ( a[5]*b11-a[6]*b10+a[7]*b09)*id, (-a[1]*b11+a[2]*b10-a[3]*b09)*id,
        ( a[13]*b05-a[14]*b04+a[15]*b03)*id, (-a[9]*b05+a[10]*b04-a[11]*b03)*id,
        (-a[4]*b11+a[6]*b08-a[7]*b07)*id, ( a[0]*b11-a[2]*b08+a[3]*b07)*id,
        (-a[12]*b05+a[14]*b02-a[15]*b01)*id, ( a[8]*b05-a[10]*b02+a[11]*b01)*id,
        ( a[4]*b10-a[5]*b08+a[7]*b06)*id, (-a[0]*b10+a[1]*b08-a[3]*b06)*id,
        ( a[12]*b04-a[13]*b02+a[15]*b00)*id, (-a[8]*b04+a[9]*b02-a[11]*b00)*id,
        (-a[4]*b09+a[5]*b07-a[6]*b06)*id, ( a[0]*b09-a[1]*b07+a[2]*b06)*id,
        (-a[12]*b03+a[13]*b01-a[14]*b00)*id, ( a[8]*b03-a[9]*b01+a[10]*b00)*id,
    ];
}