// js/renderer/streamer/archetype/geometry/FernGeometryBuilder.js
//
// Ferns are built from a handful of curved frond cards. The detailed frond
// silhouette comes from the albedo texture alpha, not from zig-zag geometry.

import { AssetGeometryBuilder } from '../../../../core/renderer/streamer/AssetGeometryBuilder.js';

export class FernGeometryBuilder {

    static buildFern(lod = 0) {
        if (lod === 0) return FernGeometryBuilder._buildClump(9, 14, 1.02, 0.54, 0.26);
        if (lod === 1) return FernGeometryBuilder._buildClump(7, 11, 0.94, 0.50, 0.24);
        if (lod === 2) return FernGeometryBuilder._buildClump(5, 8, 0.84, 0.44, 0.20);
        if (lod === 3) return AssetGeometryBuilder._buildCrossedBillboards(2);
        return AssetGeometryBuilder._buildSingleBillboard();
    }

    static _buildClump(frondCount, segments, height, reach, width) {
        let seed = 48191;
        const rng = () => {
            seed = (seed * 48271) % 2147483647;
            return (seed & 0x7FFFFFFF) / 2147483647;
        };

        const geos = [];
        const goldenAngle = Math.PI * (3.0 - Math.sqrt(5.0));

        for (let i = 0; i < frondCount; i++) {
            const crown = Math.sqrt((i + 0.5) / frondCount);
            const yaw = i * goldenAngle + (rng() - 0.5) * 0.34;
            const frondHeight = height * (0.82 + rng() * 0.28);
            const frondReach = reach * (0.78 + rng() * 0.28);
            const frondWidth = width * (0.82 + rng() * 0.22);
            const droop = 0.06 + crown * (0.16 + rng() * 0.12);
            const curl = (rng() - 0.5) * 0.10;
            const sideSplay = (rng() - 0.5) * 0.12;
            const baseOffset = 0.018 + crown * 0.04;
            const baseLift = 0.015 + rng() * 0.04;

            geos.push(FernGeometryBuilder._buildFrond({
                segments,
                yaw,
                height: frondHeight,
                reach: frondReach,
                width: frondWidth,
                droop,
                curl,
                sideSplay,
                baseOffset,
                baseLift,
            }));
        }

        return AssetGeometryBuilder._mergeGeometries(geos);
    }

    static _buildFrond(params) {
        const {
            segments,
            yaw,
            height,
            reach,
            width,
            droop,
            curl,
            sideSplay,
            baseOffset,
            baseLift,
        } = params;

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

        for (let i = 0; i <= segments; i++) {
            const t = i / segments;
            const radial = baseOffset + reach * Math.pow(t, 0.88);
            const arch = height * Math.sin(t * Math.PI * 0.86);
            const y = baseLift + arch - height * droop * t * t;
            const lateral = sideSplay * Math.sin(t * Math.PI) * (1.0 - 0.25 * t);
            const forwardCurl = curl * t * t;

            const centerX = radialX * (radial + forwardCurl) - radialZ * lateral;
            const centerZ = radialZ * (radial + forwardCurl) + radialX * lateral;

            const nextT = Math.min(1.0, t + (1.0 / Math.max(segments, 1)));
            const nextRadial = baseOffset + reach * Math.pow(nextT, 0.88);
            const nextArch = height * Math.sin(nextT * Math.PI * 0.86);
            const nextY = baseLift + nextArch - height * droop * nextT * nextT;
            const nextLateral = sideSplay * Math.sin(nextT * Math.PI) * (1.0 - 0.25 * nextT);
            const nextCurl = curl * nextT * nextT;
            const nextX = radialX * (nextRadial + nextCurl) - radialZ * nextLateral;
            const nextZ = radialZ * (nextRadial + nextCurl) + radialX * nextLateral;

            var tangentX = nextX - centerX;
            var tangentY = nextY - y;
            var tangentZ = nextZ - centerZ;
            const tangentLen = Math.sqrt(tangentX * tangentX + tangentY * tangentY + tangentZ * tangentZ) || 1.0;
            tangentX /= tangentLen;
            tangentY /= tangentLen;
            tangentZ /= tangentLen;

            var bitangentX = tangentZ;
            var bitangentY = 0.0;
            var bitangentZ = -tangentX;
            let bitangentLen = Math.sqrt(bitangentX * bitangentX + bitangentY * bitangentY + bitangentZ * bitangentZ);
            if (bitangentLen < 1e-4) {
                bitangentX = -radialZ;
                bitangentY = 0.0;
                bitangentZ = radialX;
                bitangentLen = Math.sqrt(bitangentX * bitangentX + bitangentZ * bitangentZ) || 1.0;
            }
            bitangentX /= bitangentLen;
            bitangentZ /= bitangentLen;

            const spread = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.82)), 0.92);
            const tipTaper = 1.0 - Math.max(0.0, t - 0.82) / 0.18;
            const halfWidth = width * spread * (0.22 + 0.78 * tipTaper);

            const roll = (0.08 + 0.12 * t) * Math.sin(t * Math.PI * 1.2);
            const crossUp = roll;

            const li = i * 2;
            positions[li * 3] = centerX - bitangentX * halfWidth;
            positions[li * 3 + 1] = y - crossUp * halfWidth;
            positions[li * 3 + 2] = centerZ - bitangentZ * halfWidth;

            positions[(li + 1) * 3] = centerX + bitangentX * halfWidth;
            positions[(li + 1) * 3 + 1] = y + crossUp * halfWidth;
            positions[(li + 1) * 3 + 2] = centerZ + bitangentZ * halfWidth;

            var nx = tangentY * bitangentZ - tangentZ * crossUp;
            var ny = tangentZ * bitangentX - tangentX * bitangentZ;
            var nz = tangentX * crossUp - tangentY * bitangentX;
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
