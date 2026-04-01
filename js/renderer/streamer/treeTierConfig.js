// js/renderer/streamer/treeTierConfig.js
//
// Single source of truth for tree tier distances, budgets, and visual
// parameters. Replaces the scattered mid-near config in TreeLODController
// and the magic numbers in shader builders.
//
// Migration status:
//   [DONE] Mid tier (new hull-only system)
//   [TODO] Near tier (leafBands, birchLadder — still in TreeLODController)
//   [TODO] Far / Cluster tiers (not yet implemented)
//
// All distances in meters. All fade widths are the FULL width of the
// crossfade zone (so fadeIn runs from start to start+fadeWidth).

// ═════════════════════════════════════════════════════════════════════════
// TIER RANGES
// ═════════════════════════════════════════════════════════════════════════
//
// The gap between near.end (80m) and mid.start (180m) is INTENTIONAL during
// development — it will close once near tier is extended in Task 3. For now
// you can set mid.start lower (e.g. 60) to see continuous coverage, but
// hulls will look bad at that range (which is the whole point of the redesign).

export const TREE_TIER_RANGES = {
    near: {
        start: 0,
        end: 80,            // TODO Task 3: extend to ~220
        fadeOutWidth: 15,   // near fades out over [end-width, end]
    },
    mid: {
        start: 180,         // where hulls start looking acceptable
        end: 600,
        fadeInWidth: 40,    // overlap with near: [start, start+width]
        fadeOutWidth: 80,   // overlap with far tier (future)
    },
    // far, cluster: future
};

// ═════════════════════════════════════════════════════════════════════════
// MID TIER — hull-only
// ═════════════════════════════════════════════════════════════════════════

export const MID_TIER_CONFIG = {
    // ── Budget ─────────────────────────────────────────────────────────────
    // At 180–600m the visible shell is an annulus of ~1M m². At forest
    // density of ~0.01 trees/m² that's ~10k trees. Budget 12k for safety.
    maxTrees: 12000,

    // ── Hull geometry ──────────────────────────────────────────────────────
    // 16×10 = 160 verts, ~280 tris. At 200m a 15m tree is ~14 pixels wide;
    // 160 verts is more than enough to avoid faceting.
    hull: {
        lonSegments: 16,
        latSegments: 10,

        // How many anchors the VS samples for per-vertex shape detail.
        // Bounds are precomputed in the tracker, so this is ONLY for
        // residual lumpiness. At 200m+ you can't resolve individual
        // clusters, so this can be low. Set to 0 for pure ellipsoid.
        vsAnchorSamples: 8,

        // Ellipsoid inflation past the anchor bounding box. <1 = tighter
        // than anchors (rely on dither for edge), >1 = puffy.
        inflation: 0.95,

        // Blend between pure ellipsoid (0) and anchor-support shape (1).
        // Lower at distance because detail is invisible; helps keep the
        // VS branch-predictable when vsAnchorSamples > 0.
        shrinkWrap: 0.55,

        // Species-agnostic vertical squash/stretch. Birch wants tall.
        // Will become per-species once species profiles land.
        verticalBias: 1.15,

        // Top-cap taper to avoid the "mushroom dome" look.
        topShrinkStart: 0.60,
        topShrinkStrength: 0.35,
    },

    // ── Hull fragment ──────────────────────────────────────────────────────
    hullFrag: {
        // Porosity target. 1.0 = fully opaque blob, 0.5 = ~50% coverage.
        // Lower values let the background show through, which at distance
        // reads as "leafy" without actual leaf cards.
        baseCoverage: 0.72,

        // How much porosity varies over the surface. 0 = uniform, 1 = full
        // noise modulation (some patches dense, some sparse).
        coverageNoiseAmp: 0.25,

        // Noise scale in local-space meters. Smaller = finer grain.
        coverageNoiseScale: 2.8,

        // Pseudo-bump strength for lighting variation. Subtle at distance.
        bumpStrength: 0.12,

        // Overall brightness multiplier (canopy albedo tends dark).
        brightness: 1.05,
    },

    // ── Trunk ──────────────────────────────────────────────────────────────
    // Fades out independently since it drops below pixel threshold sooner.
    trunk: {
        visibleHeightFrac: 0.38,
        baseRadiusFrac: 0.025,     // matches near-tier BranchRenderer
        taperTop: 0.60,
        fadeEnd: 400,              // trunk invisible past this (canopy-only)
    },
};

// ═════════════════════════════════════════════════════════════════════════
// SPECIES PROFILES
// ═════════════════════════════════════════════════════════════════════════
//
// Canopy shape parameters per species. These drive the ellipsoid fallback
// when anchor data isn't available AND bias the anchor-based shape.
//
// This replaces the giant switch-cases in the WGSL. Eventually this gets
// uploaded as a storage buffer; for now it's baked into the shader as
// constants (see buildMidHullVertexShader's speciesProfileWGSL).
//
// Profile shape: canopy lives in [heightFracStart, heightFracEnd] of the
// tree's scaleY, with radial extent = scaleX * radialFrac.

export const SPECIES_CANOPY_PROFILES = {
    // index 2 — birch: tall, narrow, high canopy
    2: { heightFracStart: 0.32, heightFracEnd: 0.98, radialFrac: 0.26, label: 'birch' },
    // index 3 — alder: similar but lower crown
    3: { heightFracStart: 0.25, heightFracEnd: 0.92, radialFrac: 0.30, label: 'alder' },
    // index 4 — oak: wide, round, low crown
    4: { heightFracStart: 0.20, heightFracEnd: 0.95, radialFrac: 0.42, label: 'oak' },
    // index 5 — beech: similar to oak, slightly taller
    5: { heightFracStart: 0.22, heightFracEnd: 0.96, radialFrac: 0.38, label: 'beech' },
    // index 0,1 — conifers: conical (handled differently, TODO)
    0: { heightFracStart: 0.08, heightFracEnd: 0.98, radialFrac: 0.22, label: 'spruce', conical: true },
    1: { heightFracStart: 0.12, heightFracEnd: 0.98, radialFrac: 0.20, label: 'pine',   conical: true },
    // fallback
    default: { heightFracStart: 0.28, heightFracEnd: 0.95, radialFrac: 0.32, label: 'generic' },
};

// ═════════════════════════════════════════════════════════════════════════
// FEATURE FLAGS — for dev toggling between old and new systems
// ═════════════════════════════════════════════════════════════════════════

export const TREE_TIER_FLAGS = {
    // Master switch. When false, TreeMidSystem is inert and
    // TreeMidNearSystem runs as before.
    useMidTier: true,

    // Keep the legacy mid-near system alive for A/B comparison.
    // When useMidTier is true AND this is true, you get BOTH drawing
    // (useful for visual diffing). Normally false.
    keepLegacyMidNear: false,
};

// ═════════════════════════════════════════════════════════════════════════
// Validation helper — call from TreeLODController or AssetStreamer init.
// ═════════════════════════════════════════════════════════════════════════

export function validateTierRanges(nearEnd) {
    const warnings = [];
    const r = TREE_TIER_RANGES;

    const nearFadeStart = nearEnd - r.near.fadeOutWidth;
    const midFadeEnd = r.mid.start + r.mid.fadeInWidth;

    if (r.mid.start > nearEnd) {
        warnings.push(
            `Gap between near tier (ends ${nearEnd}m) and mid tier ` +
            `(starts ${r.mid.start}m). Trees will vanish in [${nearEnd}, ${r.mid.start}]m. ` +
            `This is expected until Task 3 extends the near tier.`
        );
    } else if (midFadeEnd < nearFadeStart) {
        warnings.push(
            `Mid tier fully fades in (${midFadeEnd}m) before near tier ` +
            `starts fading out (${nearFadeStart}m). Double-draw zone is ` +
            `[${midFadeEnd}, ${nearFadeStart}]m — wider than necessary.`
        );
    }

    if (r.mid.fadeInWidth < 20) {
        warnings.push(`Mid tier fadeInWidth=${r.mid.fadeInWidth}m is narrow; expect visible pop.`);
    }

    return warnings;
}