// js/renderer/streamer/treeTierConfig.js
//
// Single source of truth for tree tier distances, budgets, and visual
// parameters. Replaces the scattered mid-near config in TreeLODController
// and the magic numbers in shader builders.
//
// Migration status:
//   [DONE] Mid tier (new hull-only system)
//   [TODO] Near tier (leafBands, birchLadder — still in TreeLODController)
//   [DONE] Coarse far tier (cluster producer + packed low-res hull trees)
//
// All distances in meters. All fade widths are the FULL width of the
// crossfade zone (so fadeIn runs from start to start+fadeWidth).

// ═════════════════════════════════════════════════════════════════════════
// TIER RANGES
// ═════════════════════════════════════════════════════════════════════════
//
// Default fallback ranges mirror the runtime tree config: the near tier
// extends to 220m and crossfades into the mid tier over an 80m window.

export const TREE_TIER_RANGES = {
    near: {
        start: 0,
        end: 220,
        fadeOutWidth: 80,   // near fades out over [140, 220]
    },
    mid: {
        start: 140,
        end: 1500,
        fadeInWidth: 80,    // overlap with near: [140, 220]
        fadeOutWidth: 300,
    },
    farTrees: {
        start: 800,
        end: 2000,
        fadeInWidth: 400,
        fadeOutWidth: 300,
    },
};

// ═════════════════════════════════════════════════════════════════════════
// MID TIER — hull-only
// ═════════════════════════════════════════════════════════════════════════

export const MID_TIER_CONFIG = {
    // ── Budget ─────────────────────────────────────────────────────────────
    // At 180–600m the visible shell is an annulus of ~1M m². At forest
    // density of ~0.01 trees/m² that's ~10k trees. Budget 12k for safety.
    maxTrees: 20000,

    // Stable distance thinning in the tracker. 1.0 = no thinning.
    // Values below 1.0 linearly taper the retained density toward the
    // far end of the mid tier.
    endDensityScale: 1.0,

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

        // Gap-aware support shrink. With weak anchor support in the
        // current azimuth, the hull is allowed to pull inward instead of
        // only ever expanding to the furthest sampled anchor.
        gapShrink: 0.68,

        // Nearer mid-tier trees get stronger silhouette breakup; farther
        // ones ease back toward a simpler shell where the detail is not
        // screen-resolvable.
        lumpNearScale: 1.8,
        lumpFarScale: 1.0,
        lumpNearDistance: 250,
        lumpFarDistance: 550,
    },

    // ── Hull fragment ──────────────────────────────────────────────────────
    hullFrag: {
        // Near sub-band is intentionally sparser; far sub-band stays
        // denser to avoid aliasing in the horizon line.
        baseCoverageNear: 0.56,
        baseCoverageFar: 0.74,
        subbandSplit: 450,
        subbandBlend: 120,
        subbandFarDamp: 0.65,

        // How much porosity varies over the surface. 0 = uniform, 1 = full
        // noise modulation (some patches dense, some sparse).
        coverageNoiseAmp: 0.25,

        // Noise scale in local-space meters. Smaller = finer grain.
        coverageNoiseScale: 2.8,

        // Pseudo-bump strength for lighting variation. Subtle at distance.
        bumpStrength: 0.12,

        // Overall brightness multiplier (canopy albedo tends dark).
        brightness: 1.05,

        // Low-frequency canopy gaps that fake missing anchor support.
        macroGapScale: 0.55,
        macroGapStrength: 0.22,

        // Noise-driven side erosion so silhouettes do not thin uniformly.
        edgeStartBase: 0.40,
        edgeNoiseAmp: 0.22,
        edgeBaseThin: 0.12,
        edgeRimBoost: 0.14,

        // Ragged lowest-branch breakup.
        bottomBreak: 0.14,
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

export function validateTierRanges(nearEnd, tierRanges) {
    const warnings = [];
    // Fall back to module constants if not passed (grace period)
    const r = tierRanges || TREE_TIER_RANGES;
    const mid = r.mid || TREE_TIER_RANGES.mid;
    const near = r.near || TREE_TIER_RANGES.near;

    const nearFadeStart = nearEnd - (near.fadeOutWidth ?? 20);
    const midFadeEnd = mid.start + (mid.fadeInWidth ?? 40);

    // ── Check near tier's REAL end (leafBands[last].end) against
    //    tierRanges.near.end — these must agree or config is confused.
    if (Number.isFinite(near.end) && Math.abs(near.end - nearEnd) > 5) {
        warnings.push(
            `tierRanges.near.end (${near.end}m) ≠ actual leaf cutoff ` +
            `(leafBands[last].end = ${nearEnd}m). ` +
            `Change nearTier.leafBands[3].end, not tierRanges.near.end.`
        );
    }

    if (mid.start > nearEnd) {
        warnings.push(
            `Gap between near tier (leaves end at ${nearEnd}m) and mid tier ` +
            `(hulls start at ${mid.start}m). Trees vanish in [${nearEnd}, ${mid.start}]m.`
        );
    } else if (midFadeEnd < nearFadeStart) {
        warnings.push(
            `Mid tier fully faded in (${midFadeEnd}m) before near starts fading out ` +
            `(${nearFadeStart}m). Double-draw zone is wider than necessary.`
        );
    }

    return warnings;
}
