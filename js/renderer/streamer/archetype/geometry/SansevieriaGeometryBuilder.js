// js/renderer/streamer/archetype/geometry/SansevieriaGeometryBuilder.js
//
// Repurposes the old low-poly "fern" into a sansevieria / snake-plant
// rosette. Leaves stay thick, upright, and sword-like rather than trying
// to mimic compound fern fronds.

import { AssetGeometryBuilder } from '../../AssetGeometryBuilder.js';

export class SansevieriaGeometryBuilder {

    static buildSansevieria(lod = 0) {
        if (lod === 0) return SansevieriaGeometryBuilder._buildRosette(8, 6, 0.80, 0.26, 0.12, 0.08);
        if (lod === 1) return SansevieriaGeometryBuilder._buildRosette(7, 5, 0.74, 0.24, 0.11, 0.07);
        if (lod === 2) return SansevieriaGeometryBuilder._buildRosette(5, 4, 0.68, 0.22, 0.10, 0.06);
        if (lod === 3) return AssetGeometryBuilder._buildCrossedBillboards(2);
        return AssetGeometryBuilder._buildSingleBillboard();
    }

    static _buildRosette(leafCount, segments, height, reach, width, inwardCurl) {
        let seed = 91423;
        const rng = () => {
            seed = (seed * 16807) % 2147483647;
            return (seed & 0x7FFFFFFF) / 2147483647;
        };

        const goldenAngle = Math.PI * (3.0 - Math.sqrt(5.0));
        const geos = [];

        for (let i = 0; i < leafCount; i++) {
            const baseAngle = i * goldenAngle;
            const jitterAngle = baseAngle + (rng() - 0.5) * 0.28;
            const hScale = 0.82 + rng() * 0.28;
            const rScale = 0.80 + rng() * 0.20;
            const wScale = 0.75 + rng() * 0.45;
            const curl = inwardCurl * (0.7 + rng() * 0.8);
            geos.push(SansevieriaGeometryBuilder._buildLeaf(
                segments,
                jitterAngle,
                height * hScale,
                reach * rScale,
                width * wScale,
                curl
            ));
        }

        return AssetGeometryBuilder._mergeGeometries(geos);
    }

    static _buildLeaf(segments, yaw, height, reach, width, inwardCurl) {
        const vertCount = (segments + 1) * 2;
        const triCount = segments * 2;
        const positions = new Float32Array(vertCount * 3);
        const normals = new Float32Array(vertCount * 3);
        const uvs = new Float32Array(vertCount * 2);
        const indices = new Uint16Array(triCount * 3);

        const cosYaw = Math.cos(yaw);
        const sinYaw = Math.sin(yaw);
        const radialX = cosYaw;
        const radialZ = sinYaw;
        const widthX = -sinYaw;
        const widthZ = cosYaw;

        for (let i = 0; i <= segments; i++) {
            const t = i / segments;
            const y = height * (t * (0.84 + 0.16 * t));
            const radial = reach * t * (0.55 + 0.45 * t);
            const curl = inwardCurl * t * t;
            const halfWidth = width * (1.0 - t * t * 0.75);
            const cx = radialX * radial - radialX * curl;
            const cz = radialZ * radial - radialZ * curl;

            const li = i * 2;
            positions[li * 3] = cx - widthX * halfWidth;
            positions[li * 3 + 1] = y;
            positions[li * 3 + 2] = cz - widthZ * halfWidth;
            positions[(li + 1) * 3] = cx + widthX * halfWidth;
            positions[(li + 1) * 3 + 1] = y;
            positions[(li + 1) * 3 + 2] = cz + widthZ * halfWidth;

            var nx = radialX * (0.65 + t * 0.15);
            var ny = 0.45 + t * 0.55;
            var nz = radialZ * (0.65 + t * 0.15);
            const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;
            nx /= nLen;
            ny /= nLen;
            nz /= nLen;

            normals[li * 3] = nx;
            normals[li * 3 + 1] = ny;
            normals[li * 3 + 2] = nz;
            normals[(li + 1) * 3] = nx;
            normals[(li + 1) * 3 + 1] = ny;
            normals[(li + 1) * 3 + 2] = nz;

            uvs[li * 2] = 0.0;
            uvs[li * 2 + 1] = t;
            uvs[(li + 1) * 2] = 1.0;
            uvs[(li + 1) * 2 + 1] = t;
        }

        for (let i = 0; i < segments; i++) {
            const bl = i * 2;
            const br = bl + 1;
            const tl = bl + 2;
            const tr = bl + 3;
            const idx = i * 6;
            indices[idx] = bl;
            indices[idx + 1] = br;
            indices[idx + 2] = tl;
            indices[idx + 3] = tl;
            indices[idx + 4] = br;
            indices[idx + 5] = tr;
        }

        return { positions, normals, uvs, indices, indexCount: indices.length };
    }
}
