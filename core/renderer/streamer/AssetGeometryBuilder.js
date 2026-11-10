// js/renderer/streamer/AssetGeometryBuilder.js
//
// Builds placeholder geometries for all asset categories at each LOD level.
// All geometries are in local space: Y-up, centered at origin base.
// The vertex shader projects them onto the sphere surface per-instance.

export class AssetGeometryBuilder {

    // ─── TREES ──────────────────────────────────────────────────────────────
    static buildTree(lod = 0) {
        if (lod === 0) return AssetGeometryBuilder._buildTrunkOnly(8, 0.06, 0.02, 0.35);
        if (lod === 1) return AssetGeometryBuilder._buildTreeMedium();
        if (lod === 2) return AssetGeometryBuilder._buildTreeLow();
        if (lod === 3) return AssetGeometryBuilder._buildTreeBillboard();
        return AssetGeometryBuilder._buildSingleBillboard();
    }

    // ─── GROUND COVER (Stones) ──────────────────────────────────────────────
    static buildStone(lod = 0) {
        if (lod === 0) return AssetGeometryBuilder._buildIcosphere(0.35, 0.5, 1);
        if (lod === 1) return AssetGeometryBuilder._buildDiamond(0.35, 0.45);
        return AssetGeometryBuilder._buildSingleBillboard();
    }

    // ─── PLANTS (Grass Tufts) ───────────────────────────────────────────────
    // LOD 0: Full 3D tuft — 14 blades, 3 segments each, lush
    // LOD 1: Medium tuft — 9 blades, 3 segments
    // LOD 2: Reduced tuft — 6 blades, 2 segments
    // LOD 3: Crossed billboard tuft — 3 intersecting cards with tuft silhouette
    // LOD 4: Single billboard with tuft alpha shape

    static buildPlant(lod = 0) {
        if (lod === 0) return AssetGeometryBuilder._buildGrassTuft(14, 3, 0.50);
        if (lod === 1) return AssetGeometryBuilder._buildGrassTuft(9,  3, 0.48);
        if (lod === 2) return AssetGeometryBuilder._buildGrassTuft(6,  2, 0.45);
        if (lod === 3) return AssetGeometryBuilder._buildTuftCrossedBillboards(3);
        return AssetGeometryBuilder._buildTuftCrossedBillboards(2);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // GRASS TUFT BUILDER
    //
    // A tuft is a cluster of grass blades arranged to fill a roughly circular
    // footprint WITHOUT visible grid gaps. Blades extend to the edges of the
    // normalized [-0.5, 0.5] local space so adjacent tufts seamlessly tile.
    //
    // Key design decisions:
    //  - Blades use a Poisson-disk-like distribution (stratified jittered grid)
    //    to avoid clumping and ensure even coverage
    //  - Outer blades lean outward to fill gaps between instances
    //  - Each blade curves naturally with randomized bend direction/strength
    //  - Blade width varies to create visual variety
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Build a 3D grass tuft mesh with blades that fill the footprint.
     *
     * @param {number} bladeCount  — total blades in this tuft
     * @param {number} segments    — vertical segments per blade (2-4)
     * @param {number} spread      — radius of tuft footprint in local space
     * @returns {{ positions: Float32Array, normals: Float32Array,
     *             uvs: Float32Array, indices: Uint16Array, indexCount: number }}
     */
    static _buildGrassTuft(bladeCount, segments, spread) {
        // Deterministic RNG (simple LCG) — geometry is shared across all
        // instances of this LOD. Per-instance variety comes from the scatter
        // shader (rotation, scale, color).
        let seed = 73939;
        const rng = () => {
            seed = (seed * 16807 + 0) % 2147483647;
            return (seed & 0x7FFFFFFF) / 2147483647;
        };

        // ── Generate blade positions using stratified jittered grid ──────
        // This avoids clumping and guarantees even coverage of the footprint
        const bladeConfigs = AssetGeometryBuilder._generateBladePositions(
            bladeCount, spread, rng
        );

        const bladeGeos = [];
        for (const cfg of bladeConfigs) {
            bladeGeos.push(AssetGeometryBuilder._buildSingleTuftBlade(
                segments,
                cfg.offsetX, cfg.offsetZ,
                cfg.bladeAngle,
                cfg.curveDirX, cfg.curveDirZ,
                cfg.heightScale, cfg.widthScale,
                cfg.leanX, cfg.leanZ
            ));
        }

        return AssetGeometryBuilder._mergeGeometries(bladeGeos);
    }

    /**
     * Generate evenly-distributed blade positions within a circular footprint
     * using a stratified jittered grid approach.
     *
     * Blades near the edge lean outward to fill gaps between adjacent instances.
     */
    static _generateBladePositions(count, spread, rng) {
        const configs = [];

        // Use golden-angle spiral for even distribution
        const goldenAngle = Math.PI * (3.0 - Math.sqrt(5.0));

        for (let i = 0; i < count; i++) {
            // Sunflower/Fibonacci spiral distribution
            // sqrt gives uniform area density on disk
            const t = (i + 0.5) / count;
            const r = Math.sqrt(t) * spread;
            const theta = i * goldenAngle;

            // Add jitter to break the spiral pattern
            const jitterR = r + (rng() - 0.5) * spread * 0.15;
            const jitterTheta = theta + (rng() - 0.5) * 0.4;

            const offsetX = Math.cos(jitterTheta) * jitterR;
            const offsetZ = Math.sin(jitterTheta) * jitterR;

            // Blade rotation — mostly random but with slight radial bias
            const bladeAngle = rng() * Math.PI * 2;

            // Curve: outer blades curve more, inner blades curve less
            const radialFraction = jitterR / Math.max(spread, 0.001);
            const curveStrength = 0.10 + rng() * 0.30 + radialFraction * 0.15;
            const curveAngle = rng() * Math.PI * 2;
            const curveDirX = Math.cos(curveAngle) * curveStrength;
            const curveDirZ = Math.sin(curveAngle) * curveStrength;

            // Height variation: center blades taller, edge blades shorter
            const centerBias = 1.0 - radialFraction * 0.3;
            const heightScale = (0.55 + rng() * 0.45) * centerBias;

            // Width variation
            const widthScale = 0.6 + rng() * 0.8;

            // Lean: outer blades lean outward to fill inter-instance gaps
            const leanStrength = radialFraction * 0.25;
            const leanDirX = radialFraction > 0.01
                ? (offsetX / jitterR) * leanStrength : 0;
            const leanDirZ = radialFraction > 0.01
                ? (offsetZ / jitterR) * leanStrength : 0;

            configs.push({
                offsetX, offsetZ, bladeAngle,
                curveDirX, curveDirZ,
                heightScale, widthScale,
                leanX: leanDirX, leanZ: leanDirZ
            });
        }

        return configs;
    }

    /**
     * Build a single curved grass blade for inclusion in a tuft.
     *
     * The blade is a tapered strip with `segments` vertical divisions.
     * It curves and leans to create natural-looking grass.
     *
     * @param {number} segments    — vertical segment count (2-4)
     * @param {number} offsetX    — X position within tuft
     * @param {number} offsetZ    — Z position within tuft
     * @param {number} bladeAngle — rotation around Y (radians)
     * @param {number} curveDirX  — X curve direction
     * @param {number} curveDirZ  — Z curve direction
     * @param {number} heightScale — blade height multiplier
     * @param {number} widthScale  — blade width multiplier
     * @param {number} leanX      — outward lean X
     * @param {number} leanZ      — outward lean Z
     */
    static _buildSingleTuftBlade(segments, offsetX, offsetZ, bladeAngle,
                                  curveDirX, curveDirZ, heightScale, widthScale,
                                  leanX = 0, leanZ = 0) {
        const vertCount = (segments + 1) * 2;
        const triCount = segments * 2;
        const positions = new Float32Array(vertCount * 3);
        const normals = new Float32Array(vertCount * 3);
        const uvs = new Float32Array(vertCount * 2);
        const indices = new Uint16Array(triCount * 3);

        const baseWidth = 0.035 * widthScale;
        const cosA = Math.cos(bladeAngle);
        const sinA = Math.sin(bladeAngle);

        for (let i = 0; i <= segments; i++) {
            const t = i / segments;

            // Cubic taper: wide at base, thin at tip
            const width = baseWidth * (1.0 - t * t * t);

            // Height
            const y = t * heightScale;

            // Curve: quadratic increase with height
            const curveT = t * t;
            const cx = curveDirX * curveT;
            const cz = curveDirZ * curveT;

            // Lean: linear increase with height (fills gaps)
            const lx = leanX * t;
            const lz = leanZ * t;

            // Left/right edges perpendicular to blade orientation
            const leftX = -width * cosA;
            const leftZ = -width * sinA;
            const rightX = width * cosA;
            const rightZ = width * sinA;

            const vi = i * 2;

            // Left vertex
            positions[vi * 3]     = offsetX + leftX + cx + lx;
            positions[vi * 3 + 1] = y;
            positions[vi * 3 + 2] = offsetZ + leftZ + cz + lz;

            // Right vertex
            positions[(vi + 1) * 3]     = offsetX + rightX + cx + lx;
            positions[(vi + 1) * 3 + 1] = y;
            positions[(vi + 1) * 3 + 2] = offsetZ + rightZ + cz + lz;

            // Normal: face normal blending to upward at tips
            const faceFactor = 1.0 - t * 0.5;
            const nx = -sinA * faceFactor;
            const ny = 0.3 + t * 0.7;  // tips point more upward
            const nz = cosA * faceFactor;
            const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;

            normals[vi * 3]         = nx / nLen;
            normals[vi * 3 + 1]     = ny / nLen;
            normals[vi * 3 + 2]     = nz / nLen;
            normals[(vi + 1) * 3]     = nx / nLen;
            normals[(vi + 1) * 3 + 1] = ny / nLen;
            normals[(vi + 1) * 3 + 2] = nz / nLen;

            // UV: v goes 0→1 base to tip
            uvs[vi * 2] = 0;
            uvs[vi * 2 + 1] = t;
            uvs[(vi + 1) * 2] = 1;
            uvs[(vi + 1) * 2 + 1] = t;
        }

        for (let i = 0; i < segments; i++) {
            const bl = i * 2;
            const br = bl + 1;
            const tl = bl + 2;
            const tr = bl + 3;
            const idx = i * 6;
            indices[idx]     = bl;
            indices[idx + 1] = br;
            indices[idx + 2] = tl;
            indices[idx + 3] = tl;
            indices[idx + 4] = br;
            indices[idx + 5] = tr;
        }

        return { positions, normals, uvs, indices, indexCount: indices.length };
    }

    // ═════════════════════════════════════════════════════════════════════════
    // CROSSED BILLBOARD TUFTS
    //
    // For mid-range LODs (3-4), we use 2-3 intersecting quads arranged in a
    // star pattern. Each quad has a tuft-shaped silhouette cut into its
    // geometry (not a flat rectangle) — the vertices trace the outline of
    // several grass blades rather than a simple box.
    //
    // This gives a convincing 3D impression from any viewing angle while
    // using very few triangles.
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Build crossed billboard cards with tuft-shaped silhouette.
     * Each card has blade-shaped top edges instead of a flat top.
     *
     * @param {number} cardCount — number of intersecting cards (2-3)
     */
    static _buildTuftCrossedBillboards(cardCount) {
        // Deterministic RNG for blade tip positions
        let seed = 55291;
        const rng = () => {
            seed = (seed * 16807 + 0) % 2147483647;
            return (seed & 0x7FFFFFFF) / 2147483647;
        };

        const geos = [];

        for (let c = 0; c < cardCount; c++) {
            const cardAngle = (c / cardCount) * Math.PI;
            const cardGeo = AssetGeometryBuilder._buildTuftCard(
                cardAngle, rng
            );
            geos.push(cardGeo);
        }

        return AssetGeometryBuilder._mergeGeometries(geos);
    }

    /**
     * Build a single card with grass-blade-shaped top edge.
     *
     * The card has a flat bottom and a jagged top formed by 5-7 "blade tips"
     * of varying heights, creating the silhouette of a grass tuft.
     *
     * @param {number} cardAngle — rotation in XZ plane (radians)
     * @param {Function} rng — random number generator
     */
    static _buildTuftCard(cardAngle, rng) {
        const tipCount = 5;      // blade tips along the top edge
        const halfWidth = 0.48;  // half-width of the card

        const cosA = Math.cos(cardAngle);
        const sinA = Math.sin(cardAngle);

        // Generate tip heights — center tips are taller
        const tipHeights = [];
        for (let i = 0; i < tipCount; i++) {
            const centerDist = Math.abs((i / (tipCount - 1)) - 0.5) * 2; // 0=center, 1=edge
            const baseH = 0.55 + (1.0 - centerDist) * 0.45;
            tipHeights.push(baseH * (0.7 + rng() * 0.3));
        }

        // Each blade tip is a triangle: left base, right base, peak
        // Between tips we have valleys that go down to ~40% height
        // Total vertices: bottom-left, bottom-right + (tipCount * 3) tip triangles
        // Simpler approach: build a strip with bottom edge + shaped top edge

        // Vertices along bottom (y=0) and top (shaped)
        // We create 2 * (tipCount * 2 + 1) vertices
        const topPoints = tipCount * 2 + 1;
        const vertCount = topPoints * 2; // bottom row + top row
        const positions = new Float32Array(vertCount * 3);
        const normalsArr = new Float32Array(vertCount * 3);
        const uvsArr = new Float32Array(vertCount * 2);

        // Normal for this card (perpendicular to card face)
        const nx = -sinA;
        const nz = cosA;

        for (let i = 0; i < topPoints; i++) {
            const u = i / (topPoints - 1); // 0..1 across card width
            const localX = (u - 0.5) * 2 * halfWidth;

            // World-space X and Z from card angle
            const wx = localX * cosA;
            const wz = localX * sinA;

            // Bottom vertex
            const bi = i;
            positions[bi * 3]     = wx;
            positions[bi * 3 + 1] = 0;
            positions[bi * 3 + 2] = wz;
            normalsArr[bi * 3]     = nx;
            normalsArr[bi * 3 + 1] = 0.12;
            normalsArr[bi * 3 + 2] = nz;
            uvsArr[bi * 2]     = u;
            uvsArr[bi * 2 + 1] = 0;

            // Top vertex — shaped height
            const topH = AssetGeometryBuilder._tuffTopHeight(
                u, tipCount, tipHeights
            );
            const ti = topPoints + i;
            positions[ti * 3]     = wx;
            positions[ti * 3 + 1] = topH;
            positions[ti * 3 + 2] = wz;
            normalsArr[ti * 3]     = nx;
            normalsArr[ti * 3 + 1] = 0.18;
            normalsArr[ti * 3 + 2] = nz;
            uvsArr[ti * 2]     = u;
            uvsArr[ti * 2 + 1] = topH;
        }

        // Triangulate: strip between bottom and top rows
        const triCount = (topPoints - 1) * 2;
        const indices = new Uint16Array(triCount * 3);
        for (let i = 0; i < topPoints - 1; i++) {
            const bl = i;
            const br = i + 1;
            const tl = topPoints + i;
            const tr = topPoints + i + 1;
            const idx = i * 6;
            indices[idx]     = bl;
            indices[idx + 1] = br;
            indices[idx + 2] = tl;
            indices[idx + 3] = tl;
            indices[idx + 4] = br;
            indices[idx + 5] = tr;
        }

        return { positions, normals: normalsArr, uvs: uvsArr, indices, indexCount: indices.length };
    }

    /**
     * Compute the top-edge height at a given horizontal position `u` (0..1).
     * Creates a series of blade-tip peaks with valleys between them.
     */
    static _tuffTopHeight(u, tipCount, tipHeights) {
        // Map u to tip space
        const tipU = u * (tipCount - 1);
        const tipIdx = Math.floor(tipU);
        const frac = tipU - tipIdx;

        if (tipIdx >= tipCount - 1) {
            return tipHeights[tipCount - 1] * AssetGeometryBuilder._bladeTipShape(frac);
        }

        // Between two tips: blend with a valley
        const h0 = tipHeights[tipIdx];
        const h1 = tipHeights[Math.min(tipIdx + 1, tipCount - 1)];

        // Shape: each tip rises to a peak, valleys between
        // Use a function that has peaks at 0.5 of each tip's span
        const halfSpan = 0.5;
        const distFromTip0 = Math.abs(frac - halfSpan);
        const distFromTip1 = Math.abs(frac - halfSpan);

        // Smooth blade shape: sharp peak with gradual taper
        const shape0 = AssetGeometryBuilder._bladeTipShape(1.0 - frac);
        const shape1 = AssetGeometryBuilder._bladeTipShape(frac);

        const valleyFloor = 0.15; // minimum height between tips
        return Math.max(valleyFloor, h0 * shape0 + h1 * shape1 - valleyFloor);
    }

    /**
     * Single blade tip shape function.
     * t=0: base of blade, t=1: tip peak
     * Returns height multiplier 0..1
     */
    static _bladeTipShape(t) {
        // Smooth triangle-ish shape: rises quickly, sharp peak
        const x = Math.max(0, Math.min(1, t));
        // Quadratic rise with sharp falloff
        if (x < 0.5) {
            const s = x * 2;
            return s * s * 0.6;
        } else {
            const s = (1.0 - x) * 2;
            return 0.6 + s * 0.4;
        }
    }

    // ─── Existing primitive builders ────────────────────────────────────────

    static _buildTrunkOnly(sides, baseRadius, topRadius, height) {
        const vertCount = (sides + 1) * 2;
        const positions = new Float32Array(vertCount * 3);
        const normals = new Float32Array(vertCount * 3);
        const uvs = new Float32Array(vertCount * 2);
        const indices = new Uint16Array(sides * 6);

        for (let i = 0; i <= sides; i++) {
            const angle = (i / sides) * Math.PI * 2;
            const nx = Math.cos(angle);
            const nz = Math.sin(angle);
            const u = i / sides;

            const bi = i * 2;
            positions[bi * 3]     = nx * baseRadius;
            positions[bi * 3 + 1] = 0;
            positions[bi * 3 + 2] = nz * baseRadius;
            normals[bi * 3]     = nx;
            normals[bi * 3 + 1] = 0;
            normals[bi * 3 + 2] = nz;
            uvs[bi * 2] = u;
            uvs[bi * 2 + 1] = 0;

            const ti = bi + 1;
            positions[ti * 3]     = nx * topRadius;
            positions[ti * 3 + 1] = height;
            positions[ti * 3 + 2] = nz * topRadius;
            normals[ti * 3]     = nx;
            normals[ti * 3 + 1] = 0;
            normals[ti * 3 + 2] = nz;
            uvs[ti * 2] = u;
            uvs[ti * 2 + 1] = 1;
        }

        for (let i = 0; i < sides; i++) {
            const bl = i * 2, br = bl + 2, tl = bl + 1, tr = br + 1;
            const idx = i * 6;
            indices[idx] = bl; indices[idx+1] = br; indices[idx+2] = tl;
            indices[idx+3] = tl; indices[idx+4] = br; indices[idx+5] = tr;
        }

        return { positions, normals, uvs, indices, indexCount: indices.length };
    }

    static _buildTreeDetailed() {
        const sides = 6;
        const trunkR = 0.06;
        const trunkH = 0.35;
        const canopyR = 0.35;
        const canopyCenter = 0.7;
        const trunkGeo = AssetGeometryBuilder._buildCylinder(sides, trunkR, trunkH, 0);
        const canopyGeo = AssetGeometryBuilder._buildIcosphere(canopyCenter, canopyR, 1);
        return AssetGeometryBuilder._mergeGeometries([trunkGeo, canopyGeo]);
    }

    static _buildTreeMedium() {
        const sides = 4;
        const trunkR = 0.07;
        const trunkH = 0.35;
        const canopyR = 0.35;
        const canopyCenter = 0.7;
        const trunkGeo = AssetGeometryBuilder._buildCylinder(sides, trunkR, trunkH, 0);
        const canopyGeo = AssetGeometryBuilder._buildDiamond(canopyCenter, canopyR);
        return AssetGeometryBuilder._mergeGeometries([trunkGeo, canopyGeo]);
    }

    static _buildTreeBillboard() {
        return AssetGeometryBuilder._buildCrossedBillboards(2);
    }

    static _buildTreeLow() {
        const sides = 3;
        const trunkR = 0.07;
        const trunkH = 0.32;
        const canopyR = 0.33;
        const canopyCenter = 0.68;
        const trunkGeo = AssetGeometryBuilder._buildCylinder(sides, trunkR, trunkH, 0);
        const canopyGeo = AssetGeometryBuilder._buildDiamond(canopyCenter, canopyR);
        return AssetGeometryBuilder._mergeGeometries([trunkGeo, canopyGeo]);
    }

    static _buildCylinder(sides, radius, height, baseY) {
        const vertCount = (sides + 1) * 2;
        const positions = new Float32Array(vertCount * 3);
        const normals = new Float32Array(vertCount * 3);
        const uvs = new Float32Array(vertCount * 2);
        const indices = new Uint16Array(sides * 6);

        for (let i = 0; i <= sides; i++) {
            const angle = (i / sides) * Math.PI * 2;
            const nx = Math.cos(angle);
            const nz = Math.sin(angle);
            const u = i / sides;
            const bi = i * 2;
            positions[bi * 3]     = nx * radius;
            positions[bi * 3 + 1] = baseY;
            positions[bi * 3 + 2] = nz * radius;
            normals[bi * 3]     = nx;
            normals[bi * 3 + 2] = nz;
            uvs[bi * 2] = u;
            uvs[bi * 2 + 1] = 0;
            const ti = bi + 1;
            positions[ti * 3]     = nx * radius;
            positions[ti * 3 + 1] = baseY + height;
            positions[ti * 3 + 2] = nz * radius;
            normals[ti * 3]     = nx;
            normals[ti * 3 + 2] = nz;
            uvs[ti * 2] = u;
            uvs[ti * 2 + 1] = height;
        }

        for (let i = 0; i < sides; i++) {
            const bl = i * 2;
            const br = bl + 2;
            const tl = bl + 1;
            const tr = br + 1;
            const idx = i * 6;
            indices[idx]     = bl;
            indices[idx + 1] = br;
            indices[idx + 2] = tl;
            indices[idx + 3] = tl;
            indices[idx + 4] = br;
            indices[idx + 5] = tr;
        }

        return { positions, normals, uvs, indices, indexCount: indices.length };
    }

    static _buildIcosphere(centerY, radius, subdivisions = 0) {
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
        for (let s = 0; s < subdivisions; s++) {
            const midCache = {};
            const newFaces = [];
            for (const [a, b, c] of faces) {
                const ab = AssetGeometryBuilder._getMidpoint(verts, a, b, midCache);
                const bc = AssetGeometryBuilder._getMidpoint(verts, b, c, midCache);
                const ca = AssetGeometryBuilder._getMidpoint(verts, c, a, midCache);
                newFaces.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
            }
            faces = newFaces;
        }
        const positions = new Float32Array(verts.length * 3);
        const normals = new Float32Array(verts.length * 3);
        const uvArr = new Float32Array(verts.length * 2);
        for (let i = 0; i < verts.length; i++) {
            const [x, y, z] = verts[i];
            const len = Math.sqrt(x * x + y * y + z * z);
            const nx = x / len, ny = y / len, nz = z / len;
            positions[i * 3]     = nx * radius;
            positions[i * 3 + 1] = ny * radius + centerY;
            positions[i * 3 + 2] = nz * radius;
            normals[i * 3]     = nx;
            normals[i * 3 + 1] = ny;
            normals[i * 3 + 2] = nz;
            uvArr[i * 2]     = 0.5 + Math.atan2(nz, nx) / (2 * Math.PI);
            uvArr[i * 2 + 1] = 0.5 - Math.asin(ny) / Math.PI;
        }
        const indices = new Uint16Array(faces.length * 3);
        for (let i = 0; i < faces.length; i++) {
            indices[i * 3]     = faces[i][0];
            indices[i * 3 + 1] = faces[i][1];
            indices[i * 3 + 2] = faces[i][2];
        }
        return { positions, normals, uvs: uvArr, indices, indexCount: indices.length };
    }

    static _getMidpoint(verts, a, b, cache) {
        const key = Math.min(a, b) + '_' + Math.max(a, b);
        if (cache[key] !== undefined) return cache[key];
        const va = verts[a], vb = verts[b];
        verts.push([(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2]);
        cache[key] = verts.length - 1;
        return cache[key];
    }

    static _buildDiamond(centerY, radius) {
        const positions = new Float32Array([
            0, centerY + radius, 0,
            0, centerY - radius, 0,
            radius, centerY, 0,
            0, centerY, radius,
            -radius, centerY, 0,
            0, centerY, -radius,
        ]);
        const normals = new Float32Array([
            0, 1, 0, 0, -1, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0, -1,
        ]);
        const uvArr = new Float32Array([
            0.5, 1, 0.5, 0, 1, 0.5, 0.5, 0.5, 0, 0.5, 0.5, 0.5,
        ]);
        const indices = new Uint16Array([
            0, 2, 3,  0, 3, 4,  0, 4, 5,  0, 5, 2,
            1, 3, 2,  1, 4, 3,  1, 5, 4,  1, 2, 5,
        ]);
        return { positions, normals, uvs: uvArr, indices, indexCount: indices.length };
    }

    static _buildBlade(segments) {
        const vertCount = (segments + 1) * 2;
        const triCount = segments * 2;
        const positions = new Float32Array(vertCount * 3);
        const normals = new Float32Array(vertCount * 3);
        const uvs = new Float32Array(vertCount * 2);
        const indices = new Uint16Array(triCount * 3);
        for (let i = 0; i <= segments; i++) {
            const t = i / segments;
            const width = 0.5 * (1.0 - t * t * t);
            const y = t;
            const vi = i * 2;
            positions[vi * 3] = -width;
            positions[vi * 3 + 1] = y;
            positions[vi * 3 + 2] = 0;
            positions[(vi + 1) * 3] = width;
            positions[(vi + 1) * 3 + 1] = y;
            positions[(vi + 1) * 3 + 2] = 0;
            normals[vi * 3 + 2] = 1;
            normals[(vi + 1) * 3 + 2] = 1;
            uvs[vi * 2] = 0;
            uvs[vi * 2 + 1] = t;
            uvs[(vi + 1) * 2] = 1;
            uvs[(vi + 1) * 2 + 1] = t;
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

    static _buildSingleBillboard() {
        const positions = new Float32Array([
            -0.5, 0, 0,  0.5, 0, 0,  -0.5, 1, 0,  0.5, 1, 0,
        ]);
        const normals = new Float32Array([
            0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,
        ]);
        const uvs = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
        const indices = new Uint16Array([0, 1, 2, 2, 1, 3]);
        return { positions, normals, uvs, indices, indexCount: 6 };
    }

    static _buildCrossedBillboards(count = 2) {
        const geos = [];
        for (let b = 0; b < count; b++) {
            const angle = (b / count) * Math.PI;
            const cx = Math.cos(angle) * 0.5;
            const cz = Math.sin(angle) * 0.5;
            const nx = -Math.sin(angle);
            const nz = Math.cos(angle);
            const positions = new Float32Array([
                -cx, 0, -cz,  cx, 0, cz,  -cx, 1, -cz,  cx, 1, cz,
            ]);
            const normals = new Float32Array([
                nx, 0, nz,  nx, 0, nz,  nx, 0, nz,  nx, 0, nz,
            ]);
            const uvs = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
            const indices = new Uint16Array([0, 1, 2, 2, 1, 3]);
            geos.push({ positions, normals, uvs, indices, indexCount: 6 });
        }
        return AssetGeometryBuilder._mergeGeometries(geos);
    }

    static _mergeGeometries(geos) {
        let totalVerts = 0, totalIdx = 0;
        for (const g of geos) {
            totalVerts += g.positions.length / 3;
            totalIdx += g.indexCount;
        }
        const positions = new Float32Array(totalVerts * 3);
        const normals = new Float32Array(totalVerts * 3);
        const uvs = new Float32Array(totalVerts * 2);
        const indices = new Uint16Array(totalIdx);
        let vOffset = 0, iOffset = 0, vBase = 0;
        for (const g of geos) {
            const vCount = g.positions.length / 3;
            positions.set(g.positions, vOffset * 3);
            normals.set(g.normals, vOffset * 3);
            uvs.set(g.uvs, vOffset * 2);
            for (let i = 0; i < g.indexCount; i++) {
                indices[iOffset + i] = g.indices[i] + vBase;
            }
            vOffset += vCount;
            iOffset += g.indexCount;
            vBase += vCount;
        }
        return { positions, normals, uvs, indices, indexCount: totalIdx };
    }
}
