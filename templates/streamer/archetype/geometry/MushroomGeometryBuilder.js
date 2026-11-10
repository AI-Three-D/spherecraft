// js/renderer/streamer/archetype/geometry/MushroomGeometryBuilder.js
//
// Mushroom = tapered stem cylinder + lathed dome cap.
//
// UV split at v=0.4: stem occupies v∈[0, 0.4], cap occupies v∈[0.4, 1.0].
// This lets a single texture (or procedural shader) use the v coordinate
// to select between bark-like stem and smooth cap shading. The split value
// goes into AssetVariant.uvRegionSplit (record slot [38]).
//
// The cap profile has a slight underside overhang — the cap is wider than
// the stem and droops a hair below the stem junction before curving up
// into a dome. This is what makes it read as "mushroom" vs "lamp post".

import { AssetGeometryBuilder } from '../../../../core/renderer/streamer/AssetGeometryBuilder.js';

const UV_SPLIT = 0.4;

export class MushroomGeometryBuilder {

    // ─── PUBLIC ENTRY ───────────────────────────────────────────────────────
    //
    // LOD 0: 16 sides, 8 cap rings
    // LOD 1: 12 sides, 6 cap rings
    // LOD 2: 10 sides, 5 cap rings
    // LOD 3: 2 crossed billboards
    // LOD 4: single billboard
    //
    // Dimensions are normalized to ~unit height so the scatter size range
    // actually controls mushroom size predictably. The stem starts slightly
    // below y=0 so it remains grounded when a little of the base is buried.

    static buildMushroom(lod = 0) {
        if (lod === 0) return MushroomGeometryBuilder._buildFull(16, 8);
        if (lod === 1) return MushroomGeometryBuilder._buildFull(12, 6);
        if (lod === 2) return MushroomGeometryBuilder._buildFull(10, 5);
        if (lod === 3) return AssetGeometryBuilder._buildCrossedBillboards(2);
        return AssetGeometryBuilder._buildSingleBillboard();
    }

    // ─── Parameters (shared across LODs for consistent silhouette) ─────────

    static _PARAMS = {
        stemRadiusBottom: 0.096,
        stemRadiusTop:    0.060,
        stemHeight:       1.24,
        capRadius:        0.511,
        capHeight:        0.48,
        stemEmbed:        0.07,
    };

    // ═════════════════════════════════════════════════════════════════════════
    // FULL MUSHROOM ASSEMBLY
    // ═════════════════════════════════════════════════════════════════════════

    static _buildFull(sides, capRings) {
        const P = MushroomGeometryBuilder._PARAMS;

        const stemGeo = MushroomGeometryBuilder._buildStem(
            sides, P.stemRadiusBottom, P.stemRadiusTop, P.stemHeight, P.stemEmbed
        );
        const capGeo = MushroomGeometryBuilder._buildCap(
            sides, capRings,
            P.stemRadiusTop, P.capRadius, P.stemHeight, P.capHeight
        );

        return AssetGeometryBuilder._mergeGeometries([stemGeo, capGeo]);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // STEM — tapered cylinder, UV v ∈ [0, UV_SPLIT]
    //
    // Can't reuse AssetGeometryBuilder._buildCylinder because:
    //  (a) it doesn't taper
    //  (b) its UV v = raw height, not normalized into a sub-range
    // ═════════════════════════════════════════════════════════════════════════

    static _buildStem(sides, rBottom, rTop, height, embed) {
        const vertCount = (sides + 1) * 2;
        const positions = new Float32Array(vertCount * 3);
        const normals   = new Float32Array(vertCount * 3);
        const uvs       = new Float32Array(vertCount * 2);
        const indices   = new Uint16Array(sides * 6);

        // Slope normal: stem tapers, so normal tilts slightly upward
        // tan(slope) = (rBottom - rTop) / height
        const slopeY = (rBottom - rTop) / height; // small positive
        const slopeLen = Math.sqrt(1 + slopeY * slopeY);
        const normY = slopeY / slopeLen;
        const normR = 1 / slopeLen;

        for (let i = 0; i <= sides; i++) {
            const angle = (i / sides) * Math.PI * 2;
            const ax = Math.cos(angle);
            const az = Math.sin(angle);
            const u = i / sides;

            const bi = i * 2;
            // Bottom ring
            positions[bi * 3]     = ax * rBottom;
            positions[bi * 3 + 1] = -embed;
            positions[bi * 3 + 2] = az * rBottom;
            normals[bi * 3]     = ax * normR;
            normals[bi * 3 + 1] = normY;
            normals[bi * 3 + 2] = az * normR;
            uvs[bi * 2]     = u;
            uvs[bi * 2 + 1] = 0;

            const ti = bi + 1;
            // Top ring
            positions[ti * 3]     = ax * rTop;
            positions[ti * 3 + 1] = height;
            positions[ti * 3 + 2] = az * rTop;
            normals[ti * 3]     = ax * normR;
            normals[ti * 3 + 1] = normY;
            normals[ti * 3 + 2] = az * normR;
            uvs[ti * 2]     = u;
            uvs[ti * 2 + 1] = UV_SPLIT;
        }

        for (let i = 0; i < sides; i++) {
            const bl = i * 2, br = bl + 2, tl = bl + 1, tr = br + 1;
            const idx = i * 6;
            indices[idx]     = bl; indices[idx + 1] = br; indices[idx + 2] = tl;
            indices[idx + 3] = tl; indices[idx + 4] = br; indices[idx + 5] = tr;
        }

        return { positions, normals, uvs, indices, indexCount: indices.length };
    }

    // ═════════════════════════════════════════════════════════════════════════
    // CAP — lathed profile, UV v ∈ [UV_SPLIT, 1.0]
    //
    // Profile is sampled at (capRings + 1) points from stem-join to apex.
    // The first ~15% of the profile forms the underside overhang; the rest
    // is a quarter-circle dome.
    //
    // Normals are derived from the profile tangent: for a profile point
    // moving in direction (dr, dy), the outward surface normal in the
    // profile plane is (dy, -dr). Then spin around Y.
    //
    // Apex is a single vertex (r=0) connected to the last ring by a fan.
    // ═════════════════════════════════════════════════════════════════════════

    static _buildCap(sides, capRings, stemR, capR, stemH, capH) {
        // ── Sample profile ────────────────────────────────────────────────
        // One extra sample for apex → (capRings + 1) profile points total,
        // the last being the apex (r=0, handled separately).
        const ringCount = capRings;           // full rings (before apex)
        const profR = new Float32Array(ringCount);
        const profY = new Float32Array(ringCount);
        const profV = new Float32Array(ringCount);

        for (let i = 0; i < ringCount; i++) {
            // t spans [0, 1) — t=1 is the apex, handled separately
            const t = i / ringCount;
            const p = MushroomGeometryBuilder._capProfile(t, stemR, capR, stemH, capH);
            profR[i] = p.r;
            profY[i] = p.y;
            profV[i] = UV_SPLIT + t * (1.0 - UV_SPLIT);
        }
        const apexY = stemH + capH;
        const apexV = 1.0;

        // ── Compute profile normals (dr, dy → dy, -dr) ────────────────────
        // Use central differences; clamp at ends.
        const profNR = new Float32Array(ringCount); // radial component
        const profNY = new Float32Array(ringCount); // Y component

        for (let i = 0; i < ringCount; i++) {
            const prevI = Math.max(0, i - 1);
            const nextR = (i < ringCount - 1) ? profR[i + 1] : 0;    // apex r=0
            const nextY = (i < ringCount - 1) ? profY[i + 1] : apexY;

            const dr = nextR - profR[prevI];
            const dy = nextY - profY[prevI];
            // Outward normal in profile plane
            let nr = dy;
            let ny = -dr;
            const len = Math.sqrt(nr * nr + ny * ny) || 1;
            profNR[i] = nr / len;
            profNY[i] = ny / len;
        }

        // ── Build geometry ────────────────────────────────────────────────
        // Rings: ringCount × (sides+1) verts. Plus 1 apex vert.
        const ringVerts = (sides + 1);
        const vertCount = ringCount * ringVerts + 1;
        const positions = new Float32Array(vertCount * 3);
        const normals   = new Float32Array(vertCount * 3);
        const uvs       = new Float32Array(vertCount * 2);

        for (let ring = 0; ring < ringCount; ring++) {
            const r = profR[ring];
            const y = profY[ring];
            const v = profV[ring];
            const nR = profNR[ring];
            const nY = profNY[ring];

            for (let s = 0; s <= sides; s++) {
                const angle = (s / sides) * Math.PI * 2;
                const ax = Math.cos(angle);
                const az = Math.sin(angle);
                const vi = ring * ringVerts + s;

                positions[vi * 3]     = ax * r;
                positions[vi * 3 + 1] = y;
                positions[vi * 3 + 2] = az * r;

                normals[vi * 3]     = ax * nR;
                normals[vi * 3 + 1] = nY;
                normals[vi * 3 + 2] = az * nR;

                let planarU = 0.5 + (ax * r) / (capR * 2.1);
                let planarV = 0.5 + (az * r) / (capR * 2.1);
                planarU = Math.max(0.0, Math.min(1.0, planarU));
                planarV = Math.max(0.0, Math.min(1.0, planarV));
                uvs[vi * 2]     = planarU;
                uvs[vi * 2 + 1] = UV_SPLIT + planarV * (1.0 - UV_SPLIT);
            }
        }

        // Apex vertex
        const apexIdx = ringCount * ringVerts;
        positions[apexIdx * 3]     = 0;
        positions[apexIdx * 3 + 1] = apexY;
        positions[apexIdx * 3 + 2] = 0;
        normals[apexIdx * 3]     = 0;
        normals[apexIdx * 3 + 1] = 1;
        normals[apexIdx * 3 + 2] = 0;
        uvs[apexIdx * 2]     = 0.5;
        uvs[apexIdx * 2 + 1] = UV_SPLIT + 0.5 * (1.0 - UV_SPLIT);

        // ── Indices ───────────────────────────────────────────────────────
        // Strips between rings: (ringCount - 1) × sides × 2 tris
        // Apex fan: sides tris
        const stripTris = (ringCount - 1) * sides * 2;
        const fanTris   = sides;
        const indices   = new Uint16Array((stripTris + fanTris) * 3);

        let idxPos = 0;
        for (let ring = 0; ring < ringCount - 1; ring++) {
            for (let s = 0; s < sides; s++) {
                const bl = ring * ringVerts + s;
                const br = bl + 1;
                const tl = (ring + 1) * ringVerts + s;
                const tr = tl + 1;
                indices[idxPos++] = bl; indices[idxPos++] = br; indices[idxPos++] = tl;
                indices[idxPos++] = tl; indices[idxPos++] = br; indices[idxPos++] = tr;
            }
        }
        // Apex fan (last ring → apex)
        const lastRingBase = (ringCount - 1) * ringVerts;
        for (let s = 0; s < sides; s++) {
            const a = lastRingBase + s;
            const b = a + 1;
            indices[idxPos++] = a;
            indices[idxPos++] = b;
            indices[idxPos++] = apexIdx;
        }

        return { positions, normals, uvs, indices, indexCount: indices.length };
    }

    // ─── Cap profile function ───────────────────────────────────────────────
    //
    // t ∈ [0, 1): stem junction → just below apex (apex at t=1 handled caller)
    //
    // t < 0.24: underside shoulder grows out from the stem and dips slightly
    // t ≥ 0.24: round cap dome up to the apex

    static _capProfile(t, stemR, capR, stemH, capH) {
        const undersideFrac = 0.24;

        if (t < undersideFrac) {
            const s = t / undersideFrac;
            const easeS = s * s * (3.0 - 2.0 * s);
            const r = stemR + (capR * 1.05 - stemR) * easeS;
            const dip = capH * 0.16 * Math.sin(s * Math.PI * 0.5);
            const y = stemH - dip;
            return { r, y };
        }

        const s = (t - undersideFrac) / (1.0 - undersideFrac);
        const ang = s * Math.PI * 0.5;
        const r = capR * Math.cos(ang);
        const y = stemH - capH * 0.08 + capH * 1.08 * Math.sin(ang);
        return { r, y };
    }
}
