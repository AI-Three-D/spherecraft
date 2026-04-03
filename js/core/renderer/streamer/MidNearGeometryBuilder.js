// js/renderer/streamer/MidNearGeometryBuilder.js

export class MidNearGeometryBuilder {

    static buildCanopyHull(lon = 12, lat = 8) {
        const positions = [];
        const normals   = [];
        const uvs       = [];
        const indices   = [];

        for (let la = 0; la <= lat; la++) {
            const latT = la / lat;
            const phi  = latT * Math.PI;
            const sinP = Math.sin(phi);
            const cosP = Math.cos(phi);

            for (let lo = 0; lo <= lon; lo++) {
                const lonT  = lo / lon;
                const theta = lonT * Math.PI * 2;
                const x = sinP * Math.cos(theta);
                const y = cosP;
                const z = sinP * Math.sin(theta);

                positions.push(x, y, z);
                normals.push(x, y, z);
                uvs.push(lonT, 1.0 - latT);
            }
        }

        for (let la = 0; la < lat; la++) {
            for (let lo = 0; lo < lon; lo++) {
                const a = la * (lon + 1) + lo;
                const b = a + 1;
                const c = a + (lon + 1);
                const d = c + 1;
                indices.push(a, c, b,  b, c, d);
            }
        }

        return {
            positions:  new Float32Array(positions),
            normals:    new Float32Array(normals),
            uvs:        new Float32Array(uvs),
            indices:    new Uint16Array(indices),
            indexCount: indices.length,
            vertexCount: (lat + 1) * (lon + 1),
        };
    }

    // ───────────────────────────────────────────────────────────────────────
    // TRUNK CYLINDER
    // ───────────────────────────────────────────────────────────────────────

    static buildTrunkCylinder(options = {}) {
        const SIDES     = options.sides     ?? 8;
        const topR      = options.taperTop  ?? 0.60;
        const embedFrac = options.embedFrac ?? 0.08;

        const positions = [];
        const normals   = [];
        const uvs       = [];
        const indices   = [];

        for (let ring = 0; ring < 2; ring++) {
            const y = ring === 0 ? -embedFrac : 1.0;
            const r = ring === 0 ? 1.0 : topR;
            const v = ring === 0 ? 0.0 : 1.0;

            for (let s = 0; s <= SIDES; s++) {
                const t = s / SIDES;
                const ang = t * Math.PI * 2;
                const cx = Math.cos(ang);
                const sz = Math.sin(ang);

                positions.push(cx * r, y, sz * r);
                normals.push(cx, 0, sz);
                uvs.push(t, v);
            }
        }

        const rowLen = SIDES + 1;
        for (let s = 0; s < SIDES; s++) {
            const a = s;
            const b = s + 1;
            const c = s + rowLen;
            const d = s + rowLen + 1;
            indices.push(a, c, b,  b, c, d);
        }

        return {
            positions:  new Float32Array(positions),
            normals:    new Float32Array(normals),
            uvs:        new Float32Array(uvs),
            indices:    new Uint16Array(indices),
            indexCount: indices.length,
        };
    }

    // ───────────────────────────────────────────────────────────────────────
    // IMPOSTOR CARD SET — unchanged
    // ───────────────────────────────────────────────────────────────────────

    static buildImpostorCardSet() {
        const positions = [];
        const normals   = [];
        const uvs       = [];
        const indices   = [];
        let vBase = 0;

        const pushQuad = (angleRad) => {
            const c = Math.cos(angleRad);
            const s = Math.sin(angleRad);
            const nx = s, ny = 0, nz = c;
            const qp = [
                [-0.42, -0.45, 0], [0.42, -0.45, 0], [0.42, 0.75, 0], [-0.42, 0.75, 0]
            ];
            const quv = [[0,0],[1,0],[1,1],[0,1]];

            for (let i = 0; i < 4; i++) {
                const [lx, ly, lz] = qp[i];
                const rx = lx * c - lz * s;
                const rz = lx * s + lz * c;
                positions.push(rx, ly, rz);
                normals.push(nx, ny, nz);
                uvs.push(quv[i][0], quv[i][1]);
            }

            indices.push(vBase+0, vBase+1, vBase+2,  vBase+0, vBase+2, vBase+3);
            vBase += 4;
        };

        const starIdxStart = indices.length;
        pushQuad(0);
        pushQuad(Math.PI / 3);
        pushQuad(Math.PI * 2 / 3);
        const starIdxCount = indices.length - starIdxStart;

        const crossIdxStart = indices.length;
        pushQuad(0);
        pushQuad(Math.PI / 2);
        const crossIdxCount = indices.length - crossIdxStart;

        const flatIdxStart = indices.length;
        pushQuad(0);
        const flatIdxCount = indices.length - flatIdxStart;

        return {
            positions:  new Float32Array(positions),
            normals:    new Float32Array(normals),
            uvs:        new Float32Array(uvs),
            indices:    new Uint16Array(indices),
            indexCount: indices.length,
            shapeRanges: [
                { firstIndex: starIdxStart,  indexCount: starIdxCount  },
                { firstIndex: crossIdxStart, indexCount: crossIdxCount },
                { firstIndex: flatIdxStart,  indexCount: flatIdxCount  },
            ],
        };
    }
}
