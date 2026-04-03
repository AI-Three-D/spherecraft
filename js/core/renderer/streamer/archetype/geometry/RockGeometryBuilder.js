// js/renderer/streamer/archetype/geometry/RockGeometryBuilder.js
//
// Noise-displaced icosphere rocks. The rock sits partly embedded in the
// ground (centerY < radius) with bottom displacement attenuated so it
// looks naturally settled rather than balanced on a point.
//
// Normals are recomputed post-displacement via face-averaging — the
// analytical sphere normals would be visibly wrong on a lumpy surface.

import { AssetGeometryBuilder } from '../../AssetGeometryBuilder.js';

export class RockGeometryBuilder {

    // ─── PUBLIC ENTRY ───────────────────────────────────────────────────────
    //
    // LOD 0: subdiv=2 (~162 verts, 320 tris), full displacement
    // LOD 1: subdiv=1 (~42 verts,   80 tris), moderate displacement
    // LOD 2: subdiv=0 ( 12 verts,   20 tris), light displacement
    // LOD 3: diamond (6 verts, 8 tris)
    // LOD 4: single billboard (4 verts, 2 tris)

    static buildRock(lod = 0) {
        if (lod === 0) return RockGeometryBuilder._buildDisplacedRock(2, 0.22, 0.18, 0.42);
        if (lod === 1) return RockGeometryBuilder._buildDisplacedRock(1, 0.16, 0.18, 0.42);
        if (lod === 2) return RockGeometryBuilder._buildDisplacedRock(0, 0.10, 0.16, 0.40);
        if (lod === 3) return AssetGeometryBuilder._buildDiamond(0.18, 0.38);
        return AssetGeometryBuilder._buildSingleBillboard();
    }

    // ═════════════════════════════════════════════════════════════════════════
    // DISPLACED ROCK BUILDER
    //
    // Process:
    //  1. Build unit icosphere verts + faces
    //  2. Displace each vertex along its normal by coherent 3D noise
    //     — noise is position-based so all subdiv levels sample the SAME
    //       underlying shape (coarser LODs are decimations, not new rocks)
    //     — bottom verts get attenuated displacement (grounded look)
    //  3. Compress bottom half (y<0) to squash the rock into the terrain
    //  4. Scale to radius, translate to centerY
    //  5. Recompute smooth normals from displaced faces
    //
    // Known limitation: spherical UV mapping has a seam at u=0/1 (same as
    // the existing _buildIcosphere). Fine for procedural shading; would
    // need vertex duplication for atlased textures.
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * @param {number} subdivisions — icosphere subdiv level (0-2)
     * @param {number} dispAmount   — max displacement as fraction of radius
     * @param {number} centerY      — Y position of rock center
     * @param {number} radius       — base radius before displacement
     */
    static _buildDisplacedRock(subdivisions, dispAmount, centerY, radius) {
        const { verts, faces } = RockGeometryBuilder._icoVertsAndFaces(subdivisions);

        // ── Displace along unit-sphere normals ───────────────────────────
        // verts[i] is already unit-length (normalized in _icoVertsAndFaces).
        // Noise is coherent in space so adjacent verts displace similarly —
        // this gives lumpy surfaces, not spiky noise.
        for (let i = 0; i < verts.length; i++) {
            const [nx, ny, nz] = verts[i];

            // Bottom attenuation: verts near ny=-1 barely displace
            const groundFactor = Math.min(1.0, 0.35 + (ny + 1.0) * 0.45);

            const noise = RockGeometryBuilder._rockNoise(nx, ny, nz);
            const d = 1.0 + noise * dispAmount * groundFactor;

            let px = nx * d;
            let py = ny * d;
            let pz = nz * d;

            // Squash bottom half — rock looks settled, not spherical
            if (py < 0) {
                py *= 0.55;
            }

            [px, py, pz] = RockGeometryBuilder._applyFacetCuts(px, py, pz);

            verts[i] = [px, py, pz];
        }

        // ── Pack into typed arrays, scale + translate ────────────────────
        const vertCount = verts.length;
        const positions = new Float32Array(vertCount * 3);
        const uvs       = new Float32Array(vertCount * 2);

        for (let i = 0; i < vertCount; i++) {
            const [x, y, z] = verts[i];
            positions[i * 3]     = x * radius;
            positions[i * 3 + 1] = y * radius + centerY;
            positions[i * 3 + 2] = z * radius;

            // Spherical UV from pre-displacement normal direction
            // (using displaced position would stretch UVs on lumps)
            const len = Math.sqrt(x * x + y * y + z * z) || 1;
            const ux = x / len, uy = y / len, uz = z / len;
            uvs[i * 2]     = 0.5 + Math.atan2(uz, ux) / (2 * Math.PI);
            uvs[i * 2 + 1] = 0.5 - Math.asin(Math.max(-1, Math.min(1, uy))) / Math.PI;
        }

        const indices = new Uint16Array(faces.length * 3);
        for (let i = 0; i < faces.length; i++) {
            indices[i * 3]     = faces[i][0];
            indices[i * 3 + 1] = faces[i][1];
            indices[i * 3 + 2] = faces[i][2];
        }

        // ── Recompute normals from displaced geometry ────────────────────
        const normals = RockGeometryBuilder._computeSmoothNormals(
            positions, indices, vertCount
        );

        const seamSafeGeometry = RockGeometryBuilder._unwrapSeamTriangles(
            positions, normals, uvs, indices
        );

        return {
            positions: seamSafeGeometry.positions,
            normals: seamSafeGeometry.normals,
            uvs: seamSafeGeometry.uvs,
            indices: seamSafeGeometry.indices,
            indexCount: seamSafeGeometry.indices.length
        };
    }

    // ─── Icosphere construction (raw verts/faces, not final arrays) ────────
    //
    // Duplicated from AssetGeometryBuilder._buildIcosphere because we need
    // the intermediate {verts, faces} representation to displace BEFORE
    // finalizing — the existing builder goes straight to typed arrays.

    static _icoVertsAndFaces(subdivisions) {
        const t = (1 + Math.sqrt(5)) / 2;
        let verts = [
            [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
            [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
            [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
        ];
        let faces = [
            [0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],
            [1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],
            [3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],
            [4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1],
        ];

        // Normalize base verts to unit sphere
        for (let i = 0; i < verts.length; i++) {
            const [x, y, z] = verts[i];
            const len = Math.sqrt(x * x + y * y + z * z);
            verts[i] = [x / len, y / len, z / len];
        }

        for (let s = 0; s < subdivisions; s++) {
            const midCache = {};
            const newFaces = [];
            for (const [a, b, c] of faces) {
                const ab = RockGeometryBuilder._icoMidpoint(verts, a, b, midCache);
                const bc = RockGeometryBuilder._icoMidpoint(verts, b, c, midCache);
                const ca = RockGeometryBuilder._icoMidpoint(verts, c, a, midCache);
                newFaces.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
            }
            faces = newFaces;
        }

        return { verts, faces };
    }

    static _icoMidpoint(verts, a, b, cache) {
        const key = Math.min(a, b) + '_' + Math.max(a, b);
        if (cache[key] !== undefined) return cache[key];
        const va = verts[a], vb = verts[b];
        // Normalize midpoint back onto unit sphere
        const mx = (va[0] + vb[0]) * 0.5;
        const my = (va[1] + vb[1]) * 0.5;
        const mz = (va[2] + vb[2]) * 0.5;
        const len = Math.sqrt(mx * mx + my * my + mz * mz) || 1;
        verts.push([mx / len, my / len, mz / len]);
        cache[key] = verts.length - 1;
        return cache[key];
    }

    // ─── Coherent noise ─────────────────────────────────────────────────────
    //
    // Sum of sine waves at mismatched frequencies/phases. Not as good as
    // Perlin/simplex but: deterministic, cheap, spatially coherent, and
    // produces perfectly acceptable rock lumps. Output ≈ [-1, 1].

    static _rockNoise(x, y, z) {
        // Low-freq major lumps
        const lump =
            Math.sin(x * 3.17 + 0.73) *
            Math.cos(y * 2.41 + 1.19) *
            Math.sin(z * 2.83 - 0.51);
        // Mid-freq secondary bumps
        const mid =
            Math.sin(x * 5.71 - z * 4.13 + 2.1) *
            Math.cos(y * 4.91 + 0.37);
        // High-freq surface detail (only matters at subdiv=2)
        const detail =
            Math.sin(x * 9.31 + y * 7.79) *
            Math.cos(z * 8.53 - 1.7);
        // Ridged chips to keep edges from reading too melted/smooth
        const chipsA = 1.0 - Math.abs(
            Math.sin(x * 11.2 - y * 7.4 + 1.3) *
            Math.cos(z * 10.6 + 0.8)
        );
        const chipsB = 1.0 - Math.abs(
            Math.sin(z * 13.7 + x * 6.2 - 0.5) *
            Math.cos(y * 9.1 - 1.1)
        );
        const chips = Math.pow(Math.max(0, chipsA * 0.55 + chipsB * 0.45), 2.6);
        // Sparse directional grooves create occasional harder edges/cracks.
        const planeA = x * 0.78 - y * 0.41 + z * 0.47 + 0.12;
        const planeB = -x * 0.34 + y * 0.86 + z * 0.38 - 0.08;
        const planeC = x * 0.55 + y * 0.22 - z * 0.80 + 0.04;
        const grooveA = Math.pow(Math.max(0, 1.0 - Math.abs(planeA) * 8.5), 3.8);
        const grooveB = Math.pow(Math.max(0, 1.0 - Math.abs(planeB) * 9.5), 4.2);
        const grooveC = Math.pow(Math.max(0, 1.0 - Math.abs(planeC) * 7.8), 3.4);
        const grooveMask = Math.max(grooveA * 0.9, Math.max(grooveB * 0.75, grooveC * 0.65));
        const grooveGate = Math.max(0, Math.sin(x * 2.7 + z * 3.9 + 0.8) * 0.5 + 0.5);
        const grooves = grooveMask * grooveGate;

        return lump * 0.54 + mid * 0.24 + detail * 0.08 + chips * 0.18 - grooves * 0.22;
    }

    static _applyFacetCuts(px, py, pz) {
        let x = px;
        let y = py;
        let z = pz;

        const cuts = [
            { dir: [0.84, 0.20, 0.50], threshold: 0.78, strength: 0.95 },
            { dir: [-0.56, 0.72, 0.41], threshold: 0.74, strength: 0.88 },
            { dir: [0.31, -0.18, 0.93], threshold: 0.82, strength: 0.78 },
        ];

        for (const cut of cuts) {
            const nx = cut.dir[0];
            const ny = cut.dir[1];
            const nz = cut.dir[2];
            const signed = x * nx + y * ny + z * nz - cut.threshold;
            if (signed > 0) {
                x -= nx * signed * cut.strength;
                y -= ny * signed * cut.strength;
                z -= nz * signed * cut.strength;
            }
        }

        // Narrow notch-like cut to imply a fractured ridge line.
        const notchPlane = x * 0.62 - y * 0.41 + z * 0.66 - 0.10;
        const notchWidth = 0.08;
        const notch = Math.max(0, 1.0 - Math.abs(notchPlane) / notchWidth);
        const notchGate = Math.max(0, x * 0.55 + z * 0.35 + 0.15);
        const notchDepth = notch * notchGate * 0.16;
        x -= 0.62 * notchDepth;
        y += 0.41 * notchDepth;
        z -= 0.66 * notchDepth;

        return [x, y, z];
    }

    // ─── Smooth normal recomputation ────────────────────────────────────────
    //
    // Standard face-averaged smooth normals: accumulate face normals at each
    // vertex (weighted equally — area-weighting would be marginally better
    // but not worth the complexity for rocks), then normalize.

    static _computeSmoothNormals(positions, indices, vertCount) {
        const normals = new Float32Array(vertCount * 3); // zeroed

        const triCount = indices.length / 3;
        for (let t = 0; t < triCount; t++) {
            const i0 = indices[t * 3];
            const i1 = indices[t * 3 + 1];
            const i2 = indices[t * 3 + 2];

            const ax = positions[i0 * 3],     ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
            const bx = positions[i1 * 3],     by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2];
            const cx = positions[i2 * 3],     cy = positions[i2 * 3 + 1], cz = positions[i2 * 3 + 2];

            // Face normal = (B-A) × (C-A)
            const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
            const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
            const fnx = e1y * e2z - e1z * e2y;
            const fny = e1z * e2x - e1x * e2z;
            const fnz = e1x * e2y - e1y * e2x;

            // Accumulate (un-normalized — larger faces naturally weight more)
            normals[i0 * 3] += fnx; normals[i0 * 3 + 1] += fny; normals[i0 * 3 + 2] += fnz;
            normals[i1 * 3] += fnx; normals[i1 * 3 + 1] += fny; normals[i1 * 3 + 2] += fnz;
            normals[i2 * 3] += fnx; normals[i2 * 3 + 1] += fny; normals[i2 * 3 + 2] += fnz;
        }

        // Normalize
        for (let i = 0; i < vertCount; i++) {
            const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
            normals[i * 3]     = nx / len;
            normals[i * 3 + 1] = ny / len;
            normals[i * 3 + 2] = nz / len;
        }

        return normals;
    }

    static _unwrapSeamTriangles(positions, normals, uvs, indices) {
        const outPositions = Array.from(positions);
        const outNormals = Array.from(normals);
        const outUvs = Array.from(uvs);
        const outIndices = new Uint16Array(indices.length);

        const appendVertex = (sourceIndex, uOffset = 0) => {
            const srcPos = sourceIndex * 3;
            const srcUv = sourceIndex * 2;
            const newIndex = outPositions.length / 3;

            outPositions.push(
                positions[srcPos],
                positions[srcPos + 1],
                positions[srcPos + 2]
            );
            outNormals.push(
                normals[srcPos],
                normals[srcPos + 1],
                normals[srcPos + 2]
            );
            outUvs.push(
                uvs[srcUv] + uOffset,
                uvs[srcUv + 1]
            );

            return newIndex;
        };

        for (let tri = 0; tri < indices.length; tri += 3) {
            const triIndices = [
                indices[tri],
                indices[tri + 1],
                indices[tri + 2]
            ];
            const triUs = triIndices.map(index => uvs[index * 2]);
            const minU = Math.min(triUs[0], triUs[1], triUs[2]);
            const maxU = Math.max(triUs[0], triUs[1], triUs[2]);

            if (maxU - minU > 0.5) {
                for (let i = 0; i < 3; i++) {
                    if (triUs[i] < 0.5) {
                        triIndices[i] = appendVertex(triIndices[i], 1.0);
                    }
                }
            }

            outIndices[tri] = triIndices[0];
            outIndices[tri + 1] = triIndices[1];
            outIndices[tri + 2] = triIndices[2];
        }

        return {
            positions: new Float32Array(outPositions),
            normals: new Float32Array(outNormals),
            uvs: new Float32Array(outUvs),
            indices: outIndices,
        };
    }
}
