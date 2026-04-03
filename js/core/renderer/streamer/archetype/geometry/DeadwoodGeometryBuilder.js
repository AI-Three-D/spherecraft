// js/renderer/streamer/archetype/geometry/DeadwoodGeometryBuilder.js
//
// Two deadwood types in one file — they share UV conventions and the
// "bark + exposed-wood" material split:
//
//   buildLog(lod)   — horizontal trunk fragment along X axis. Bark v∈[0, 0.8],
//                     endcap (exposed grain) v∈[0.8, 1.0]. Near LODs get a
//                     small broken branch scar and irregular storm/beaver-cut
//                     end geometry instead of clean sawed discs.
//
//   buildStump(lod) — vertical truncated cone with jagged broken top.
//                     Bark v∈[0, 0.8], broken top surface v∈[0.8, 1.0].
//
// uvRegionSplit = 0.8 for both (goes in variant record slot [38]).

import { AssetGeometryBuilder } from '../../AssetGeometryBuilder.js';

const UV_SPLIT = 0.8;

export class DeadwoodGeometryBuilder {

    // ═════════════════════════════════════════════════════════════════════════
    // LOG
    // ═════════════════════════════════════════════════════════════════════════
    //
    // LOD 0: 8 sides, 2 endcaps, 1 branch stub
    // LOD 1: 6 sides, 2 endcaps, 1 branch stub (smaller)
    // LOD 2: 5 sides, 2 endcaps, no stub
    // LOD 3: 4 sides, no endcaps, no stub (bare prism)
    // LOD 4: single billboard
    //
    // Dimensions: length 1.0 (x ∈ [-0.5, 0.5]), radius 0.13.
    // Center axis sits AT y = radius so the log rests on the ground plane,
    // not half-buried.

    static buildLog(lod = 0) {
        const R = 0.13;
        const HALF_LEN = 0.5;

        if (lod === 0) return DeadwoodGeometryBuilder._buildLogFull(10, R, HALF_LEN, true,  0.050);
        if (lod === 1) return DeadwoodGeometryBuilder._buildLogFull(8,  R, HALF_LEN, true,  0.040);
        if (lod === 2) return DeadwoodGeometryBuilder._buildLogFull(6,  R, HALF_LEN, false, 0);
        if (lod === 3) return DeadwoodGeometryBuilder._buildLogBark(4, R, HALF_LEN);
        return AssetGeometryBuilder._buildSingleBillboard();
    }

    static _buildLogFull(sides, radius, halfLen, withStub, stubRadius) {
        const leftProfile = DeadwoodGeometryBuilder._buildEndProfile(sides, radius, halfLen, -1);
        const rightProfile = DeadwoodGeometryBuilder._buildEndProfile(sides, radius, halfLen, 1);
        const geos = [
            DeadwoodGeometryBuilder._buildLogBark(sides, radius, halfLen, leftProfile, rightProfile),
            DeadwoodGeometryBuilder._buildLogEndcap(sides, radius, leftProfile, -1),
            DeadwoodGeometryBuilder._buildLogEndcap(sides, radius, rightProfile, 1),
        ];
        if (withStub) {
            geos.push(DeadwoodGeometryBuilder._buildBranchScar(
                Math.max(7, sides),
                0.14,
                radius,
                stubRadius,
                0.105,
                0.22
            ));
        }
        return AssetGeometryBuilder._mergeGeometries(geos);
    }

    // ─── Log bark cylinder (along X axis) ───────────────────────────────────
    //
    // Standard cylinder rotated 90°: angle θ sweeps the YZ plane.
    // Log center axis at y = radius (resting on ground, not embedded).
    //
    // UV: u wraps circumference, v maps x ∈ [-halfLen, halfLen] → [0, UV_SPLIT]

    static _buildLogBark(sides, radius, halfLen, leftProfile = null, rightProfile = null) {
        const vertCount = (sides + 1) * 2;
        const positions = new Float32Array(vertCount * 3);
        const normals   = new Float32Array(vertCount * 3);
        const uvs       = new Float32Array(vertCount * 2);
        const indices   = new Uint16Array(sides * 6);

        const cy = radius; // center Y (resting on ground)
        const left = leftProfile ?? DeadwoodGeometryBuilder._buildEndProfile(sides, radius, halfLen, -1);
        const right = rightProfile ?? DeadwoodGeometryBuilder._buildEndProfile(sides, radius, halfLen, 1);

        for (let i = 0; i <= sides; i++) {
            const angle = (i / sides) * Math.PI * 2;
            const ny = Math.cos(angle);
            const nz = Math.sin(angle);
            const radialScale = DeadwoodGeometryBuilder._logRadiusScale(angle);
            const ry = ny * radius * radialScale;
            const rz = nz * radius * radialScale;
            const u = i / sides;
            const dx = left[i] - right[i];
            const invLen = 1 / Math.max(0.01, halfLen * 2);
            const approxNx = -dx * invLen;
            const nLen = Math.hypot(approxNx, ny, nz) || 1;

            // Left end (x = -halfLen)
            const li = i * 2;
            positions[li * 3]     = left[i];
            positions[li * 3 + 1] = cy + ry;
            positions[li * 3 + 2] = rz;
            normals[li * 3]     = approxNx / nLen;
            normals[li * 3 + 1] = ny / nLen;
            normals[li * 3 + 2] = nz / nLen;
            uvs[li * 2]     = u;
            uvs[li * 2 + 1] = 0;

            // Right end (x = +halfLen)
            const ri = li + 1;
            positions[ri * 3]     = right[i];
            positions[ri * 3 + 1] = cy + ry;
            positions[ri * 3 + 2] = rz;
            normals[ri * 3]     = approxNx / nLen;
            normals[ri * 3 + 1] = ny / nLen;
            normals[ri * 3 + 2] = nz / nLen;
            uvs[ri * 2]     = u;
            uvs[ri * 2 + 1] = UV_SPLIT;
        }

        for (let i = 0; i < sides; i++) {
            const bl = i * 2, br = bl + 2, tl = bl + 1, tr = br + 1;
            const idx = i * 6;
            indices[idx]     = bl; indices[idx + 1] = br; indices[idx + 2] = tl;
            indices[idx + 3] = tl; indices[idx + 4] = br; indices[idx + 5] = tr;
        }

        return { positions, normals, uvs, indices, indexCount: indices.length };
    }

    // ─── Log endcap disc ────────────────────────────────────────────────────
    //
    // Flat disc at x = xPos, normal = (nSign, 0, 0).
    // Triangle fan: center vertex + rim ring.
    //
    // UV: rim at v = UV_SPLIT (continuous with bark edge), center at v = 1.0.
    //     u wraps with angle so an endgrain-ring texture can work.
    //
    // Winding: must flip for the -X endcap so both face outward.

    static _buildLogEndcap(sides, radius, profile, nSign) {
        const vertCount = sides + 2; // center + rim (+1 wrap)
        const positions = new Float32Array(vertCount * 3);
        const normals   = new Float32Array(vertCount * 3);
        const uvs       = new Float32Array(vertCount * 2);
        const indices   = new Uint16Array(sides * 3);

        const cy = radius;
        let centerX = 0;
        for (let i = 0; i < sides; i++) centerX += profile[i];
        centerX /= Math.max(1, sides);
        centerX -= nSign * radius * 0.18;

        // Center vertex
        positions[0] = centerX;
        positions[1] = cy;
        positions[2] = 0;
        normals[0] = nSign; normals[1] = 0; normals[2] = 0;
        uvs[0] = 0.5;
        uvs[1] = 1.0;

        // Rim
        for (let i = 0; i <= sides; i++) {
            const angle = (i / sides) * Math.PI * 2;
            const ry = Math.cos(angle);
            const rz = Math.sin(angle);
            const radialScale = DeadwoodGeometryBuilder._logRadiusScale(angle);
            const vi = 1 + i;
            positions[vi * 3]     = profile[i];
            positions[vi * 3 + 1] = cy + ry * radius * radialScale;
            positions[vi * 3 + 2] = rz * radius * radialScale;
            const edgeLean = 0.24;
            const nx = nSign;
            const ny = ry * edgeLean;
            const nz = rz * edgeLean;
            const nLen = Math.hypot(nx, ny, nz) || 1;
            normals[vi * 3]     = nx / nLen;
            normals[vi * 3 + 1] = ny / nLen;
            normals[vi * 3 + 2] = nz / nLen;
            uvs[vi * 2]     = i / sides;
            uvs[vi * 2 + 1] = UV_SPLIT;
        }

        // Fan — flip winding for -X endcap
        for (let i = 0; i < sides; i++) {
            const a = 1 + i;
            const b = 1 + i + 1;
            const idx = i * 3;
            if (nSign > 0) {
                indices[idx] = 0; indices[idx + 1] = a; indices[idx + 2] = b;
            } else {
                indices[idx] = 0; indices[idx + 1] = b; indices[idx + 2] = a;
            }
        }

        return { positions, normals, uvs, indices, indexCount: indices.length };
    }

    // ─── Branch scar / broken nub ──────────────────────────────────────────
    //
    // A short closed protrusion with a flared base, so the attachment reads
    // as a torn-off branch scar rather than a hexagonal hole punched into the
    // bark. The cap is blended toward the axis normal to stay rounded.

    static _buildBranchScar(sides, xOff, logR, scarR, scarLen, forwardLean) {
        const ringCount = 3;
        const vertCount = (sides + 1) * ringCount + (sides + 2);
        const positions = new Float32Array(vertCount * 3);
        const normals   = new Float32Array(vertCount * 3);
        const uvs       = new Float32Array(vertCount * 2);
        const indices = [];

        const theta = -0.42;
        const radialY = Math.cos(theta);
        const radialZ = Math.sin(theta);
        const base = [
            xOff,
            logR + radialY * logR * 0.94,
            radialZ * logR * 0.94,
        ];
        const axis = DeadwoodGeometryBuilder._normalize([
            forwardLean,
            radialY * 0.96,
            radialZ * 1.08,
        ]);
        const tangent = DeadwoodGeometryBuilder._normalize(
            DeadwoodGeometryBuilder._cross(axis, [0, 0, 1])
        );
        const bitangent = DeadwoodGeometryBuilder._normalize(
            DeadwoodGeometryBuilder._cross(axis, tangent)
        );
        const ringOffsets = [0.0, scarLen * 0.42, scarLen];
        const ringRadii = [scarR * 1.18, scarR * 0.86, scarR * 0.38];
        const ringDepth = [-scarLen * 0.06, scarLen * 0.12, scarLen * 0.04];

        for (let ring = 0; ring < ringCount; ring++) {
            for (let i = 0; i <= sides; i++) {
                const angle = (i / sides) * Math.PI * 2;
                const ca = Math.cos(angle);
                const sa = Math.sin(angle);
                const elliptical = 1.0 + 0.22 * Math.cos(angle * 2.0 + 0.35);
                const radial = [
                    tangent[0] * (ca * elliptical) + bitangent[0] * (sa * 0.78),
                    tangent[1] * (ca * elliptical) + bitangent[1] * (sa * 0.78),
                    tangent[2] * (ca * elliptical) + bitangent[2] * (sa * 0.78),
                ];
                const radialDir = DeadwoodGeometryBuilder._normalize(radial);
                const jitter = 1.0 + 0.08 * Math.sin(angle * 3.0 + ring * 0.7);
                const r = ringRadii[ring] * jitter;
                const axisOffset = ringOffsets[ring] + Math.max(0, ca) * ringDepth[ring];
                const px = base[0] + axis[0] * axisOffset + radialDir[0] * r;
                const py = base[1] + axis[1] * axisOffset + radialDir[1] * r;
                const pz = base[2] + axis[2] * axisOffset + radialDir[2] * r;
                const vi = ring * (sides + 1) + i;

                positions[vi * 3] = px;
                positions[vi * 3 + 1] = py;
                positions[vi * 3 + 2] = pz;
                normals[vi * 3] = radialDir[0];
                normals[vi * 3 + 1] = radialDir[1];
                normals[vi * 3 + 2] = radialDir[2];
                uvs[vi * 2] = i / sides;
                uvs[vi * 2 + 1] = UV_SPLIT * (0.18 + ring * 0.18);
            }
        }

        for (let ring = 0; ring < ringCount - 1; ring++) {
            for (let i = 0; i < sides; i++) {
                const row = ring * (sides + 1);
                const nextRow = (ring + 1) * (sides + 1);
                const bl = row + i;
                const br = row + i + 1;
                const tl = nextRow + i;
                const tr = nextRow + i + 1;
                indices.push(bl, br, tl, tl, br, tr);
            }
        }

        const capBase = ringCount * (sides + 1);
        const capCenter = capBase;
        const capTip = [
            base[0] + axis[0] * (scarLen * 1.08),
            base[1] + axis[1] * (scarLen * 1.08),
            base[2] + axis[2] * (scarLen * 1.08),
        ];
        positions[capCenter * 3] = capTip[0];
        positions[capCenter * 3 + 1] = capTip[1];
        positions[capCenter * 3 + 2] = capTip[2];
        normals[capCenter * 3] = axis[0];
        normals[capCenter * 3 + 1] = axis[1];
        normals[capCenter * 3 + 2] = axis[2];
        uvs[capCenter * 2] = 0.5;
        uvs[capCenter * 2 + 1] = UV_SPLIT * 0.86;

        const tipRingStart = (ringCount - 1) * (sides + 1);
        for (let i = 0; i <= sides; i++) {
            const src = tipRingStart + i;
            const dst = capBase + 1 + i;
            positions[dst * 3] = positions[src * 3];
            positions[dst * 3 + 1] = positions[src * 3 + 1];
            positions[dst * 3 + 2] = positions[src * 3 + 2];
            const nx = normals[src * 3] * 0.45 + axis[0] * 0.55;
            const ny = normals[src * 3 + 1] * 0.45 + axis[1] * 0.55;
            const nz = normals[src * 3 + 2] * 0.45 + axis[2] * 0.55;
            const nLen = Math.hypot(nx, ny, nz) || 1;
            normals[dst * 3] = nx / nLen;
            normals[dst * 3 + 1] = ny / nLen;
            normals[dst * 3 + 2] = nz / nLen;
            uvs[dst * 2] = i / sides;
            uvs[dst * 2 + 1] = UV_SPLIT;
        }

        for (let i = 0; i < sides; i++) {
            const a = capBase + 1 + i;
            const b = capBase + 1 + i + 1;
            indices.push(capCenter, a, b);
        }

        return {
            positions,
            normals,
            uvs,
            indices: new Uint16Array(indices),
            indexCount: indices.length
        };
    }

    static _buildEndProfile(sides, radius, halfLen, sign) {
        const profile = new Float32Array(sides + 1);
        for (let i = 0; i <= sides; i++) {
            const angle = (i / sides) * Math.PI * 2;
            const notch = Math.max(0, Math.cos(angle - sign * 0.55)) * 0.030;
            const chew = 0.018 * Math.sin(angle * 2.0 + sign * 0.7)
                + 0.010 * Math.sin(angle * 5.0 - sign * 0.3);
            const inset = radius * 0.16 + notch + chew;
            profile[i] = sign < 0
                ? -halfLen + inset
                : halfLen - inset;
        }
        return profile;
    }

    static _logRadiusScale(angle) {
        return 1.0
            + 0.07 * Math.sin(angle * 2.0 + 0.35)
            + 0.03 * Math.sin(angle * 5.0 - 0.8);
    }

    static _cross(a, b) {
        return [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ];
    }

    static _normalize(v) {
        const len = Math.hypot(v[0], v[1], v[2]) || 1;
        return [v[0] / len, v[1] / len, v[2] / len];
    }

    // ═════════════════════════════════════════════════════════════════════════
    // STUMP
    // ═════════════════════════════════════════════════════════════════════════
    //
    // LOD 0: 8 sides, jagged top
    // LOD 1: 6 sides, jagged top
    // LOD 2: 5 sides, flat top
    // LOD 3: diamond
    // LOD 4: single billboard
    //
    // Dimensions: height ~0.28, base radius 0.16, top radius 0.13.
    // Jagged top = top-ring vertices have per-angle height jitter, making
    // the break look splintered rather than clean-sawn.

    static buildStump(lod = 0) {
        if (lod === 0) return DeadwoodGeometryBuilder._buildStumpFull(8, 0.16, 0.13, 0.28, 0.09);
        if (lod === 1) return DeadwoodGeometryBuilder._buildStumpFull(6, 0.16, 0.13, 0.28, 0.07);
        if (lod === 2) return DeadwoodGeometryBuilder._buildStumpFull(5, 0.16, 0.13, 0.27, 0.0);
        if (lod === 3) return AssetGeometryBuilder._buildDiamond(0.20, 0.18);
        return AssetGeometryBuilder._buildSingleBillboard();
    }

    static _buildStumpFull(sides, rBase, rTop, height, jagAmount) {
        // Generate deterministic jagged heights for the top ring
        // (seeded so the same LOD always produces the same shape)
        let seed = 48611;
        const rng = () => {
            seed = (seed * 16807) % 2147483647;
            return (seed & 0x7FFFFFFF) / 2147483647;
        };

        const topHeights = new Float32Array(sides + 1);
        for (let i = 0; i < sides; i++) {
            // Alternate high/low for a splinter pattern, plus random jitter
            const base = (i % 2 === 0) ? 0.7 : -0.4;
            topHeights[i] = height + (base + (rng() - 0.5)) * jagAmount;
        }
        topHeights[sides] = topHeights[0]; // wrap

        const barkGeo = DeadwoodGeometryBuilder._buildStumpBark(
            sides, rBase, rTop, topHeights
        );
        const topGeo = DeadwoodGeometryBuilder._buildStumpTop(
            sides, rTop, topHeights
        );

        return AssetGeometryBuilder._mergeGeometries([barkGeo, topGeo]);
    }

    // ─── Stump bark (tapered, jagged top ring) ──────────────────────────────
    //
    // UV v ∈ [0, UV_SPLIT]. The jagged top means different columns of bark
    // have slightly different v at the top — the texture will stretch a bit
    // there, which actually enhances the broken-wood look.

    static _buildStumpBark(sides, rBase, rTop, topHeights) {
        const vertCount = (sides + 1) * 2;
        const positions = new Float32Array(vertCount * 3);
        const normals   = new Float32Array(vertCount * 3);
        const uvs       = new Float32Array(vertCount * 2);
        const indices   = new Uint16Array(sides * 6);

        // Approximate slope normal (ignoring jag — jag is small)
        const avgH = topHeights[0]; // close enough
        const slopeY = (rBase - rTop) / Math.max(0.01, avgH);
        const slopeLen = Math.sqrt(1 + slopeY * slopeY);
        const nY = slopeY / slopeLen;
        const nR = 1 / slopeLen;

        for (let i = 0; i <= sides; i++) {
            const angle = (i / sides) * Math.PI * 2;
            const ax = Math.cos(angle);
            const az = Math.sin(angle);
            const u = i / sides;
            const topH = topHeights[i];

            const bi = i * 2;
            positions[bi * 3]     = ax * rBase;
            positions[bi * 3 + 1] = 0;
            positions[bi * 3 + 2] = az * rBase;
            normals[bi * 3]     = ax * nR;
            normals[bi * 3 + 1] = nY;
            normals[bi * 3 + 2] = az * nR;
            uvs[bi * 2]     = u;
            uvs[bi * 2 + 1] = 0;

            const ti = bi + 1;
            positions[ti * 3]     = ax * rTop;
            positions[ti * 3 + 1] = topH;
            positions[ti * 3 + 2] = az * rTop;
            normals[ti * 3]     = ax * nR;
            normals[ti * 3 + 1] = nY;
            normals[ti * 3 + 2] = az * nR;
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

    // ─── Stump top (broken surface) ─────────────────────────────────────────
    //
    // Triangle fan from a central peak to the jagged rim. The center peak
    // sits slightly above the average rim height — broken wood often has
    // a raised heartwood center where the splinters taper inward.
    //
    // UV v ∈ [UV_SPLIT, 1.0]: rim at UV_SPLIT (matches bark top), center at 1.0.
    // Normals: mostly +Y with a small radial lean on rim verts for shading
    // interest (catches light on the splintered edges).

    static _buildStumpTop(sides, rTop, topHeights) {
        const vertCount = sides + 2; // center + rim (+1 wrap)
        const positions = new Float32Array(vertCount * 3);
        const normals   = new Float32Array(vertCount * 3);
        const uvs       = new Float32Array(vertCount * 2);
        const indices   = new Uint16Array(sides * 3);

        // Center peak: slightly above average rim
        let avgH = 0;
        for (let i = 0; i < sides; i++) avgH += topHeights[i];
        avgH /= sides;
        const peakH = avgH + 0.03;

        positions[0] = 0;
        positions[1] = peakH;
        positions[2] = 0;
        normals[0] = 0; normals[1] = 1; normals[2] = 0;
        uvs[0] = 0.5;
        uvs[1] = 1.0;

        // Rim ring
        for (let i = 0; i <= sides; i++) {
            const angle = (i / sides) * Math.PI * 2;
            const ax = Math.cos(angle);
            const az = Math.sin(angle);
            const vi = 1 + i;

            positions[vi * 3]     = ax * rTop;
            positions[vi * 3 + 1] = topHeights[i];
            positions[vi * 3 + 2] = az * rTop;

            // Normal: mostly up, slight outward lean
            const lean = 0.25;
            let nx = ax * lean, ny = 1.0, nz = az * lean;
            const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
            normals[vi * 3]     = nx / nLen;
            normals[vi * 3 + 1] = ny / nLen;
            normals[vi * 3 + 2] = nz / nLen;

            uvs[vi * 2]     = i / sides;
            uvs[vi * 2 + 1] = UV_SPLIT;
        }

        // Fan — CCW looking down from +Y
        for (let i = 0; i < sides; i++) {
            const a = 1 + i;
            const b = 1 + i + 1;
            const idx = i * 3;
            indices[idx]     = 0;
            indices[idx + 1] = b;
            indices[idx + 2] = a;
        }

        return { positions, normals, uvs, indices, indexCount: indices.length };
    }
}
