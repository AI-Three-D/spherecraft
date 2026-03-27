// js/renderer/streamer/TreeLODController.js

import { Logger } from '../../config/Logger.js';

export const SPECIES_SPRUCE = 0;
export const SPECIES_PINE   = 1;
export const SPECIES_BIRCH  = 2;

export class TreeLODController {
    constructor(config = {}) {
        this.leafBands = this._sanitizeLeafBands(
            config.leafBands ?? [
                { start:  0, end:  8 },
                { start:  7, end: 20 },
                { start: 19, end: 30 },
                { start: 25, end: 80 },
            ]
        );
        this.leafBandCount = this.leafBands.length;

        this.leafBandStarts = new Float32Array(4);
        this.leafBandEnds   = new Float32Array(4);
        for (let i = 0; i < 4; i++) {
            this.leafBandStarts[i] = this.leafBands[i]?.start ?? 999;
            this.leafBandEnds[i]   = this.leafBands[i]?.end   ?? 999;
        }

        this.detailBands     = this.leafBands.map(b => b.end);
        this.detailBandCount = this.detailBands.length;
        this.detailRange     = this.detailBands[this.detailBandCount - 1];

        this.maxCloseTrees = Math.max(1, config.maxCloseTrees ?? 512);

        this.maxBranchDetailLevel = Math.min(
            Math.max(0, config.maxBranchDetailLevel ?? 3),
            this.detailBandCount - 1
        );

        this.branchLODBands = this._sanitizeBranchLODBands(
            config.branchLODBands ?? [
                { distance: 50, maxLevel: 4 },
                { distance: 80, maxLevel: 2 },
            ]
        );
        this.branchLODBandCount = this.branchLODBands.length;

        this.branchLODDistances = new Float32Array(4);
        this.branchLODMaxLevels = new Float32Array(4);
        for (let i = 0; i < 4; i++) {
            this.branchLODDistances[i] = this.branchLODBands[i]?.distance ?? 9999;
            this.branchLODMaxLevels[i] = this.branchLODBands[i]?.maxLevel ?? 4;
        }

        const branchCutoff = this.getBranchCutoff();
        const branchMargin = config.branchFadeMargin
            ?? Math.max(10.0, branchCutoff * 0.15);
        this.branchFadeEnd   = branchCutoff;
        this.branchFadeStart = Math.max(1.0, branchCutoff - branchMargin);

        const leafRatio = config.leafFadeStartRatio ?? 0.82;
        this.leafFadeEnd   = this.detailRange;
        this.leafFadeStart = this.detailRange * leafRatio;

        this.maxTotalLeaves = config.maxTotalLeaves ?? 600_000;
        this.leafSizeMin    = config.leafSizeMin ?? 0.05;
        this.leafSizeMax    = config.leafSizeMax ?? 0.25;

        this.birchLadder = config.birchLadder ?? {
            l0: { cards:  1, w: 0.25, h: 0.35 },
            l1: { cards:  1, w: 0.25, h: 0.35 },
            l2: { cards: 20, w: 0.3, h: 0.42 },
            l3: { cards: 10, w: 0.36, h: 0.504 },
        };
        this.birchTransition = config.birchTransition ?? {
            nearDistance: 20.0,
            fadeDistance: 80.0,
            nearLeaves: 4000,
            nearW: 0.36,
            nearH: 0.54,
            midW: 0.28,
            midH: 0.42,
        };

        this.genericLeafCounts = this._padCounts(
            config.genericLeafCounts ?? [6000, 3000, 1500]
        );
        this.speciesLeafCounts = {};
        const inCounts = config.speciesLeafCounts ?? {
            [SPECIES_SPRUCE]: [3000, 1500, 700],
            [SPECIES_PINE]:   [3000, 1500, 700],
        };
        for (const [k, v] of Object.entries(inCounts)) {
            this.speciesLeafCounts[k] = this._padCounts(v);
        }

        // ═══════════════════════════════════════════════════════════════════
        // Mid-near tier config
        // ═══════════════════════════════════════════════════════════════════
        //
        // ARCHITECTURE CHANGE: instead of many small blobs at anchor
        // positions, we now render ONE canopy hull per tree plus one
        // trunk cylinder per tree plus impostor cards at anchor positions.
        //
        // The canopy hull is a low-poly sphere deformed IN THE VERTEX
        // SHADER to envelop the anchor cloud. The VS reads the anchor
        // positions for this tree from a GPU buffer and displaces each
        // hull vertex toward the nearest anchor cluster. This gives a
        // coherent silhouette that matches the near-tier's canopy shape
        // (since both use the same anchor positions).
        //
        // Impostor cards remain per-anchor (they provide leaf-texture
        // detail that the smooth hull can't). But they're drawn AFTER
        // the hull so they fill in texture inside the hull silhouette
        // rather than defining the silhouette themselves.

        this.midNearRange = this._sanitizeMidNearRange(
            config.midNearRange ?? { start: 55, end: 220 }
        );
        
        this.midNearBudgetTreeEstimate = config.midNearBudgetTreeEstimate ?? 1700;

        this.midNearOverlapNear = Math.max(1, config.midNearOverlapNear ?? 13);
        this.midNearOverlapFar  = Math.max(1, config.midNearOverlapFar  ?? 20);

        // Handoff zone: suppress stochastic instance culling so the FS
        // dither alone handles the near→mid-near crossfade.
        this.midNearHandoffEnd = Math.max(
            this.midNearRange.start + this.midNearOverlapNear + 1,
            config.midNearHandoffEnd ?? (this.detailRange + 2)
        );

        this.midNearSubBands = this._sanitizeMidNearSubBands(
            config.midNearSubBands ?? [
                { start:  55, end: 100 },
                { start: 100, end: 160 },
                { start: 160, end: 220 },
            ]
        );
        this.midNearSubBandOverlap = Math.max(1, config.midNearSubBandOverlap ?? 15);

        this.midNearSubBandStarts = new Float32Array(4);
        this.midNearSubBandEnds   = new Float32Array(4);
        for (let i = 0; i < 4; i++) {
            this.midNearSubBandStarts[i] = this.midNearSubBands[i]?.start ?? 99999;
            this.midNearSubBandEnds[i]   = this.midNearSubBands[i]?.end   ?? 99999;
        }

        // ── Budgets ────────────────────────────────────────────────────────
        this.maxMidNearTrees           = Math.max(1, config.maxMidNearTrees           ?? 4200);
        // Higher global impostor budget for denser mid-near canopies.
        this.maxMidNearAnchorImpostors = Math.max(1, config.maxMidNearAnchorImpostors ?? 180000);

        // ── Trunk config ───────────────────────────────────────────────────
        // The trunk must match the near-tier BranchRenderer's trunk at
        // the crossover distance. Key insight: BranchRenderer uses
        // tree.scaleX as the trunk WIDTH (the bark mesh is pre-modeled
        // with a radius of ~1 at the base), so our trunk base radius
        // must be tree.scaleX × 0.5 × some small fraction to match.
        //
        // Near-tier birch bark mesh analysis: the mesh unit-radius at
        // the base is ~0.025 relative to scaleX. So:
        //   trunkBaseRadius = tree.scaleX × 0.025
        // For a tree with scaleX=4: radius = 0.10m. That's correct for
        // a birch trunk (~20cm diameter at breast height).
        //
        // visibleHeightFrac: where the trunk disappears into the canopy.
        // Near-tier's branch mesh shows trunk up to about 40% of scaleY
        // before the canopy takes over. Match that.
        this.midNearTrunkConfig = config.midNearTrunkConfig ?? {
            visibleHeightFrac: 0.40,
            baseRadiusFrac:    0.025,   // was 0.08 — way too thick
            taperTop:          0.60,
            embedDepth:        0.35,
        };

        // ── Canopy hull config ─────────────────────────────────────────────
        // The hull is deformed per-vertex in the VS by sampling a
        // stratified anchor subset and applying directional support.
        // These parameters control that deformation.
        //
        // hullVertices: lat × lon resolution of the base sphere.
        //   Higher = smoother silhouette but more VS work per tree.
        //   At 55m a 12×8 sphere (96 verts, ~160 tris) is plenty.
        //   At 160m+ even 8×6 would suffice but we don't LOD the
        //   hull mesh (yet).
        //
        // hullInflation: how much to expand the hull beyond the anchor
        //   bounding sphere. 1.0 = hull exactly touches outermost
        //   anchors. 1.05 = 5% larger (covers leaf spread beyond
        //   anchor centres). Values > 1.15 make the canopy look puffy.
        //
        // hullShrinkWrap: strength of the per-vertex pull toward
        //   anchor support. 0 = pure ellipsoid, 1 = full support hull.
        //   Higher values follow the anchor cloud more faithfully but
        //   at the cost of a lumpier silhouette on low-poly hulls.
        //   0.7 is a good balance for 12×8.
        this.midNearCanopyHullConfig = config.midNearCanopyHullConfig ?? {
            // ~10x denser than the original 12x8 hull.
            hullLon: 24,
            hullLat: 14,
            hullInflation: 0.93,
            hullShrinkWrap: 1.00,
            // Base-shape and spread controls for preserving tall silhouettes.
            hullVerticalBias: 0.94,
            hullSpreadRadialScale: 0.86,
            hullSpreadVerticalScale: 0.64,
            // Very thin starting profile before anchor displacement.
            hullThinBase: 0.10,
            // Tighten crown cap so the hull does not overshoot near-tier leaves.
            hullTopShrinkStart: 0.54,
            hullTopShrinkEnd: 0.96,
            hullTopShrinkStrength: 0.46,
            canopyEnvelopeExpand: 0.92,
            canopyEnvelopeSoftness: 0.015,
            canopyBumpStrength: 0.18,
            canopyCutoutStrength: 0.016,
            canopyBrightness: 1.00,
            canopyFieldThreshold: 0.56,
            canopyFieldSoftness: 0.14,
            canopyFieldGain: 0.98,
            // Maximum number of anchors the VS samples per tree.
            // Raised to better capture narrow birch silhouettes.
            maxAnchorsPerTree: 64,
        };

        // Keep impostors enabled to add leaf texture/detail from ground view,
        // while the canopy hull preserves aerial volume.
        this.disableMidNearImpostors = config.disableMidNearImpostors ?? false;

        // ── Per-sub-band impostor config ───────────────────────────────────
        // Impostors remain per-anchor (they provide leaf-texture detail).
        // The hull handles silhouette; impostors handle interior texture.
        this.midNearSubBandConfig = config.midNearSubBandConfig ?? [
            {   // SB0: 55–100m — fine anchors, full drooper fidelity
                anchorTier: 0,
                impostorShape: 1,
                anchorKeepFrac: 1.00,
                impostorWeight: { start: 0.86, end: 1.00 },
                impostorCardScale: { w: 0.98, h: 1.34 },
            },
            {   // SB1: 100–160m — keep fine anchors, taper density gradually
                anchorTier: 0,
                impostorShape: 1,
                anchorKeepFrac: 0.98,
                impostorWeight: { start: 0.78, end: 0.92 },
                impostorCardScale: { w: 0.92, h: 1.24 },
            },
            {   // SB2: 160–220m — keep fine-derived families, then taper
                anchorTier: 0,
                impostorShape: 1,
                anchorKeepFrac: 0.90,
                impostorWeight: { start: 0.64, end: 0.82 },
                impostorCardScale: { w: 0.86, h: 1.12 },
            },
        ];

        Logger.info(
            `[TreeLODController] leafBands=[${this.leafBands.map(b => `${b.start}-${b.end}`).join(', ')}]m ` +
            `branchLOD=[${this.branchLODBands.map(b => `${b.distance}m:L${b.maxLevel}`).join(', ')}] ` +
            `maxCloseTrees=${this.maxCloseTrees} ` +
            `maxBranchDetailLevel=${this.maxBranchDetailLevel} ` +
            `branchFade=${this.branchFadeStart.toFixed(0)}→${this.branchFadeEnd.toFixed(0)}m ` +
            `leafFade=${this.leafFadeStart.toFixed(0)}→${this.leafFadeEnd.toFixed(0)}m`
        );
        Logger.info(
            `[TreeLODController] midNear=[${this.midNearRange.start}..${this.midNearRange.end}]m ` +
            `fadeIn=${this.midNearRange.start}→${this.midNearRange.start + this.midNearOverlapNear}m ` +
            `handoffEnd=${this.midNearHandoffEnd}m ` +
            `subBands=[${this.midNearSubBands.map(b => `${b.start}-${b.end}`).join(', ')}]m ` +
            `hull=${this.midNearCanopyHullConfig.hullLon}×${this.midNearCanopyHullConfig.hullLat} ` +
            `budgets(trees=${this.maxMidNearTrees}, impostors=${this.maxMidNearAnchorImpostors})`
        );
    }




        // ═══════════════════════════════════════════════════════════════════════
    // Bulk config update helpers (used by debug panel)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Merge partial canopy hull config and refresh derived arrays.
     * @param {object} partial — any subset of midNearCanopyHullConfig keys
     */
    updateCanopyHullConfig(partial) {
        Object.assign(this.midNearCanopyHullConfig, partial);
    }

    /**
     * Merge partial trunk config.
     * @param {object} partial — any subset of midNearTrunkConfig keys
     */
    updateTrunkConfig(partial) {
        Object.assign(this.midNearTrunkConfig, partial);
    }

    /**
     * Update a single sub-band config entry.
     * @param {number} index — 0, 1, or 2
     * @param {object} partial — any subset of the sub-band config
     */
    updateSubBandConfig(index, partial) {
        if (index < 0 || index >= this.midNearSubBandConfig.length) return;
        const entry = this.midNearSubBandConfig[index];
        if (partial.anchorKeepFrac !== undefined) entry.anchorKeepFrac = partial.anchorKeepFrac;
        if (partial.impostorWeight) {
            if (partial.impostorWeight.start !== undefined) entry.impostorWeight.start = partial.impostorWeight.start;
            if (partial.impostorWeight.end   !== undefined) entry.impostorWeight.end   = partial.impostorWeight.end;
        }
        if (partial.impostorCardScale) {
            if (partial.impostorCardScale.w !== undefined) entry.impostorCardScale.w = partial.impostorCardScale.w;
            if (partial.impostorCardScale.h !== undefined) entry.impostorCardScale.h = partial.impostorCardScale.h;
        }
    }

    /**
     * Refresh all derived float arrays from the current config objects.
     * Call after bulk-updating midNearSubBands, midNearRange, etc.
     */
    refreshDerivedMidNearState() {
        for (let i = 0; i < 4; i++) {
            this.midNearSubBandStarts[i] = this.midNearSubBands[i]?.start ?? 99999;
            this.midNearSubBandEnds[i]   = this.midNearSubBands[i]?.end   ?? 99999;
        }
        this.midNearHandoffEnd = Math.max(
            this.midNearRange.start + this.midNearOverlapNear + 1,
            this.detailRange + 2
        );
    }

    /**
     * Return a snapshot of all mid-near tunable parameters
     * (useful for serialisation / preset management).
     * @returns {object}
     */
    getMidNearSnapshot() {
        return {
            midNearRange: { ...this.midNearRange },
            midNearOverlapNear: this.midNearOverlapNear,
            midNearOverlapFar: this.midNearOverlapFar,
            midNearSubBandOverlap: this.midNearSubBandOverlap,
            midNearSubBands: this.midNearSubBands.map(b => ({ ...b })),
            midNearTrunkConfig: { ...this.midNearTrunkConfig },
            midNearCanopyHullConfig: { ...this.midNearCanopyHullConfig },
            midNearSubBandConfig: this.midNearSubBandConfig.map(c => ({
                anchorTier: c.anchorTier,
                impostorShape: c.impostorShape,
                anchorKeepFrac: c.anchorKeepFrac,
                impostorWeight: { ...c.impostorWeight },
                impostorCardScale: { ...c.impostorCardScale },
            })),
            disableMidNearImpostors: this.disableMidNearImpostors,
        };
    }

    /**
     * Restore a previously captured snapshot.
     * @param {object} snap — output of getMidNearSnapshot()
     */
    restoreMidNearSnapshot(snap) {
        if (!snap) return;
        if (snap.midNearRange) Object.assign(this.midNearRange, snap.midNearRange);
        if (Number.isFinite(snap.midNearOverlapNear)) this.midNearOverlapNear = snap.midNearOverlapNear;
        if (Number.isFinite(snap.midNearOverlapFar))  this.midNearOverlapFar  = snap.midNearOverlapFar;
        if (Number.isFinite(snap.midNearSubBandOverlap)) this.midNearSubBandOverlap = snap.midNearSubBandOverlap;
        if (Array.isArray(snap.midNearSubBands)) {
            for (let i = 0; i < Math.min(snap.midNearSubBands.length, this.midNearSubBands.length); i++) {
                Object.assign(this.midNearSubBands[i], snap.midNearSubBands[i]);
            }
        }
        if (snap.midNearTrunkConfig) Object.assign(this.midNearTrunkConfig, snap.midNearTrunkConfig);
        if (snap.midNearCanopyHullConfig) Object.assign(this.midNearCanopyHullConfig, snap.midNearCanopyHullConfig);
        if (Array.isArray(snap.midNearSubBandConfig)) {
            for (let i = 0; i < Math.min(snap.midNearSubBandConfig.length, this.midNearSubBandConfig.length); i++) {
                const s = snap.midNearSubBandConfig[i];
                const d = this.midNearSubBandConfig[i];
                if (s.anchorKeepFrac !== undefined) d.anchorKeepFrac = s.anchorKeepFrac;
                if (s.impostorWeight) Object.assign(d.impostorWeight, s.impostorWeight);
                if (s.impostorCardScale) Object.assign(d.impostorCardScale, s.impostorCardScale);
            }
        }
        if (snap.disableMidNearImpostors !== undefined) {
            this.disableMidNearImpostors = snap.disableMidNearImpostors;
        }
        this.refreshDerivedMidNearState();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Existing near-tier methods (UNCHANGED)
    // ═══════════════════════════════════════════════════════════════════════

    _sanitizeBranchLODBands(raw) {
        const src = Array.isArray(raw) ? raw : [];
        const out = [];
        let prevDist = 0;
        for (const b of src) {
            const dist = Number.isFinite(b?.distance) ? Math.max(prevDist + 1, b.distance) : prevDist + 50;
            const maxLevel = Number.isFinite(b?.maxLevel) ? Math.max(0, Math.min(4, b.maxLevel)) : 4;
            out.push({ distance: dist, maxLevel });
            prevDist = dist;
        }
        return out.length > 0 ? out : [{ distance: 9999, maxLevel: 4 }];
    }

    _sanitizeLeafBands(raw) {
        const src = Array.isArray(raw) ? raw : [];
        const out = [];
        let prevEnd = 0;
        for (let i = 0; i < src.length; i++) {
            const b = src[i] ?? {};
            let start = Number.isFinite(b.start) ? b.start : prevEnd;
            let end   = Number.isFinite(b.end)   ? b.end   : start + 10;
            start = Math.min(start, prevEnd);
            end   = Math.max(end, start + 1);
            out.push({ start, end });
            prevEnd = end;
        }
        return out.length > 0 ? out : [{ start: 0, end: 80 }];
    }

    _sanitizeBands(raw) {
        const out = [];
        let prev = 0;
        for (const b of (Array.isArray(raw) ? raw : [])) {
            const v = Number.isFinite(b) ? b : prev + 10.0;
            const clamped = Math.max(prev + 1.0, v);
            out.push(clamped);
            prev = clamped;
        }
        return out.length > 0 ? out : [15.0, 70.0, 150.0];
    }

    _padCounts(counts) {
        const src = Array.isArray(counts) ? counts : [];
        const out = [];
        for (let i = 0; i < this.detailBandCount; i++) {
            out.push(src[i] ?? src[src.length - 1] ?? 1000);
        }
        return out;
    }

    getBranchCutoff() {
        return this.detailBands[this.maxBranchDetailLevel];
    }

    getBranchLODShaderConfig() {
        return {
            branchLODBandCount:    this.branchLODBandCount,
            branchLODDistances:    Array.from(this.branchLODDistances),
            branchLODMaxLevels:    Array.from(this.branchLODMaxLevels),
        };
    }

    getLeafCounts(speciesIndex) {
        return this.speciesLeafCounts[speciesIndex] ?? this.genericLeafCounts;
    }

    getLegacyBands() {
        return {
            l0: this.detailBands[0],
            l1: this.detailBands[1] ?? this.detailBands[0] + 1,
            l2: this.detailBands[2] ?? (this.detailBands[1] ?? this.detailBands[0]) + 1,
        };
    }

    getLeafScatterShaderConfig() {
        const spruce = this.getLeafCounts(SPECIES_SPRUCE);
        const bl = this.birchLadder;
        const bt = this.birchTransition;
        return {
            maxCloseTrees: this.maxCloseTrees,
            maxLeaves:     this.maxTotalLeaves,
            birchL0Cards: bl.l0.cards, birchL0W: bl.l0.w,     birchL0H: bl.l0.h,
            birchL1Cards: bl.l1.cards, birchL1W: bl.l1.w,     birchL1H: bl.l1.h,
            birchL2Cards: bl.l2.cards, birchL2W: bl.l2.w,     birchL2H: bl.l2.h,
            birchL3Cards: bl.l3.cards, birchL3W: bl.l3.w,     birchL3H: bl.l3.h,
            birchNearDistance: bt.nearDistance,
            birchFadeDistance: bt.fadeDistance,
            birchNearLeaves: bt.nearLeaves,
            birchNearW: bt.nearW,
            birchNearH: bt.nearH,
            birchMidW: bt.midW,
            birchMidH: bt.midH,
            l0Leaves: this.genericLeafCounts[0],
            l1Leaves: this.genericLeafCounts[1],
            l2Leaves: this.genericLeafCounts[2],
            spruceL0Leaves: spruce[0],
            spruceL1Leaves: spruce[1],
            spruceL2Leaves: spruce[2],
        };
    }

    setDetailBands(bands) {
        let leafBands;
        if (Array.isArray(bands) && typeof bands[0] === 'object') {
            leafBands = bands;
        } else {
            const ends = Array.isArray(bands) ? bands : [];
            leafBands = ends.map((end, i) => ({
                start: i === 0 ? 0 : ends[i - 1] * 0.85,
                end,
            }));
        }
        this.leafBands = this._sanitizeLeafBands(leafBands);
        this.leafBandCount = this.leafBands.length;
        for (let i = 0; i < 4; i++) {
            this.leafBandStarts[i] = this.leafBands[i]?.start ?? 999;
            this.leafBandEnds[i]   = this.leafBands[i]?.end   ?? 999;
        }
        this.detailBands     = this.leafBands.map(b => b.end);
        this.detailBandCount = this.detailBands.length;
        this.detailRange     = this.detailBands[this.detailBandCount - 1];
        this.maxBranchDetailLevel = Math.min(
            this.maxBranchDetailLevel, this.detailBandCount - 1
        );
        const cutoff = this.getBranchCutoff();
        const margin = Math.max(10.0, cutoff * 0.15);
        this.branchFadeEnd   = cutoff;
        this.branchFadeStart = Math.max(1.0, cutoff - margin);
        this.leafFadeEnd   = this.detailRange;
        this.leafFadeStart = this.detailRange * 0.82;
        this.midNearHandoffEnd = Math.max(
            this.midNearRange.start + this.midNearOverlapNear + 1,
            this.detailRange + 2
        );
    }

    setBranchLODBands(bands) {
        this.branchLODBands = this._sanitizeBranchLODBands(bands);
        this.branchLODBandCount = this.branchLODBands.length;
        for (let i = 0; i < 4; i++) {
            this.branchLODDistances[i] = this.branchLODBands[i]?.distance ?? 9999;
            this.branchLODMaxLevels[i] = this.branchLODBands[i]?.maxLevel ?? 4;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Mid-near tier helpers
    // ═══════════════════════════════════════════════════════════════════════

    _sanitizeMidNearRange(raw) {
        const start = Number.isFinite(raw?.start) ? Math.max(0, raw.start) : 55;
        const end   = Number.isFinite(raw?.end)   ? Math.max(start + 10, raw.end) : 220;
        return { start, end };
    }

    _sanitizeMidNearSubBands(raw) {
        const src = Array.isArray(raw) ? raw : [];
        const out = [];
        let prevEnd = this.midNearRange?.start ?? 55;
        for (const b of src) {
            let start = Number.isFinite(b?.start) ? b.start : prevEnd;
            let end   = Number.isFinite(b?.end)   ? b.end   : start + 40;
            end = Math.max(end, start + 5);
            out.push({ start, end });
            prevEnd = end;
        }
        while (out.length < 3) {
            const last = out[out.length - 1] ?? { start: 55, end: 100 };
            out.push({ start: last.end, end: last.end + 60 });
        }
        return out.slice(0, 3);
    }

    getMidNearFadeBounds() {
        const r = this.midNearRange;
        return {
            fadeInStart:  r.start,
            fadeInEnd:    r.start + this.midNearOverlapNear,
            fadeOutStart: r.end - this.midNearOverlapFar,
            fadeOutEnd:   r.end,
        };
    }

    getMidNearShaderConfig() {
        const fb = this.getMidNearFadeBounds();
        const sbc = this.midNearSubBandConfig;
        const tc  = this.midNearTrunkConfig;
        const hc  = this.midNearCanopyHullConfig;

        const pad4 = (arr, fill) => {
            const out = [...arr];
            while (out.length < 4) out.push(fill);
            return out;
        };

        return {
            rangeStart:   this.midNearRange.start,
            rangeEnd:     this.midNearRange.end,
            fadeInStart:  fb.fadeInStart,
            fadeInEnd:    fb.fadeInEnd,
            fadeOutStart: fb.fadeOutStart,
            fadeOutEnd:   fb.fadeOutEnd,
            nearTierHandoffEnd: this.midNearHandoffEnd,
            disableMidNearImpostors: this.disableMidNearImpostors ? 1 : 0,

            subBandCount:   3,
            subBandStarts:  pad4(this.midNearSubBands.map(b => b.start), 99999),
            subBandEnds:    pad4(this.midNearSubBands.map(b => b.end),   99999),
            subBandOverlap: this.midNearSubBandOverlap,

            maxTrees:     this.maxMidNearTrees,
            maxImpostors: this.maxMidNearAnchorImpostors,
            
            // Budget stability
            budgetTreeEstimate: this.midNearBudgetTreeEstimate,

            // Impostor per-sub-band
            anchorTiers:        pad4(sbc.map(c => c.anchorTier),        2),
            impostorShapes:     pad4(sbc.map(c => c.impostorShape),     2),
            anchorKeepFracs:    pad4(sbc.map(c => c.anchorKeepFrac),    1.0),
            impWeightStarts:    pad4(sbc.map(c => c.impostorWeight.start), 0.5),
            impWeightEnds:      pad4(sbc.map(c => c.impostorWeight.end),   0.5),
            impCardScaleW:      pad4(sbc.map(c => c.impostorCardScale.w), 1.0),
            impCardScaleH:      pad4(sbc.map(c => c.impostorCardScale.h), 1.2),

            // Trunk
            trunkVisibleHeightFrac: tc.visibleHeightFrac,
            trunkBaseRadiusFrac:    tc.baseRadiusFrac,
            trunkTaperTop:          tc.taperTop,
            trunkEmbedDepth:        tc.embedDepth,

            // Canopy hull
            hullLon:             hc.hullLon,
            hullLat:             hc.hullLat,
            hullInflation:       hc.hullInflation,
            hullShrinkWrap:      hc.hullShrinkWrap,
            hullVerticalBias:    hc.hullVerticalBias,
            hullSpreadRadialScale: hc.hullSpreadRadialScale,
            hullSpreadVerticalScale: hc.hullSpreadVerticalScale,
            hullThinBase:        hc.hullThinBase,
            hullTopShrinkStart:  hc.hullTopShrinkStart,
            hullTopShrinkEnd:    hc.hullTopShrinkEnd,
            hullTopShrinkStrength: hc.hullTopShrinkStrength,
            canopyEnvelopeExpand: hc.canopyEnvelopeExpand,
            canopyEnvelopeSoftness: hc.canopyEnvelopeSoftness,
            canopyBumpStrength:  hc.canopyBumpStrength,
            canopyCutoutStrength: hc.canopyCutoutStrength,
            canopyBrightness:    hc.canopyBrightness,
            canopyFieldThreshold: hc.canopyFieldThreshold,
            canopyFieldSoftness: hc.canopyFieldSoftness,
            canopyFieldGain: hc.canopyFieldGain,
            maxAnchorsPerTree:   hc.maxAnchorsPerTree,
        };
    }

    setMidNearRange(start, end) {
        this.midNearRange = this._sanitizeMidNearRange({ start, end });
        this.midNearSubBands = this._sanitizeMidNearSubBands(this.midNearSubBands);
        for (let i = 0; i < 4; i++) {
            this.midNearSubBandStarts[i] = this.midNearSubBands[i]?.start ?? 99999;
            this.midNearSubBandEnds[i]   = this.midNearSubBands[i]?.end   ?? 99999;
        }
        this.midNearHandoffEnd = Math.max(
            this.midNearRange.start + this.midNearOverlapNear + 1,
            this.detailRange + 2
        );
    }
}
