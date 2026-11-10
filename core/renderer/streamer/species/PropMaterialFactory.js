// js/renderer/streamer/species/PropMaterialFactory.js
//
// Generates procedural texture layer definitions for prop materials
// (tree bark, stones, etc.) keyed by species id.
//
// Each entry produces an array of layer configs compatible with
// ProceduralTextureGenerator. The PropTextureManager consumes these
// to build a texture-2d-array atlas.

import { Logger } from '../../../../shared/Logger.js';

/**
 * @typedef {object} PropTextureDefinition
 * @property {string} id       — matches species id or a synthetic key
 * @property {string} label    — human-readable name
 * @property {Array<object>} layers — ProceduralTextureGenerator layer configs
 */

function birchBarkLayers(seed = 0) {
    return [
        // 1. Bright white base — real birch bark is near-white
        { type: 'fill', color: '#f9f6f2', opacity: 1.0 },

        // 2. Very subtle warm parchment variation (reduced to keep it white)
        {
            type: 'fbm', octaves: 3, frequency: 0.06, amplitude: 0.15,
            persistence: 0.45, color: '#e8e0d4', opacity: 0.06,
            blendMode: 'multiply', seed: seed + 100
        },

        // 3. Primary lenticels — wide horizontal stripes (stretched ~20:1 aspect)
        {
            type: 'horizontal_dashes',
            density: 0.32, minWidth: 0.18, maxWidth: 0.45,
            minHeight: 0.006, maxHeight: 0.016,
            color: '#0e0a06', opacity: 0.78,
            blendMode: 'normal', seed: seed + 200
        },

        // 4. Secondary mid-size lenticels (wider, thinner)
        {
            type: 'horizontal_dashes',
            density: 0.20, minWidth: 0.08, maxWidth: 0.22,
            minHeight: 0.004, maxHeight: 0.009,
            color: '#1a1410', opacity: 0.50,
            blendMode: 'normal', seed: seed + 250
        },

        // 5. Tertiary tiny scratch-like marks (wider)
        {
            type: 'horizontal_dashes',
            density: 0.14, minWidth: 0.03, maxWidth: 0.10,
            minHeight: 0.002, maxHeight: 0.006,
            color: '#2a2218', opacity: 0.30,
            blendMode: 'normal', seed: seed + 270
        },

        // 6. Subtle horizontal banding
        {
            type: 'fbm', octaves: 2, frequency: 0.004,
            amplitude: 0.12, persistence: 0.4,
            color: '#c8bfae', opacity: 0.05,
            blendMode: 'multiply',
            rotation: 90,
            seed: seed + 400
        },

        // 7. Fine surface grain
        {
            type: 'grain', amplitude: 2.2,
            color: '#000000', opacity: 0.04,
            blendMode: 'overlay', seed: seed + 600
        },
        {
            type: 'grain', amplitude: 2.2,
            color: '#ffffff', opacity: 0.03,
            blendMode: 'overlay', seed: seed + 601
        },
    ];
}

/**
 * Birch leaf albedo texture layers.
 * Target: viewed at 20-200cm. Needs:
 *   - Realistic medium green base with slight yellow-green variation
 *   - Pinnate venation: midrib + paired lateral veins curving to margin
 *   - Waxy surface micro-texture (specular highlight variation)
 *   - Darker lamina between veins, lighter along veins (chlorophyll density)
 *   - Slight tooth-edged silhouette irregularity baked into color
 *   - Subtle subsurface color variation (brighter where leaf is thinner)
 *
 * Output is 512×512 RGBA:
 *   RGB: albedo color
 *   A:   transmission mask (bright = thin/translucent, used for SSS in shader)
 */
function birchLeafAlbedoLayers(seed = 0) {
    return [
        // ── 1. Base lamina color ──────────────────────────────────────────
        // Real birch leaf: medium green, slightly yellow-green.
        // Not too saturated — real leaves are ~Munsell 5GY 4/4 to 5/6.
        { type: 'fill', color: '#4a7a38', opacity: 1.0 },

        // ── 2. Large-scale color variation (leaf-to-leaf variability) ─────
        // Individual leaves vary in lightness. Low-frequency FBM gives
        // organic patches of slightly lighter/darker green.
        {
            type: 'fbm', octaves: 3, frequency: 0.04, amplitude: 0.28,
            persistence: 0.48, color: '#5a9040', opacity: 0.22,
            blendMode: 'screen', seed: seed + 10
        },
        {
            type: 'fbm', octaves: 2, frequency: 0.06, amplitude: 0.20,
            persistence: 0.40, color: '#2a5018', opacity: 0.18,
            blendMode: 'multiply', seed: seed + 20
        },

        // ── 3. Midrib ─────────────────────────────────────────────────────
        // Runs vertically up the center. In real leaves the midrib is
        // slightly lighter/more yellow-green than the lamina (cellulose-
        // rich, less chlorophyll). It is also raised (normal map handles
        // the 3D part; here we just do the color).
        // We use a very narrow vertical gradient band at x≈0.5.
        {
            type: 'vertical_stripe',
            centerX: 0.5,
            width: 0.022,          // ~11px at 512
            feather: 0.016,        // soft edge
            color: '#6a9e48',      // slightly lighter + yellower than base
            opacity: 0.70,
            blendMode: 'normal',
            seed: seed + 30
        },
        // Slight darkening immediately flanking midrib (shadow from relief)
        {
            type: 'vertical_stripe',
            centerX: 0.5,
            width: 0.065,
            feather: 0.028,
            color: '#3a6028',
            opacity: 0.22,
            blendMode: 'multiply',
            seed: seed + 31
        },

        // ── 4. Lateral veins ─────────────────────────────────────────────
        // 7 pairs of veins branching from midrib at ~45° angle, curving
        // toward the leaf margin. Each vein is lighter than surrounding
        // lamina (same reason as midrib).
        // We simulate them as diagonal stripes with spacing and angle.
        {
            type: 'pinnate_veins',
            veinCount: 7,
            veinStartX: 0.5,
            // Veins start at evenly spaced Y positions from 0.12 to 0.88
            veinYStart: 0.12,
            veinYEnd:   0.88,
            // Angle: lateral veins exit midrib at ~45-55°, steepen to ~65° near tip
            angleBase:  0.75,      // radians at base
            angleTip:   1.05,      // radians at tip
            // Vein length as fraction of half-width, decreasing toward tip
            lengthBase: 0.42,
            lengthTip:  0.22,
            veinWidth:  0.010,
            feather:    0.008,
            color: '#5e9445',      // lighter, slightly more yellow
            opacity: 0.65,
            blendMode: 'normal',
            seed: seed + 40
        },

        // ── 5. Inter-vein darkening (lamina between veins) ───────────────
        // Real birch lamina is darker between veins. We add very subtle
        // mid-frequency noise that follows the vein spacing.
        {
            type: 'fbm', octaves: 4, frequency: 0.18, amplitude: 0.15,
            persistence: 0.52, color: '#2d5020', opacity: 0.14,
            blendMode: 'multiply', seed: seed + 50
        },

        // ── 6. Tertiary veinlets (reticulate network) ─────────────────────
        // Fine network between lateral veins. Lighter than lamina.
        // High-frequency, very low amplitude.
        {
            type: 'fbm', octaves: 5, frequency: 0.55, amplitude: 0.08,
            persistence: 0.55, color: '#608840', opacity: 0.10,
            blendMode: 'screen', seed: seed + 60
        },

        // ── 7. Waxy surface micro-texture ────────────────────────────────
        // Real birch leaves have a thin waxy cuticle that creates subtle
        // specular variation. We bake this as a high-frequency brightness
        // variation — the shader can use it for roughness modulation too.
        {
            type: 'grain', amplitude: 3.5,
            color: '#ffffff', opacity: 0.06,
            blendMode: 'overlay', seed: seed + 70
        },
        // Slightly stronger grain on the lamina gives it a slightly matte
        // appearance while the veins (lighter) appear glossier.
        {
            type: 'grain', amplitude: 2.8,
            color: '#000000', opacity: 0.04,
            blendMode: 'overlay', seed: seed + 71
        },

        // ── 8. Subsurface variation (translucency hint) ───────────────────
        // Leaf tips and margins are thinner → slightly more translucent →
        // slightly yellower/lighter. Vignette-invert: bright at edges.
        {
            type: 'radial_gradient',
            centerX: 0.5, centerY: 0.5,
            radiusInner: 0.0, radiusOuter: 0.55,
            colorInner: '#000000', colorOuter: '#7ab848',
            opacity: 0.09,
            blendMode: 'screen',
            seed: seed + 80
        },

        // ── 9. Edge tooth irregularity (color hint) ───────────────────────
        // Birch leaves have serrated/toothed edges. We can't modify shape
        // in the albedo but we can darken slightly near edges to hint at
        // shadow from the teeth geometry.
        {
            type: 'fbm', octaves: 3, frequency: 0.90, amplitude: 0.12,
            persistence: 0.58, color: '#1a3010', opacity: 0.12,
            blendMode: 'multiply', seed: seed + 90
        },

        // ── 10. Final saturation nudge ────────────────────────────────────
        // Real birch leaves: #4a7c35 to #5a9040 range. A very subtle warm
        // tint in the center (where chlorophyll is densest, near midrib).
        {
            type: 'radial_gradient',
            centerX: 0.5, centerY: 0.50,
            radiusInner: 0.0, radiusOuter: 0.35,
            colorInner: '#3d6a28', colorOuter: '#000000',
            opacity: 0.10,
            blendMode: 'multiply',
            seed: seed + 100
        },
    ];
}

/**
 * Birch leaf normal map layers.
 * Encodes surface relief for:
 *   - Midrib raised ridge
 *   - Lateral veins as smaller ridges
 *   - Fine surface micro-bump from waxy cuticle
 *
 * Output: tangent-space normal map stored in RGB
 *   R: X normal component
 *   G: Y normal component  
 *   B: Z normal component (up = 128/255)
 */
function birchLeafNormalLayers(seed = 0) {
    return [
        // Flat base (tangent-space up = (0.5, 0.5, 1.0) in [0,1] space)
        { type: 'fill', color: '#8080ff', opacity: 1.0 },

        // Midrib raised ridge — peaks at center, falls off laterally
        // In normal map space: creates outward-facing normals on the ridge
        {
            type: 'vertical_stripe_normal',
            centerX: 0.5,
            width: 0.030,
            feather: 0.018,
            height: 0.45,          // ridge height (0-1 maps to normal deviation)
            blendMode: 'normal',
            seed: seed + 200
        },

        // Lateral veins — smaller ridges
        {
            type: 'pinnate_veins_normal',
            veinCount: 7,
            veinYStart: 0.12,
            veinYEnd:   0.88,
            angleBase:  0.75,
            angleTip:   1.05,
            lengthBase: 0.42,
            lengthTip:  0.22,
            veinWidth:  0.014,
            feather:    0.010,
            height:     0.22,
            blendMode: 'normal',
            seed: seed + 210
        },

        // Surface micro-bump (waxy cuticle texture)
        {
            type: 'fbm_normal', octaves: 4, frequency: 0.60,
            amplitude: 0.06, persistence: 0.50,
            blendMode: 'normal', seed: seed + 220
        },
    ];
}

/**
 * Birch leaf transmission mask layers.
 * Controls how much light passes through the leaf.
 * Bright = highly transmissive (thin areas: tips, margins, between veins).
 * Dark = opaque (veins, midrib).
 *
 * Stored in texture alpha channel of the albedo texture.
 */
function birchLeafTransmissionLayers(seed = 0) {
    return [
        // Base: medium transmission (leaves are semi-translucent overall)
        { type: 'fill', color: '#999999', opacity: 1.0 },

        // Veins are less transmissive (thicker, more cellulose)
        {
            type: 'vertical_stripe',
            centerX: 0.5, width: 0.028, feather: 0.018,
            color: '#404040', opacity: 0.60,
            blendMode: 'normal', seed: seed + 300
        },
        {
            type: 'pinnate_veins',
            veinCount: 7,
            veinYStart: 0.12, veinYEnd: 0.88,
            angleBase: 0.75, angleTip: 1.05,
            lengthBase: 0.42, lengthTip: 0.22,
            veinWidth: 0.012, feather: 0.009,
            color: '#555555', opacity: 0.50,
            blendMode: 'normal', seed: seed + 310
        },

        // Margins and tip are more transmissive (thinner)
        {
            type: 'radial_gradient',
            centerX: 0.5, centerY: 0.5,
            radiusInner: 0.1, radiusOuter: 0.52,
            colorInner: '#606060', colorOuter: '#c8c8c8',
            opacity: 0.45, blendMode: 'normal', seed: seed + 320
        },

        // Random variation in thickness (natural leaf variation)
        {
            type: 'fbm', octaves: 3, frequency: 0.08,
            amplitude: 0.15, persistence: 0.45,
            color: '#ffffff', opacity: 0.18,
            blendMode: 'screen', seed: seed + 330
        },
    ];
}

function spruceBarkLayers(seed = 0) {
    return [
        // Dark reddish-brown base
        { type: 'fill', color: '#4a3225', opacity: 1.0 },

        // Coarse vertical fissures
        {
            type: 'ridged', octaves: 4, frequency: 0.015,
            amplitude: 0.6, persistence: 0.55, ridgeOffset: 0.5,
            color: '#2a1c14', opacity: 0.45,
            blendMode: 'multiply',
            rotation: 5, // near-vertical
            seed: seed + 100
        },

        // Plate-like scales between fissures
        {
            type: 'cells', cellScale: 2.5, cellRandomness: 0.8,
            cellElongation: 0.5, cellStretch: [1.0, 3.0],
            frequency: 0.03, amplitude: 0.3,
            color: '#5a4030', opacity: 0.25,
            blendMode: 'overlay', seed: seed + 200
        },

        // Warm highlight variation
        {
            type: 'fbm', octaves: 2, frequency: 0.04,
            amplitude: 0.25, persistence: 0.5,
            color: '#6b4e38', opacity: 0.15,
            blendMode: 'screen', seed: seed + 300
        },

        // Fine grain
        {
            type: 'grain', amplitude: 2.0,
            color: '#000000', opacity: 0.05,
            blendMode: 'overlay', seed: seed + 400
        },
    ];
}

function oakBarkLayers(seed = 0) {
    return [
        // Medium grey-brown base
        { type: 'fill', color: '#5c4d3e', opacity: 1.0 },

        // Deep vertical fissures
        {
            type: 'ridged', octaves: 5, frequency: 0.012,
            amplitude: 0.7, persistence: 0.6, ridgeOffset: 0.45,
            color: '#2e2218', opacity: 0.5,
            blendMode: 'multiply',
            rotation: 3,
            seed: seed + 100
        },

        // Broad irregular plate pattern
        {
            type: 'cells', cellScale: 1.5, cellRandomness: 0.7,
            cellElongation: 0.4, cellStretch: [1.0, 2.0],
            frequency: 0.025, amplitude: 0.3,
            color: '#48382a', opacity: 0.3,
            blendMode: 'multiply', seed: seed + 200
        },

        // Subtle moss/lichen variation
        {
            type: 'fbm', octaves: 3, frequency: 0.06,
            amplitude: 0.2, persistence: 0.45,
            color: '#5a6040', opacity: 0.08,
            blendMode: 'overlay', seed: seed + 300
        },

        { type: 'grain', amplitude: 1.8, color: '#000000', opacity: 0.04, blendMode: 'overlay', seed: seed + 400 },
    ];
}

function palmBarkLayers(seed = 0) {
    return [
        // Tan-grey base
        { type: 'fill', color: '#8a7a65', opacity: 1.0 },

        // Ring scars from frond bases
        {
            type: 'horizontal_dashes',
            density: 0.35, minWidth: 0.6, maxWidth: 0.95,
            minHeight: 0.025, maxHeight: 0.055,
            color: '#5a4a38', opacity: 0.4,
            blendMode: 'normal', seed: seed + 100
        },

        // Fibrous vertical texture
        {
            type: 'fbm', octaves: 3, frequency: 0.008,
            amplitude: 0.25, persistence: 0.5,
            color: '#6a5a48', opacity: 0.2,
            blendMode: 'multiply', seed: seed + 200
        },

        { type: 'grain', amplitude: 1.5, color: '#000000', opacity: 0.04, blendMode: 'overlay', seed: seed + 300 },
    ];
}

function defaultBarkLayers(seed = 0) {
    return [
        { type: 'fill', color: '#6b5a48', opacity: 1.0 },
        {
            type: 'fbm', octaves: 3, frequency: 0.03,
            amplitude: 0.4, persistence: 0.5,
            color: '#4a3828', opacity: 0.3,
            blendMode: 'multiply', seed: seed + 100
        },
        { type: 'grain', amplitude: 1.8, color: '#000000', opacity: 0.05, blendMode: 'overlay', seed: seed + 200 },
    ];
}

// ═══════════════════════════════════════════════════════════════════════════
// INC 4: Asset surface recipes
//
// Same layer schema as bark. These go into the SAME atlas as bark so logs
// and stumps can reuse bark_birch for their side surface and only need a
// new endgrain layer for the cut face.
// ═══════════════════════════════════════════════════════════════════════════

function rockGraniteLayers(seed = 0) {
    return [
        { type: 'fill', color: '#7d7872', opacity: 1.0 },
        { type: 'fbm', octaves: 4, frequency: 0.026, amplitude: 0.22,
          persistence: 0.52, color: '#625c56', opacity: 0.10,
          blendMode: 'multiply', seed: seed + 100 },
        { type: 'fbm', octaves: 3, frequency: 0.050, amplitude: 0.18,
          persistence: 0.48, color: '#a59d95', opacity: 0.18,
          blendMode: 'screen', seed: seed + 150 },
        { type: 'cells', cellScale: 8.5, cellRandomness: 0.95,
          cellElongation: 0.66, cellStretch: [1.20, 0.82],
          frequency: 0.072, amplitude: 0.14,
          color: '#66605a', opacity: 0.08,
          blendMode: 'multiply', seed: seed + 200 },
        { type: 'cells', cellScale: 15.0, cellRandomness: 0.94,
          cellElongation: 0.44, cellStretch: [1.10, 0.92],
          frequency: 0.13, amplitude: 0.10,
          color: '#918a84', opacity: 0.10,
          blendMode: 'multiply', seed: seed + 225 },
        { type: 'cells', cellScale: 20.5, cellRandomness: 0.95,
          cellElongation: 0.55, cellStretch: [1.08, 0.92],
          frequency: 0.17, amplitude: 0.14,
          color: '#b2aba3', opacity: 0.14,
          blendMode: 'screen', seed: seed + 250 },
        { type: 'ridged', octaves: 4, frequency: 0.042, amplitude: 0.22,
          persistence: 0.55, ridgeOffset: 0.70,
          color: '#5a544f', opacity: 0.06,
          blendMode: 'multiply', seed: seed + 300 },
        { type: 'fbm', octaves: 4, frequency: 0.16, amplitude: 0.12,
          persistence: 0.55, color: '#6d6761', opacity: 0.06,
          blendMode: 'multiply', seed: seed + 330 },
        { type: 'grain', amplitude: 3.2, color: '#000000', opacity: 0.10,
          blendMode: 'overlay', seed: seed + 400 },
        { type: 'grain', amplitude: 2.9, color: '#ffffff', opacity: 0.09,
          blendMode: 'overlay', seed: seed + 401 },
        { type: 'fbm', octaves: 5, frequency: 0.30, amplitude: 0.10,
          persistence: 0.56, color: '#cbc3bb', opacity: 0.10,
          blendMode: 'screen', seed: seed + 430 },
        { type: 'fbm', octaves: 5, frequency: 0.34, amplitude: 0.08,
          persistence: 0.56, color: '#5c5651', opacity: 0.07,
          blendMode: 'multiply', seed: seed + 440 },
    ];
}

function saturate(value) {
    return Math.max(0, Math.min(1, value));
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function smoothstep(edge0, edge1, x) {
    const t = saturate((x - edge0) / Math.max(edge1 - edge0, 1e-6));
    return t * t * (3 - 2 * t);
}

function hash2(x, y, seed) {
    const s = Math.sin(x * 127.1 + y * 311.7 + seed * 17.13) * 43758.5453123;
    return s - Math.floor(s);
}

function valueNoise2(x, y, seed) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy, seed);
    const b = hash2(ix + 1, iy, seed);
    const c = hash2(ix, iy + 1, seed);
    const d = hash2(ix + 1, iy + 1, seed);
    return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
}

function fbm2(x, y, seed, octaves = 4) {
    let value = 0;
    let amplitude = 0.5;
    let frequency = 1.0;
    let total = 0;
    for (let i = 0; i < octaves; i++) {
        value += valueNoise2(x * frequency, y * frequency, seed + i * 19) * amplitude;
        total += amplitude;
        amplitude *= 0.5;
        frequency *= 2.03;
    }
    return total > 0 ? value / total : 0;
}

function worley2(x, y, seed, cellScale = 8) {
    const px = x * cellScale;
    const py = y * cellScale;
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    let minDist = 1e9;
    let secondMin = 1e9;

    for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
            const cx = ix + ox;
            const cy = iy + oy;
            const fx = cx + hash2(cx, cy, seed + 11);
            const fy = cy + hash2(cx, cy, seed + 23);
            const dx = fx - px;
            const dy = fy - py;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < minDist) {
                secondMin = minDist;
                minDist = dist;
            } else if (dist < secondMin) {
                secondMin = dist;
            }
        }
    }

    return {
        cell: saturate(1.0 - minDist),
        edge: saturate((secondMin - minDist) * 1.8),
    };
}

function rotate2(x, y, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return { x: x * c - y * s, y: x * s + y * c };
}

function graniteSignals(u, v, seed = 0) {
    const p1 = rotate2(u * 6.5, v * 6.5, 0.62);
    const p2 = rotate2(u * 12.0 + 13.7, v * 12.0 - 7.2, -0.91);
    const p3 = rotate2(u * 22.0 - 5.1, v * 22.0 + 2.4, 0.28);
    const p4 = rotate2(u * 9.0 - 2.3, v * 14.0 + 4.1, 1.13);

    const macro = fbm2(p1.x, p1.y, seed + 100, 4);
    const breakup = fbm2(p2.x, p2.y, seed + 200, 3);
    const grains = fbm2(p3.x, p3.y, seed + 300, 4);
    const crystal = worley2(u + breakup * 0.08, v - breakup * 0.08, seed + 400, 9.5);
    const crystalFine = worley2(u * 1.7, v * 1.7, seed + 500, 15.0);
    const irregular = fbm2(p4.x, p4.y, seed + 520, 4);

    const crackA = Math.pow(saturate(1.0 - Math.abs(fbm2(p1.x * 0.7 + 9.0, p1.y * 2.6, seed + 600, 3) * 2.0 - 1.0)), 4.8);
    const crackB = Math.pow(saturate(crystal.edge * 1.4 - 0.18), 1.35);
    const fractureMask = saturate(crackA * 0.45 + crackB * 0.68);
    const fracture = fractureMask * (0.45 + 0.55 * breakup) * (0.65 + 0.35 * irregular);

    const cavityBase = saturate((1.0 - crystal.cell) * 0.52 + (1.0 - crystalFine.cell) * 0.18);
    const cavityShape = smoothstep(0.26, 0.82, irregular * 0.60 + breakup * 0.40);
    const cavity = saturate(cavityBase * (0.42 + 0.58 * cavityShape));
    const grain = saturate(grains * 0.75 + crystalFine.edge * 0.45);
    const height = (
        crystal.cell * 0.24 +
        crystalFine.cell * 0.10 +
        macro * 0.10 +
        grain * 0.11 -
        fracture * 0.34 -
        cavity * 0.06
    );

    return {
        fracture: saturate(fracture),
        grain: saturate(grain),
        macro: saturate(macro * 0.65 + breakup * 0.35),
        cavity: saturate(cavity),
        height: saturate(height),
    };
}

function createCanvas(size) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    return canvas;
}

function createImageData(size) {
    return new ImageData(size, size);
}

function createSeededRng(seed = 1) {
    let state = (seed >>> 0) || 1;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

function applySeamless(generator, canvas, seamlessConfig) {
    if (generator && typeof generator._makeSeamless === 'function') {
        generator._makeSeamless(canvas, seamlessConfig);
    }
    return canvas;
}

async function buildGraniteDetailTexture({ textureSize, generator, seamlessConfig, seed }) {
    const canvas = createCanvas(textureSize);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const image = createImageData(textureSize);
    const data = image.data;

    for (let y = 0; y < textureSize; y++) {
        for (let x = 0; x < textureSize; x++) {
            const u = x / textureSize;
            const v = y / textureSize;
            const g = graniteSignals(u, v, seed);
            const idx = (y * textureSize + x) * 4;
            data[idx] = Math.round(g.fracture * 255);
            data[idx + 1] = Math.round(g.grain * 255);
            data[idx + 2] = Math.round(g.macro * 255);
            data[idx + 3] = Math.round(g.cavity * 255);
        }
    }

    ctx.putImageData(image, 0, 0);
    return applySeamless(generator, canvas, seamlessConfig);
}

async function buildGraniteNormalTexture({ textureSize, generator, seamlessConfig, seed }) {
    const canvas = createCanvas(textureSize);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const image = createImageData(textureSize);
    const data = image.data;
    const texel = 1 / textureSize;

    for (let y = 0; y < textureSize; y++) {
        for (let x = 0; x < textureSize; x++) {
            const u = x / textureSize;
            const v = y / textureSize;
            const hL = graniteSignals(u - texel, v, seed).height;
            const hR = graniteSignals(u + texel, v, seed).height;
            const hD = graniteSignals(u, v - texel, seed).height;
            const hU = graniteSignals(u, v + texel, seed).height;
            const dx = (hR - hL) * 2.2;
            const dy = (hU - hD) * 2.2;
            const invLen = 1 / Math.max(Math.hypot(dx, dy, 1), 1e-5);
            const nx = -dx * invLen;
            const ny = -dy * invLen;
            const nz = 1 * invLen;
            const idx = (y * textureSize + x) * 4;
            data[idx] = Math.round((nx * 0.5 + 0.5) * 255);
            data[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
            data[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
            data[idx + 3] = 255;
        }
    }

    ctx.putImageData(image, 0, 0);
    return applySeamless(generator, canvas, seamlessConfig);
}

async function buildFernFrondTexture({ textureSize, seed }) {
    const canvas = createCanvas(textureSize);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rng = createSeededRng(seed ^ 0x51f15e);
    const size = textureSize;

    ctx.clearRect(0, 0, size, size);

    const stemBaseX = size * (0.50 + (rng() - 0.5) * 0.03);
    const stemBaseY = size * 0.06;
    const stemTipY = size * 0.96;
    const stemCurve = size * (0.028 + rng() * 0.018);
    const stemSegments = 72;
    const spine = [];

    for (let i = 0; i <= stemSegments; i++) {
        const t = i / stemSegments;
        const y = stemBaseY + (stemTipY - stemBaseY) * t;
        const sway = Math.sin((t * 1.08 + 0.08) * Math.PI) * stemCurve * (1.0 - 0.30 * t);
        const x = stemBaseX + sway;
        spine.push({ x, y });
    }

    const leafletCount = 24 + Math.floor(rng() * 7);
    for (let i = 2; i < leafletCount - 1; i++) {
        const t = i / (leafletCount - 1);
        const idx = Math.max(1, Math.min(stemSegments - 1, Math.round(t * stemSegments)));
        const prev = spine[idx - 1];
        const curr = spine[idx];
        const next = spine[idx + 1];

        var tangentX = next.x - prev.x;
        var tangentY = next.y - prev.y;
        const tangentLen = Math.max(Math.hypot(tangentX, tangentY), 1e-5);
        tangentX /= tangentLen;
        tangentY /= tangentLen;

        const normalX = -tangentY;
        const normalY = tangentX;
        const spread = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.80)), 0.95);
        const leafletLength = size * (0.028 + 0.23 * spread);
        const leafletWidth = Math.max(size * 0.008, leafletLength * (0.14 - 0.05 * t));
        const forwardBias = 0.18 - t * 0.06;

        for (const side of [-1, 1]) {
            var dirX = normalX * side + tangentX * forwardBias;
            var dirY = normalY * side + tangentY * forwardBias;
            const dirLen = Math.max(Math.hypot(dirX, dirY), 1e-5);
            dirX /= dirLen;
            dirY /= dirLen;

            const perpX = -dirY;
            const perpY = dirX;
            const rootX = curr.x + normalX * side * size * 0.005;
            const rootY = curr.y + normalY * side * size * 0.005;
            const tipX = rootX + dirX * leafletLength;
            const tipY = rootY + dirY * leafletLength;

            const grad = ctx.createLinearGradient(rootX, rootY, tipX, tipY);
            grad.addColorStop(0.0, '#244c1d');
            grad.addColorStop(0.45, '#3f7d31');
            grad.addColorStop(1.0, '#76b65a');
            ctx.fillStyle = grad;

            ctx.beginPath();
            ctx.moveTo(rootX, rootY);
            ctx.bezierCurveTo(
                rootX + dirX * leafletLength * 0.24 + tangentX * leafletWidth * 0.7,
                rootY + dirY * leafletLength * 0.24 + tangentY * leafletWidth * 0.7,
                rootX + dirX * leafletLength * 0.76 + perpX * leafletWidth,
                rootY + dirY * leafletLength * 0.76 + perpY * leafletWidth,
                tipX,
                tipY
            );
            ctx.bezierCurveTo(
                rootX + dirX * leafletLength * 0.84 - perpX * leafletWidth * 0.42,
                rootY + dirY * leafletLength * 0.84 - perpY * leafletWidth * 0.42,
                rootX + dirX * leafletLength * 0.16 - perpX * leafletWidth * 0.72,
                rootY + dirY * leafletLength * 0.16 - perpY * leafletWidth * 0.72,
                rootX,
                rootY
            );
            ctx.closePath();
            ctx.fill();
        }
    }

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#213b16';
    ctx.lineWidth = size * 0.028;
    ctx.beginPath();
    ctx.moveTo(spine[0].x, spine[0].y);
    for (let i = 1; i < spine.length; i++) {
        ctx.lineTo(spine[i].x, spine[i].y);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(129, 186, 92, 0.55)';
    ctx.lineWidth = size * 0.010;
    ctx.beginPath();
    ctx.moveTo(spine[0].x, spine[0].y);
    for (let i = 1; i < spine.length; i++) {
        ctx.lineTo(spine[i].x, spine[i].y);
    }
    ctx.stroke();

    ctx.globalCompositeOperation = 'source-atop';
    const wash = ctx.createLinearGradient(0, stemBaseY, 0, stemTipY);
    wash.addColorStop(0.0, 'rgba(28, 50, 18, 0.95)');
    wash.addColorStop(0.45, 'rgba(46, 86, 28, 0.20)');
    wash.addColorStop(1.0, 'rgba(108, 178, 76, 0.16)');
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, size, size);
    ctx.globalCompositeOperation = 'source-over';

    return canvas;
}

function mushroomStemLayers(seed = 0) {
    return [
        // Cream-white base
        { type: 'fill', color: '#ede5d8', opacity: 1.0 },

        // Subtle warm tint variation
        { type: 'fbm', octaves: 2, frequency: 0.06, amplitude: 0.16,
          persistence: 0.45, color: '#d8ccb8', opacity: 0.10,
          blendMode: 'multiply', seed: seed + 100 },

        // Fibrous vertical striations — stems are fibrous along length.
        // rotation:90 rotates the noise coord so features run vertically.
        { type: 'fbm', octaves: 3, frequency: 0.004, amplitude: 0.18,
          persistence: 0.50, color: '#c0b6a0', opacity: 0.09,
          blendMode: 'multiply', rotation: 90, seed: seed + 200 },

        // Fine fiber detail
        { type: 'fbm', octaves: 4, frequency: 0.35, amplitude: 0.08,
          persistence: 0.55, color: '#f8f4ec', opacity: 0.05,
          blendMode: 'screen', seed: seed + 300 },

        { type: 'grain', amplitude: 1.5, color: '#000000', opacity: 0.03,
          blendMode: 'overlay', seed: seed + 400 },
    ];
}

async function buildAmanitaCapTexture({ textureSize, seed }) {
    const canvas = createCanvas(textureSize);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rng = createSeededRng(seed ^ 0x8a11c0);
    const size = textureSize;
    const c = size * 0.5;
    const radius = size * 0.46;

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, radius, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();

    const base = ctx.createRadialGradient(c * 0.94, c * 0.88, size * 0.04, c, c, radius);
    base.addColorStop(0.0, '#f56a42');
    base.addColorStop(0.25, '#db4425');
    base.addColorStop(0.70, '#b51d14');
    base.addColorStop(1.0, '#7a120d');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);

    const rimShade = ctx.createRadialGradient(c, c, radius * 0.35, c, c, radius);
    rimShade.addColorStop(0.0, 'rgba(255,255,255,0.0)');
    rimShade.addColorStop(0.78, 'rgba(80, 8, 6, 0.0)');
    rimShade.addColorStop(1.0, 'rgba(68, 8, 6, 0.44)');
    ctx.fillStyle = rimShade;
    ctx.fillRect(0, 0, size, size);

    const streakCount = 18;
    for (let i = 0; i < streakCount; i++) {
        const angle = rng() * Math.PI * 2;
        const inner = radius * (0.10 + rng() * 0.20);
        const outer = radius * (0.55 + rng() * 0.30);
        ctx.strokeStyle = `rgba(255, 208, 184, ${0.03 + rng() * 0.04})`;
        ctx.lineWidth = size * (0.005 + rng() * 0.004);
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(angle) * inner, c + Math.sin(angle) * inner);
        ctx.lineTo(c + Math.cos(angle) * outer, c + Math.sin(angle) * outer);
        ctx.stroke();
    }

    const wartCount = 26;
    for (let i = 0; i < wartCount; i++) {
        const angle = rng() * Math.PI * 2;
        const dist = radius * Math.sqrt(rng()) * 0.88;
        if (dist < radius * 0.16 && rng() < 0.65) continue;

        const x = c + Math.cos(angle) * dist;
        const y = c + Math.sin(angle) * dist;
        const rx = size * (0.028 + rng() * 0.036);
        const ry = rx * (0.58 + rng() * 0.34);
        const rot = rng() * Math.PI;

        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(rot);

        ctx.fillStyle = 'rgba(224, 216, 208, 0.42)';
        ctx.beginPath();
        ctx.ellipse(rx * 0.10, ry * 0.18, rx * 1.05, ry * 1.02, 0, 0, Math.PI * 2);
        ctx.fill();

        const wartGrad = ctx.createRadialGradient(-rx * 0.24, -ry * 0.30, rx * 0.08, 0, 0, rx);
        wartGrad.addColorStop(0.0, '#fffdf7');
        wartGrad.addColorStop(0.75, '#efe8dc');
        wartGrad.addColorStop(1.0, '#d8d1c8');
        ctx.fillStyle = wartGrad;
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    ctx.restore();
    return canvas;
}

function deadwoodEndgrainLayers(seed = 0) {
    // Endcap UV: u wraps angle, v radial (rim v=0.8 → center v=1.0).
    // Growth rings are therefore HORIZONTAL stripes in UV space.
    // horizontal_dashes at near-full width = ring boundaries.
    return [
        // Light tan heartwood base
        { type: 'fill', color: '#b89878', opacity: 1.0 },

        // Heartwood gradient (center slightly darker/warmer)
        { type: 'radial_gradient', centerX: 0.5, centerY: 0.5,
          radiusInner: 0.0, radiusOuter: 0.50,
          colorInner: '#a08058', colorOuter: '#c8a888',
          opacity: 0.14, blendMode: 'normal', seed: seed + 50 },

        // Growth ring boundaries — wide horizontal dashes
        { type: 'horizontal_dashes',
          density: 0.42, minWidth: 0.85, maxWidth: 1.0,
          minHeight: 0.004, maxHeight: 0.011,
          color: '#705838', opacity: 0.32,
          blendMode: 'multiply', seed: seed + 100 },

        // Secondary ring variation
        { type: 'horizontal_dashes',
          density: 0.28, minWidth: 0.70, maxWidth: 0.95,
          minHeight: 0.002, maxHeight: 0.007,
          color: '#806848', opacity: 0.20,
          blendMode: 'multiply', seed: seed + 150 },

        // Grain fiber texture
        { type: 'fbm', octaves: 4, frequency: 0.20, amplitude: 0.12,
          persistence: 0.52, color: '#988060', opacity: 0.09,
          blendMode: 'multiply', seed: seed + 200 },

        // Drying cracks (checking)
        { type: 'ridged', octaves: 3, frequency: 0.04, amplitude: 0.24,
          persistence: 0.55, ridgeOffset: 0.60,
          color: '#584838', opacity: 0.09,
          blendMode: 'multiply', seed: seed + 300 },

        { type: 'grain', amplitude: 2.0, color: '#000000', opacity: 0.04,
          blendMode: 'overlay', seed: seed + 400 },
    ];
}

function mossOverlayLayers(seed = 0) {
    return [
        // Moss green base
        { type: 'fill', color: '#3a5a28', opacity: 1.0 },

        // Moisture/density variation
        { type: 'fbm', octaves: 3, frequency: 0.08, amplitude: 0.28,
          persistence: 0.50, color: '#4a7238', opacity: 0.20,
          blendMode: 'screen', seed: seed + 100 },
        { type: 'fbm', octaves: 2, frequency: 0.12, amplitude: 0.20,
          persistence: 0.45, color: '#284418', opacity: 0.16,
          blendMode: 'multiply', seed: seed + 150 },

        // Tufted clump structure
        { type: 'cells', cellScale: 5.5, cellRandomness: 0.90,
          cellElongation: 0.28, cellStretch: [1.0, 1.0],
          frequency: 0.10, amplitude: 0.24,
          color: '#284018', opacity: 0.14,
          blendMode: 'multiply', seed: seed + 200 },

        // Brighter tuft highlights
        { type: 'cells', cellScale: 9.0, cellRandomness: 0.85,
          cellElongation: 0.35, cellStretch: [1.0, 1.0],
          frequency: 0.15, amplitude: 0.18,
          color: '#588448', opacity: 0.11,
          blendMode: 'screen', seed: seed + 250 },

        // Fuzzy micro-texture
        { type: 'fbm', octaves: 5, frequency: 0.48, amplitude: 0.10,
          persistence: 0.55, color: '#486838', opacity: 0.08,
          blendMode: 'overlay', seed: seed + 300 },

        { type: 'grain', amplitude: 2.6, color: '#000000', opacity: 0.04,
          blendMode: 'overlay', seed: seed + 400 },
        { type: 'grain', amplitude: 2.4, color: '#ffffff', opacity: 0.03,
          blendMode: 'overlay', seed: seed + 401 },
    ];
}

// ═══════════════════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════════════════

const BARK_BUILDERS = {
    birch:        birchBarkLayers,
    spruce:       spruceBarkLayers,
    pine:         spruceBarkLayers,   // pine reuses spruce recipe with different seed
    oak:          oakBarkLayers,
    beech:        oakBarkLayers,      // beech is smooth but we'll refine later
    palm_coconut: palmBarkLayers,
    teak:         defaultBarkLayers,
    baobab:       defaultBarkLayers,
    saguaro:      defaultBarkLayers,
    alder:        defaultBarkLayers,
};

export class PropMaterialFactory {
    /**
     * Build prop texture definitions for all registered tree species.
     * Returns an array suitable for PropTextureManager.buildPropAtlas().
     *
     * @param {object} [options]
     * @param {number} [options.baseSeed=42000] — seed offset for generation
     * @returns {PropTextureDefinition[]}
     */
    static buildAllBarkDefinitions(options = {}) {
        const baseSeed = options.baseSeed ?? 42000;
        if (typeof options.getSpeciesRegistry !== 'function') {
            throw new Error('PropMaterialFactory.buildAllBarkDefinitions requires options.getSpeciesRegistry');
        }
        const registry = options.getSpeciesRegistry();
        const allSpecies = registry.getAllSpecies();
        const definitions = [];

        for (let i = 0; i < allSpecies.length; i++) {
            const species = allSpecies[i];
            const builder = BARK_BUILDERS[species.id] || defaultBarkLayers;
            const seed = baseSeed + i * 1000;

            definitions.push({
                id: `bark_${species.id}`,
                label: `${species.name} Bark`,
                layers: builder(seed),
            });
        }

        Logger.info(
            `[PropMaterialFactory] Built ${definitions.length} bark definitions ` +
            `for species: ${allSpecies.map(s => s.id).join(', ')}`
        );

        return definitions;
    }

    /**
     * Build birch leaf albedo definitions for texture-array baking.
     * One layer per variant, ids: leaf_birch_albedo_0..N-1
     *
     * @param {object} [options]
     * @param {number} [options.baseSeed=52000]
     * @param {number} [options.variantCount=12]
     * @returns {PropTextureDefinition[]}
     */
    static buildBirchLeafAlbedoDefinitions(options = {}) {
        const baseSeed = options.baseSeed ?? 52000;
        const variantCount = Math.max(1, options.variantCount ?? 12);
        const definitions = [];
        for (let i = 0; i < variantCount; i++) {
            definitions.push({
                id: `leaf_birch_albedo_${i}`,
                label: `Birch Leaf Albedo ${i}`,
                layers: birchLeafAlbedoLayers(baseSeed + i * 97),
            });
        }
        return definitions;
    }

    /**
     * Build birch leaf normal definitions for texture-array baking.
     * One layer per variant, ids: leaf_birch_normal_0..N-1
     *
     * @param {object} [options]
     * @param {number} [options.baseSeed=62000]
     * @param {number} [options.variantCount=12]
     * @returns {PropTextureDefinition[]}
     */
    static buildBirchLeafNormalDefinitions(options = {}) {
        const baseSeed = options.baseSeed ?? 62000;
        const variantCount = Math.max(1, options.variantCount ?? 12);
        const definitions = [];
        for (let i = 0; i < variantCount; i++) {
            definitions.push({
                id: `leaf_birch_normal_${i}`,
                label: `Birch Leaf Normal ${i}`,
                layers: birchLeafNormalLayers(baseSeed + i * 97),
            });
        }
        return definitions;
    }

    /**
     * Build bark definition for a single species.
     *
     * @param {string} speciesId
     * @param {number} [seed=42000]
     * @returns {PropTextureDefinition|null}
     */
    static buildBarkDefinition(speciesId, seed = 42000, getSpeciesRegistry) {
        if (typeof getSpeciesRegistry !== 'function') {
            throw new Error('PropMaterialFactory.buildBarkDefinition requires getSpeciesRegistry');
        }
        const builder = BARK_BUILDERS[speciesId] || defaultBarkLayers;
        const registry = getSpeciesRegistry();
        const species = registry.getSpecies(speciesId);

        if (!species) {
            Logger.warn(`[PropMaterialFactory] Unknown species: ${speciesId}`);
            return null;
        }

        return {
            id: `bark_${speciesId}`,
            label: `${species.name} Bark`,
            layers: builder(seed),
        };
    }

    /**
     * Get list of supported species ids that have bark recipes.
     * @returns {string[]}
     */
    static getSupportedSpecies() {
        return Object.keys(BARK_BUILDERS);
    }

        /**
     * Build ALL prop texture definitions — bark + asset surfaces — for a
     * single unified atlas. Logs and stumps reuse bark_birch for their
     * side surface; only the endgrain cut face and moss overlay are new.
     *
     * AssetStreamer calls this once in initialize() and feeds the result
     * to propTextureManager.buildPropAtlas(). Upstream code should NOT
     * build the atlas separately.
     *
     * @param {object} [options]
     * @param {number} [options.baseSeed=42000]
     * @returns {PropTextureDefinition[]}
     */
        static buildAllPropDefinitions(options = {}) {
            const baseSeed = options.baseSeed ?? 42000;
            const defs = [];

            // Bark for all tree species (birch, spruce, oak, palm, …)
            defs.push(...PropMaterialFactory.buildAllBarkDefinitions({
                baseSeed,
                getSpeciesRegistry: options.getSpeciesRegistry,
            }));
    
            // Asset surfaces — one each
            defs.push({ id: 'rock_granite',          label: 'Granite Surface',
                        layers: rockGraniteLayers(baseSeed + 10000) });
            defs.push({
                id: 'rock_granite_normal',
                label: 'Granite Normal',
                generate: (ctx) => buildGraniteNormalTexture({ ...ctx, seed: baseSeed + 10040 }),
            });
            defs.push({
                id: 'rock_granite_detail',
                label: 'Granite Detail',
                generate: (ctx) => buildGraniteDetailTexture({ ...ctx, seed: baseSeed + 10080 }),
            });
            defs.push({
                id: 'fern_frond',
                label: 'Fern Frond',
                generate: (ctx) => buildFernFrondTexture({ ...ctx, seed: baseSeed + 11000 }),
            });
            defs.push({ id: 'mushroom_stem',         label: 'Mushroom Stem',
                        layers: mushroomStemLayers(baseSeed + 12000) });
            defs.push({
                id: 'mushroom_cap_amanita',
                label: 'Amanita Cap',
                generate: (ctx) => buildAmanitaCapTexture({ ...ctx, seed: baseSeed + 13000 }),
            });
            defs.push({ id: 'deadwood_endgrain',     label: 'Wood Endgrain',
                        layers: deadwoodEndgrainLayers(baseSeed + 14000) });
            defs.push({ id: 'moss_overlay',          label: 'Moss Overlay',
                        layers: mossOverlayLayers(baseSeed + 15000) });
    
            Logger.info(
                `[PropMaterialFactory] Built ${defs.length} unified prop definitions ` +
                `(bark + asset surfaces)`
            );
            return defs;
        }
}
