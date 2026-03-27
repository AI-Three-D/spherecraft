// js/renderer/streamer/branch/species/BirchBranchGenerator.js
//
// Hierarchical branch generation system.
// Generates a tree of branch segments from species-specific growth rules,
// then linearizes them into segment arrays for GPU upload and mesh generation.
//
// Growth model:
//   - Trunk follows a gently curved spline with radius tapering and bulges
//   - Primary branches emerge at attachment points along the trunk, growing
//     outward+upward then arching under gravity (species-dependent)
//   - Secondary branches fork off primaries, inheriting parent direction
//     with controlled angular spread
//   - Tertiary twigs fork off secondaries, carrying leaf anchor points
//
// All coordinates are in normalized local space (Y-up, height ~1.0).
// Instance scaling happens at render time.

import {
    add3 as v3Add,
    sub3 as v3Sub,
    scale3 as v3Scale,
    lerp3 as v3Lerp,
    normalize3 as v3Normalize,
    length3 as v3Length,
    cross3 as v3Cross,
    dot3 as v3Dot,
    rotateAxis3 as v3RotateAxis,
    bezier3 as v3Bezier,
    perp3 as v3Perp
} from '../../../utils/vector3.js';
import { SeededRandom } from '../../../utils/SeededRandom.js';
import { Logger } from '../../../../config/Logger.js';
/*
export const BIRCH_DROOPER_DEFAULTS = Object.freeze({
    drooperCountMin: 4,
    drooperCountMax: 6,
    drooperLenFactorMin: 0.5,
    drooperLenFactorMax: 0.9,
    drooperSegMin: 4,
    drooperSegMax: 6,
    drooperArcAmpMin: 0.32,
    drooperArcAmpMax: 0.62,
    drooperWobbleMin: 0.040,
    drooperWobbleMax: 0.060,
    drooperDownBiasMid: 0.58,
    drooperDownBiasTip: 0.92,
    drooperForkChance: 0.55,
    fineAnchorSpacing: 0.022,
    fineAnchorMinPerDrooper: 10,
    fineAnchorMinPerTwig: 25,
});
*/
export const BIRCH_DROOPER_DEFAULTS = Object.freeze({
    drooperCountMin: 3,
    drooperCountMax: 5,
    drooperLenFactorMin: 0.5,
    drooperLenFactorMax: 0.9,
    drooperSegMin: 4,
    drooperSegMax: 6,
    drooperArcAmpMin: 0.32,
    drooperArcAmpMax: 0.62,
    drooperWobbleMin: 0.040,
    drooperWobbleMax: 0.060,
    drooperDownBiasMid: 0.58,
    drooperDownBiasTip: 0.92,
    drooperForkChance: 0.55,
    fineAnchorSpacing: 0.022,
    fineAnchorMinPerDrooper: 8,
    fineAnchorMinPerTwig: 12,
});
export const BIRCH_SILHOUETTE_DEFAULTS = Object.freeze({
    lengthTaperStart:  0.46,
    lengthTaperPower:  1.35,
    lengthTaperFloor:  0.08,
    upperLengthTaperStart: 0.72,
    upperLengthTaperFloor: 0.22,
    elevationCapStart: 0.42,
    elevationCapAtTop: -0.06,
    tipHeadroom:      -0.04,
    tipOvershootCap:   0.0,
});

export class BirchBranchGenerator {

    static generateBirch(seed, params = {}) {
        return this._generateBirchReworked(seed, params);
    }

    /**
 * Cumulative arc-length along a polyline.
 * [0]=0, [i]=distance from points[0] to points[i] along the polyline.
 */
static _cumulativeArcLength(points) {
    const n = points.length;
    const cum = new Float64Array(n);
    cum[0] = 0;
    for (let i = 1; i < n; i++) {
        cum[i] = cum[i - 1] + v3Length(v3Sub(points[i], points[i - 1]));
    }
    return cum;
}

/**
 * Sample position + tangent at a target arc-length along a polyline.
 * Returns { position, direction, segIdx }.
 * segIdx is the polyline segment index (0..n-2) containing targetLen.
 */
static _sampleAtArcLength(points, cumLen, targetLen) {
    const n = points.length;
    const total = cumLen[n - 1];
    const clamped = Math.max(0, Math.min(total - 1e-9, targetLen));

    // Linear scan — n ≤ ~10 for twigs/droopers, not worth binary search.
    for (let i = 1; i < n; i++) {
        if (cumLen[i] >= clamped) {
            const segLen = cumLen[i] - cumLen[i - 1];
            const localT = segLen > 1e-9 ? (clamped - cumLen[i - 1]) / segLen : 0;
            return {
                position: v3Lerp(points[i - 1], points[i], localT),
                direction: v3Normalize(v3Sub(points[i], points[i - 1])),
                segIdx: i - 1,
            };
        }
    }
    return {
        position: points[n - 1].slice(),
        direction: v3Normalize(v3Sub(points[n - 1], points[n - 2])),
        segIdx: n - 2,
    };
}

static _generateBirchReworked(seed, params = {}) {
    const rng = new SeededRandom(seed);
    const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));

    // Drooper + anchor config. See BIRCH_DROOPER_DEFAULTS header for knob docs.
    const cfg = { ...BIRCH_DROOPER_DEFAULTS, ...(params.drooper || {}) };
    const sil = { ...BIRCH_SILHOUETTE_DEFAULTS, ...(params.silhouette || {}) };

    // ─── Trunk path (unchanged) ────────────────────────────────────
    const height     = params.height     ?? rng.range(0.92, 1.16);
    const trunkBaseR = params.trunkBaseR ?? rng.range(0.022, 0.036);
    const heightNorm = clamp((height - 0.92) / (1.16 - 0.92), 0.0, 1.0);

    const crownCfg = {
        startTallReduction:      params.crown?.startTallReduction      ?? 0.14,
        extraBranchesAtMax:      params.crown?.extraBranchesAtMax      ?? 12,
        packPowerBase:           params.crown?.packPowerBase           ?? 1.28,
        packPowerBoostAtMax:     params.crown?.packPowerBoostAtMax     ?? 0.30,
    };
    
    const crownStartBase = rng.range(0.18, 0.42);
    const crownStart = clamp(
        params.crownStart ?? (crownStartBase - heightNorm * crownCfg.startTallReduction),
        0.10, 0.48
    );
    const crownEnd  = 0.97;
    const crownSpan = Math.max(0.10, crownEnd - crownStart);
    
    const extraBranches  = Math.round(heightNorm * crownCfg.extraBranchesAtMax);
    const baseBranchCount = params.mainBranchCount ?? rng.rangeInt(12, 16);
    const trunkMainCount  = Math.max(10, baseBranchCount + extraBranches);
    
    const crownPackPower = crownCfg.packPowerBase + heightNorm * crownCfg.packPowerBoostAtMax;

    const trunkLean     = rng.range(0.015, 0.080);
    const trunkLeanDir  = rng.range(0, Math.PI * 2);
    const trunkWobble   = rng.range(0.010, 0.040);
    const trunkRidgeAmp = rng.range(0.007, 0.020);

    const trunkSegCount = 18;
    const trunkPath = [];
    const leanX = Math.cos(trunkLeanDir);
    const leanZ = Math.sin(trunkLeanDir);

    for (let i = 0; i <= trunkSegCount; i++) {
        const t = i / trunkSegCount;
        const y = t * height;
        const lean   = t * t * trunkLean;
        const wobble = Math.sin(t * Math.PI * 2.7 + 0.41) * trunkWobble;
        const twist  = Math.sin(t * Math.PI * 4.4 + 1.1) * trunkWobble * 0.28;
        const x = leanX * lean + leanX * wobble + leanZ * twist * 0.22;
        const z = leanZ * lean * 0.35 + leanZ * wobble * 0.74 - leanX * twist * 0.18;

        let radius = trunkBaseR * (1.0 - Math.pow(t, 1.45) * 0.86);
        if (t < 0.08) {
            const flare = 1.0 - t / 0.08;
            radius += trunkBaseR * 0.24 * flare * flare;
        }
        if (t > crownStart && t < crownEnd) {
            const crownT = (t - crownStart) / crownSpan;
            const swell = Math.max(0.0, 1.0 - crownT / 0.56);
            radius += trunkBaseR * 0.08 * swell * swell;
        }
        radius += Math.sin(t * 10.8 + 1.3) * trunkBaseR * trunkRidgeAmp;
        radius = Math.max(trunkBaseR * 0.05, radius);

        trunkPath.push({ position: [x, y, z], radius, t });
    }
    for (let i = 0; i < trunkPath.length; i++) {
        if (i < trunkPath.length - 1) {
            trunkPath[i].direction = v3Normalize(v3Sub(trunkPath[i + 1].position, trunkPath[i].position));
        } else {
            trunkPath[i].direction = trunkPath[i - 1].direction;
        }
    }

    // ─── Segment emission with chainId tracking ────────────────────
    const allSegments = [];
    const allAnchors  = [];
    let segId = 0;
    let chainId = 0;

    // Trunk = chain 0. (The mesh builder uses trunkPath directly so
    // chainId on trunk segs is for graph completeness, not meshing.)
    const trunkSegmentCount = trunkPath.length - 1;
    for (let i = 0; i < trunkPath.length - 1; i++) {
        allSegments.push({
            id: segId++,
            start: trunkPath[i].position,
            end:   trunkPath[i + 1].position,
            startRadius: trunkPath[i].radius,
            endRadius:   trunkPath[i + 1].radius,
            level: 0,
            parentId: i > 0 ? segId - 2 : -1,
            chainId: 0,
        });
    }
    chainId = 1;

    // ─── Main branches (level 2) — one chainId each ────────────────
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const baseAzimuth = rng.range(0, Math.PI * 2);

    const mainBranches = [];

    for (let i = 0; i < trunkMainCount; i++) {
        const u = (i + 0.5) / trunkMainCount;
        const crownT = clamp(Math.pow(u, crownPackPower) + rng.range(-0.06, 0.06), 0.0, 1.0);
        const tOnTrunk = crownStart + crownT * crownSpan;

        const trunkPos = this._sampleTrunkPath(trunkPath, tOnTrunk, height);
        const trunkDir = this._sampleTrunkDirection(trunkPath, tOnTrunk, height);
        const trunkR   = this._sampleTrunkRadius(trunkPath, tOnTrunk, height);
        const parentSegId = Math.min(trunkSegmentCount - 1, Math.max(0, Math.floor(tOnTrunk * trunkSegmentCount)));

        const azimuth = baseAzimuth + i * goldenAngle + rng.range(-0.34, 0.34);
        const outDir = [Math.cos(azimuth), 0.0, Math.sin(azimuth)];

        let elevation;
        if      (crownT < 0.20) elevation = rng.range(-0.04, 0.28);
        else if (crownT < 0.50) elevation = rng.range( 0.06, 0.38);
        else if (crownT < 0.78) elevation = rng.range( 0.18, 0.52);
        else                    elevation = rng.range( 0.38, 0.72);
        elevation += rng.range(-0.08, 0.08);
        if (crownT > sil.elevationCapStart) {
            const capT = (crownT - sil.elevationCapStart) / (1.0 - sil.elevationCapStart);
            const maxElev = 0.52 * (1.0 - capT) + sil.elevationCapAtTop * capT;
            elevation = Math.min(elevation, maxElev);
        }

        let initDir = v3Normalize([
            outDir[0] * Math.cos(elevation),
            Math.sin(elevation),
            outDir[2] * Math.cos(elevation),
        ]);
        const trunkMix = 0.12 + crownT * 0.10;
        initDir = v3Normalize([
            initDir[0] * (1.0 - trunkMix) + trunkDir[0] * trunkMix,
            initDir[1] * (1.0 - trunkMix) + trunkDir[1] * trunkMix,
            initDir[2] * (1.0 - trunkMix) + trunkDir[2] * trunkMix,
        ]);

        // Length with early taper + headroom cap.
        const widthShape = this._birchWidthProfile(crownT);
        let length = (0.18 + widthShape * 0.44) * rng.range(0.82, 1.24);
        if (crownT > sil.lengthTaperStart) {
            const taperSpan = 1.0 - sil.lengthTaperStart;
            const taperT = (crownT - sil.lengthTaperStart) / taperSpan;
            const taperMul = 1.0 - (1.0 - sil.lengthTaperFloor) * Math.pow(taperT, sil.lengthTaperPower);
            length *= taperMul;
        }
        if (crownT > sil.upperLengthTaperStart) {
            const upperSpan = Math.max(1e-5, 1.0 - sil.upperLengthTaperStart);
            const upperT = (crownT - sil.upperLengthTaperStart) / upperSpan;
            const upperMul = 1.0 - (1.0 - sil.upperLengthTaperFloor) * upperT;
            length *= upperMul;
        }
        const trunkTipY = trunkPath[trunkPath.length - 1].position[1];
        const headroom  = (trunkTipY - trunkPos[1]) + sil.tipHeadroom;
        if (initDir[1] > 0.05) {
            const maxByHeadroom = headroom / initDir[1];
            if (length > maxByHeadroom) length = maxByHeadroom;
        }
        length = Math.max(length, 0.04);
        const upperCanopyT = clamp((crownT - 0.68) / 0.32, 0.0, 1.0);

        const startRadius = Math.max(0.0011, trunkR * rng.range(0.18, 0.38) * (1.0 - crownT * 0.24));

        const grown = this._growBirchBranchChain(rng, allSegments, {
            level: 2,
            startPos: trunkPos,
            startDir: initDir,
            outwardDir: outDir,
            length,
            startRadius,
            segmentCount: rng.rangeInt(8, 13),
            parentSegId,
            protrusionBias: 0.82 - crownT * 0.34,
            gravityDroop:   rng.range(0.01, 0.04) + upperCanopyT * 0.045,
            upholdStrength: rng.range(0.50, 0.80) * (1.0 - 0.80 * upperCanopyT),
            taper:          rng.range(0.68, 0.86),
            minRadius: 0.00055,
            kinkMin: 3, kinkMax: 7,
            kinkAngleMin: 0.14, kinkAngleMax: 0.48,
            lateralAmp: rng.range(0.018, 0.055),
            twistAmp:   rng.range(0.008, 0.028),
            smooth: 0.25,
            kinkHardness: 3.2,
            jitter: 0.035,
            maxY: trunkTipY + sil.tipOvershootCap,
            chainId: chainId,           // ← NEW
        }, segId);
        segId = grown.nextSegId;
        chainId++;                      // ← NEW — one chain per main branch

        mainBranches.push({ ...grown, crownProgress: crownT });
    }

    // ─── Twigs + droopers (geometry only, anchors come later) ─────
    for (const main of mainBranches) {
        const lowerness = 1.0 - main.crownProgress;
        const twigResult = this._emitBirchTwigs(rng, allSegments, main, segId, chainId, {
            countMin: lowerness > 0.45 ? 4 : 3,
            countMax: lowerness > 0.45 ? 8 : 5,
            countCap: lowerness > 0.45 ? 7 : 5,
            tMin:     lowerness > 0.45 ? 0.18 : 0.26,
            lenMin: 0.05,  lenMax: 0.15,
            outMin: 0.34,  outMax: 0.72,
            alongMin: 0.10, alongMax: 0.26,
            dropMin: 0.06, dropMax: 0.20,
            liftMin: 0.04, liftMax: 0.14,
            parentTaper: 0.74,
            radMin: 0.16,  radMax: 0.32,
            segMin: 6,     segMax: 10,
        }, cfg);
        segId   = twigResult.nextSegId;
        chainId = twigResult.nextChainId;
        main.twigInfos = twigResult.twigInfos;
    }

    // ─── Hierarchical anchors — fine → medium → coarse ────────────
    // DO NOT sort allAnchors after this call. childStart indices are positional.
    const anchorStats = this._emitHierarchicalAnchors(rng, allAnchors, mainBranches, cfg);
    Logger.info(
        `[BirchGen] seed=${seed} main=${mainBranches.length} ` +
        `anchors(f/m/c)=${anchorStats.fine}/${anchorStats.medium}/${anchorStats.coarse} ` +
        `fineByBand=${JSON.stringify(anchorStats.fineByBand)}`
    );

    return {
        segments: allSegments,
        anchors:  allAnchors,
        trunkPath,
        stats: {
            segmentCount: allSegments.length,
            anchorCount:  allAnchors.length,
            anchorFine:   anchorStats.fine,
            anchorMedium: anchorStats.medium,
            anchorCoarse: anchorStats.coarse,
            anchorFineByBand: anchorStats.fineByBand,
            maxDepth:     4,
            primaryCount: mainBranches.length,
        },
    };
}
    static _birchWidthProfile(crownT) {
        // Birch canopy: bottom branches are long, mid-crown stays wide
        // or even slightly wider, then tapers at top.
        const t = Math.max(0.0, Math.min(1.0, crownT));
        if (t < 0.08) {
            // Very bottom — long branches right away
            return 0.85 + (t / 0.08) * 0.10;
        }
        if (t < 0.30) {
            // Lower crown — approaching peak
            const u = (t - 0.08) / 0.22;
            return 0.95 + u * 0.05;
        }
        if (t < 0.60) {
            // Mid-crown — peak width, stays wide
            return 1.0;
        }
        if (t < 0.80) {
            // Upper — begins tapering
            const u = (t - 0.60) / 0.20;
            return 1.0 - u * 0.40;
        }
        // Top — rapid taper
        const u = (t - 0.80) / 0.20;
        return Math.max(0.04, 0.60 - u * 0.68);
    }

    /**
 * Emit level-4 drooping twigs off a level-3 twig.
 *
 * Bezier-shaped centerline with lateral arc + wobble overlay — same recipe
 * as the twig builder. The overall gesture droops (p2/p3 pull downward) but
 * the path curves sideways and wobbles on the way down, so it never looks
 * like a plumb string. Each drooper can fork once mid-length.
 */
static _emitBirchDroopers(rng, allSegments, parentTwig, segIdStart, chainIdStart, cfg) {
    let segId = segIdStart;
    let chainId = chainIdStart;
    const drooperInfos = [];

    const { points: twigPoints, segIds: twigSegIds, cumLen: twigCumLen, startRadius: twigR } = parentTwig;
    const twigTotal = twigCumLen[twigCumLen.length - 1];
    if (twigTotal < 1e-5) {
        return { nextSegId: segId, nextChainId: chainId, drooperInfos };
    }

    const drooperCount = rng.rangeInt(cfg.drooperCountMin, cfg.drooperCountMax);

    for (let d = 0; d < drooperCount; d++) {
        const drooperSeed = (Math.floor(rng.next() * 0x100000000) ^ ((d * 0x85EBCA6B) >>> 0)) >>> 0;
        const drRng = new SeededRandom(drooperSeed);

        // Tip drooper first (most visible), rest along 0.35..0.92 arc-length.
        const attachFrac = d === 0 ? drRng.range(0.88, 0.98) : drRng.range(0.35, 0.92);
        const attach = this._sampleAtArcLength(twigPoints, twigCumLen, attachFrac * twigTotal);
        const parentSegId = twigSegIds[Math.min(attach.segIdx, twigSegIds.length - 1)];

        // Initial heading: blend parent tangent + lateral + down. Alternate sides.
        const parentTan = attach.direction;
        const side  = v3Perp(parentTan);
        const side2 = v3Normalize(v3Cross(parentTan, side));
        const sideSign = (d & 1) === 0 ? 1.0 : -1.0;

        const initDir = v3Normalize([
            parentTan[0] * drRng.range(0.25, 0.50)
                + side[0]  * drRng.range(0.30, 0.65) * sideSign
                + side2[0] * drRng.range(-0.20, 0.20),
            parentTan[1] * 0.12 - drRng.range(0.12, 0.30),
            parentTan[2] * drRng.range(0.25, 0.50)
                + side[2]  * drRng.range(0.30, 0.65) * sideSign
                + side2[2] * drRng.range(-0.20, 0.20),
        ]);

        const drooperLen = twigTotal * drRng.range(cfg.drooperLenFactorMin, cfg.drooperLenFactorMax);

        // ─── Bezier with progressive droop + lateral arc ────────────
        // The lateral arc is the anti-string ingredient: it swings the
        // drooper sideways as it falls. Real birch droopers never hang
        // plumb; they curve out, down, and a bit back.
        const down = [0, -1, 0];
        const p0 = attach.position.slice();

        let p1 = v3Add(p0, v3Add(v3Scale(initDir, drooperLen * 0.28), v3Scale(down, drooperLen * 0.03)));
        let p2 = v3Add(p0, v3Add(v3Scale(initDir, drooperLen * 0.58), v3Scale(down, drooperLen * cfg.drooperDownBiasMid)));
        let p3 = v3Add(p0, v3Add(v3Scale(initDir, drooperLen * 0.84), v3Scale(down, drooperLen * cfg.drooperDownBiasTip)));

        const arcSign = drRng.next() < 0.5 ? -1.0 : 1.0;
        const arcAmp  = drooperLen * drRng.range(cfg.drooperArcAmpMin, cfg.drooperArcAmpMax);
        p1 = v3Add(p1, v3Add(v3Scale(side, arcAmp * 0.50 * arcSign), v3Scale(side2, arcAmp * drRng.range(-0.25, 0.25))));
        p2 = v3Add(p2, v3Add(v3Scale(side, arcAmp * 1.00 * arcSign), v3Scale(side2, arcAmp * drRng.range(-0.35, 0.35))));
        p3 = v3Add(p3, v3Add(v3Scale(side, arcAmp * 0.70 * arcSign), v3Scale(side2, arcAmp * drRng.range(-0.25, 0.25))));

        // ─── Sample bezier + wobble overlay ─────────────────────────
        const drooperSegs = drRng.rangeInt(cfg.drooperSegMin, cfg.drooperSegMax);
        const wobbleFreq  = drRng.range(1.8, 3.5);
        const wobblePhase = drRng.range(0, Math.PI * 2);
        const wobbleAmp   = drooperLen * drRng.range(cfg.drooperWobbleMin, cfg.drooperWobbleMax);

        const drooperPoints = [];
        for (let s = 0; s <= drooperSegs; s++) {
            const t = s / drooperSegs;
            let pos = v3Bezier(p0, p1, p2, p3, t);
            const wScale = Math.sin(Math.PI * t);  // zero at ends → no kink at attach
            const w1 = Math.sin(t * Math.PI * 2 * wobbleFreq + wobblePhase) * wobbleAmp * wScale;
            const w2 = Math.cos(t * Math.PI * 2 * (wobbleFreq * 0.73) + wobblePhase * 0.67) * wobbleAmp * 0.6 * wScale;
            pos = v3Add(pos, v3Add(v3Scale(side, w1), v3Scale(side2, w2)));
            drooperPoints.push(pos);
        }

        // ─── Emit segments — CONTINUOUS radius ──────────────────────
        // Parent twig radius at attach (twig uses taper 0.88 — see _emitBirchTwigs).
        const parentRAtAttach = Math.max(0.00034, twigR * (1.0 - attachFrac * 0.88));
        const drooperR = Math.max(0.00028, parentRAtAttach * drRng.range(0.45, 0.65));

        const drooperTaper = 0.90;
        const drooperMinR  = 0.00016;
        const drooperChainId = chainId++;
        const drooperSegIds = [];

        for (let s = 0; s < drooperSegs; s++) {
            const t0 = s / drooperSegs;
            const t1 = (s + 1) / drooperSegs;
            // Same formula, same clamp → seg[i].endR === seg[i+1].startR.
            const r0 = Math.max(drooperMinR, drooperR * (1.0 - t0 * drooperTaper));
            const r1 = Math.max(drooperMinR, drooperR * (1.0 - t1 * drooperTaper));

            allSegments.push({
                id: segId++,
                start: drooperPoints[s].slice(),
                end:   drooperPoints[s + 1].slice(),
                startRadius: r0,
                endRadius:   r1,
                level: 4,
                parentId: drooperSegIds.length > 0
                    ? drooperSegIds[drooperSegIds.length - 1]
                    : parentSegId,
                chainId: drooperChainId,
            });
            drooperSegIds.push(segId - 1);
        }

        // ─── Optional fork ──────────────────────────────────────────
        let fork = null;
        if (drRng.next() < cfg.drooperForkChance && drooperSegs >= 4) {
            fork = this._emitBirchDrooperFork(drRng, allSegments, {
                points: drooperPoints,
                segIds: drooperSegIds,
                length: drooperLen,
                startRadius: drooperR,
                side, side2,
            }, segId, chainId, cfg);
            segId = fork.nextSegId;
            chainId = fork.nextChainId;
        }

        drooperInfos.push({ points: drooperPoints, segIds: drooperSegIds, chainId: drooperChainId, fork });
    }

    return { nextSegId: segId, nextChainId: chainId, drooperInfos };
}

/**
 * Single fork off a drooper. Same bezier+wobble recipe, shorter.
 */
static _emitBirchDrooperFork(rng, allSegments, parent, segIdStart, chainIdStart, cfg) {
    let segId = segIdStart;
    let chainId = chainIdStart;

    const cumLen = this._cumulativeArcLength(parent.points);
    const total = cumLen[cumLen.length - 1];
    const attachFrac = rng.range(0.35, 0.65);
    const attach = this._sampleAtArcLength(parent.points, cumLen, attachFrac * total);
    const parentSegId = parent.segIds[Math.min(attach.segIdx, parent.segIds.length - 1)];

    const parentTan = attach.direction;
    const { side, side2 } = parent;
    const forkSide = rng.next() < 0.7 ? -1.0 : 1.0;  // usually opposite of parent's arc

    const initDir = v3Normalize([
        parentTan[0] * 0.35 + side[0] * rng.range(0.40, 0.70) * forkSide,
        parentTan[1] * 0.10 - rng.range(0.15, 0.32),
        parentTan[2] * 0.35 + side[2] * rng.range(0.40, 0.70) * forkSide,
    ]);

    const forkLen = parent.length * rng.range(0.40, 0.70);
    const down = [0, -1, 0];

    const p0 = attach.position.slice();
    let p1 = v3Add(p0, v3Add(v3Scale(initDir, forkLen * 0.30), v3Scale(down, forkLen * 0.04)));
    let p2 = v3Add(p0, v3Add(v3Scale(initDir, forkLen * 0.60), v3Scale(down, forkLen * cfg.drooperDownBiasMid * 0.85)));
    let p3 = v3Add(p0, v3Add(v3Scale(initDir, forkLen * 0.85), v3Scale(down, forkLen * cfg.drooperDownBiasTip * 0.85)));

    const arcAmp = forkLen * rng.range(cfg.drooperArcAmpMin, cfg.drooperArcAmpMax);
    p1 = v3Add(p1, v3Scale(side2, arcAmp * rng.range(-0.40, 0.40)));
    p2 = v3Add(p2, v3Scale(side2, arcAmp * rng.range(-0.60, 0.60)));
    p3 = v3Add(p3, v3Scale(side2, arcAmp * rng.range(-0.50, 0.50)));

    const forkSegs = Math.max(3, Math.floor((cfg.drooperSegMin + cfg.drooperSegMax) / 2) - 1);
    const wobbleFreq  = rng.range(2.0, 3.8);
    const wobblePhase = rng.range(0, Math.PI * 2);
    const wobbleAmp   = forkLen * rng.range(cfg.drooperWobbleMin, cfg.drooperWobbleMax);

    const forkPoints = [];
    for (let s = 0; s <= forkSegs; s++) {
        const t = s / forkSegs;
        let pos = v3Bezier(p0, p1, p2, p3, t);
        const wScale = Math.sin(Math.PI * t);
        pos = v3Add(pos, v3Scale(side, Math.sin(t * Math.PI * 2 * wobbleFreq + wobblePhase) * wobbleAmp * wScale));
        forkPoints.push(pos);
    }

    // Radius derived from parent drooper at attach point.
    const parentRAtAttach = Math.max(0.00016, parent.startRadius * (1.0 - attachFrac * 0.90));
    const forkR = Math.max(0.00020, parentRAtAttach * rng.range(0.50, 0.70));
    const forkTaper = 0.92;
    const forkMinR  = 0.00012;
    const forkChainId = chainId++;
    const forkSegIds = [];

    for (let s = 0; s < forkSegs; s++) {
        const t0 = s / forkSegs;
        const t1 = (s + 1) / forkSegs;
        const r0 = Math.max(forkMinR, forkR * (1.0 - t0 * forkTaper));
        const r1 = Math.max(forkMinR, forkR * (1.0 - t1 * forkTaper));

        allSegments.push({
            id: segId++,
            start: forkPoints[s].slice(),
            end:   forkPoints[s + 1].slice(),
            startRadius: r0,
            endRadius:   r1,
            level: 4,
            parentId: forkSegIds.length > 0 ? forkSegIds[forkSegIds.length - 1] : parentSegId,
            chainId: forkChainId,
        });
        forkSegIds.push(segId - 1);
    }

    return { nextSegId: segId, nextChainId: chainId, points: forkPoints, segIds: forkSegIds, chainId: forkChainId };
}

    static _growBirchBranchChain(rng, allSegments, options, segIdStart) {
        const startPos = options.startPos.slice();
        const startDir = v3Normalize(options.startDir);
        const outwardDir = v3Normalize(options.outwardDir);
        const level = options.level ?? 2;
        const branchLength = Math.max(0.02, options.length ?? 0.2);
        const segmentCount = Math.max(3, options.segmentCount ?? 8);
        const startRadius = Math.max(0.0005, options.startRadius ?? 0.002);
        const taper = options.taper ?? 0.82;
        const minRadius = options.minRadius ?? 0.0004;
        const gravityDroop = options.gravityDroop ?? 0.02;
        const upholdStrength = options.upholdStrength ?? 0.6;
        const jitter = options.jitter ?? 0.02;
        const smooth = options.smooth ?? 0.55;
        const maxY = Number.isFinite(options.maxY) ? options.maxY : Infinity;

        const sideA = v3Perp(startDir);
        const sideB = v3Normalize(v3Cross(startDir, sideA));
        const lateralAmp = (options.lateralAmp ?? 0.03) * branchLength;
        const twistAmp = (options.twistAmp ?? 0.012) * branchLength;
        const wobbleFreq = rng.range(1.4, 3.2);
        const wobblePhase = rng.range(0, Math.PI * 2);

        const kinkMin = options.kinkMin ?? 1;
        const kinkMax = options.kinkMax ?? 3;
        const kinkAngleMin = options.kinkAngleMin ?? 0.04;
        const kinkAngleMax = options.kinkAngleMax ?? 0.18;
        const kinkHardness = options.kinkHardness ?? 1.0;
        const kinkEvents = [];
        const kinkCount = rng.rangeInt(kinkMin, kinkMax);
        for (let i = 0; i < kinkCount; i++) {
            // Each kink gets a random 3D axis for non-planar, organic bends
            const axisBlend = rng.range(0.0, 1.0);
            const kinkAxis = v3Normalize([
                sideA[0] * axisBlend + sideB[0] * (1.0 - axisBlend),
                rng.range(-0.4, 0.4),
                sideA[2] * axisBlend + sideB[2] * (1.0 - axisBlend)
            ]);
            kinkEvents.push({
                t: rng.range(0.08, 0.92),
                width: rng.range(0.04, 0.12),
                angle: rng.range(kinkAngleMin, kinkAngleMax) * (rng.next() < 0.5 ? -1 : 1),
                axis: kinkAxis
            });
        }
        kinkEvents.sort((a, b) => a.t - b.t);

        let segId = segIdStart;
        let curPos = startPos.slice();
        let curDir = startDir.slice();
        let curR = startRadius;
        const segIds = [];
        const points = [curPos.slice()];
        const segLen = branchLength / segmentCount;

        for (let s = 0; s < segmentCount; s++) {
            const segT = (s + 1) / segmentCount;
            const wobbleA = Math.sin(segT * Math.PI * 2.0 * wobbleFreq + wobblePhase) * lateralAmp;
            const wobbleB = Math.cos(segT * Math.PI * 2.0 * (wobbleFreq * 0.72) + wobblePhase * 0.81) * twistAmp;

            // Birch branches mostly maintain their initial trajectory.
            // Only very mild gravity effect, strongest at tips.
            const gravity = gravityDroop * segT * segT;
            // "Uphold" keeps the branch close to its initial direction —
            // this prevents the bow/pine shape and keeps birch branches
            // going outward+upward as they do in reality.
            const upholdY = startDir[1] * upholdStrength;

            const outPush = (options.protrusionBias ?? 0.8) * (1.0 - segT * 0.7);

            // Kinks — applied at FULL strength to all axes (no 0.45 damping on Y)
            let kinkX = 0.0;
            let kinkY = 0.0;
            let kinkZ = 0.0;
            for (const kink of kinkEvents) {
                const d = Math.abs(segT - kink.t);
                if (d < kink.width) {
                    const w = Math.pow(1.0 - d / kink.width, kinkHardness);
                    kinkX += kink.axis[0] * kink.angle * w;
                    kinkY += kink.axis[1] * kink.angle * w;
                    kinkZ += kink.axis[2] * kink.angle * w;
                }
            }

            const targetDir = v3Normalize([
                curDir[0] + outwardDir[0] * outPush + sideA[0] * (wobbleA / Math.max(branchLength, 1e-5)) + sideB[0] * (wobbleB / Math.max(branchLength, 1e-5)) + kinkX + rng.range(-jitter, jitter),
                curDir[1] + upholdY - gravity + kinkY + rng.range(-jitter * 0.7, jitter * 0.7),
                curDir[2] + outwardDir[2] * outPush + sideA[2] * (wobbleA / Math.max(branchLength, 1e-5)) + sideB[2] * (wobbleB / Math.max(branchLength, 1e-5)) + kinkZ + rng.range(-jitter, jitter)
            ]);

            const kinkInfluence = Math.abs(kinkX) + Math.abs(kinkY) + Math.abs(kinkZ);
            // When a kink is active, drop smoothing so the direction change is sharp
            const localSmooth = Math.max(0.15, smooth - Math.min(0.30, kinkInfluence * 1.2));
            curDir = v3Normalize([
                curDir[0] * localSmooth + targetDir[0] * (1.0 - localSmooth),
                curDir[1] * localSmooth + targetDir[1] * (1.0 - localSmooth),
                curDir[2] * localSmooth + targetDir[2] * (1.0 - localSmooth)
            ]);

            let nextPos = v3Add(curPos, v3Scale(curDir, segLen));
            if (nextPos[1] > maxY) {
                nextPos = [nextPos[0], maxY, nextPos[2]];
                // Hit trunk-tip cap: remove upward drift so remaining segments
                // flatten or fall instead of climbing above the cap.
                if (curDir[1] > 0.0) {
                    const horizLenSq = curDir[0] * curDir[0] + curDir[2] * curDir[2];
                    if (horizLenSq > 1e-8) {
                        curDir = v3Normalize([curDir[0], 0.0, curDir[2]]);
                    } else {
                        curDir = [0.0, -1.0, 0.0];
                    }
                }
            }
            const nextR = Math.max(minRadius, startRadius * (1.0 - segT * taper));

            allSegments.push({
                id: segId++,
                start: curPos.slice(),
                end:   nextPos.slice(),
                startRadius: curR,
                endRadius:   nextR,
                level,
                parentId: segIds.length > 0 ? segIds[segIds.length - 1] : options.parentSegId,
                chainId: options.chainId,
            });
            segIds.push(segId - 1);
            points.push(nextPos.slice());

            curPos = nextPos;
            curR = nextR;
        }

        return {
            segIds,
            points,
            direction: curDir,
            startRadius,
            endRadius: curR,
            length: branchLength,
            nextSegId: segId
        };
    }


/**
 * Three-tier anchor emission with parent→child index links.
 *
 * EMISSION ORDER MATTERS. Fine first, then medium, then coarse. The final
 * array is tier-sorted by construction. childStart/childCount are positional
 * indices into this array — a sort after this call would corrupt them.
 *
 * Tier 0 (fine):   On drooper polylines, arc-length spaced. The fix for the
 *                  old parametric-t placement: that clumped anchors at curve
 *                  bends (uniform t ≠ uniform distance on a curved path).
 *                  Position is on-centerline (no radial jitter) so leaf card
 *                  stems have a shot at connecting to geometry.
 * Tier 1 (medium): One per twig at its attach point. childStart/Count point
 *                  to this twig's fine anchors. spread = bounding radius of
 *                  those children — one mid-range cluster card can cover the
 *                  same volume as all fine children.
 * Tier 2 (coarse): One per main branch near the tip. Points to medium children.
 */
static _emitHierarchicalAnchors(rng, allAnchors, mainBranches, cfg) {
    // ─── TIER 0: FINE ──────────────────────────────────────────────
    for (const main of mainBranches) {
        for (const twig of main.twigInfos) {
            twig._fineStart = allAnchors.length;
    
            // Per-twig spacing — see comment in _emitBirchTwigs.
            const spacing = twig.fineAnchorSpacing ?? cfg.fineAnchorSpacing;
    
            for (const drooper of twig.drooperInfos) {
                this._emitFineAnchorsOnPolyline(rng, allAnchors, drooper.points, spacing, cfg);
                if (drooper.fork) {
                    this._emitFineAnchorsOnPolyline(rng, allAnchors, drooper.fork.points, spacing, cfg);
                }
            }
    
            twig._fineCount = allAnchors.length - twig._fineStart;
        }
    }
    const fineTotal = allAnchors.length;

    // ─── TIER 1: MEDIUM ────────────────────────────────────────────
    for (const main of mainBranches) {
        main._mediumStart = allAnchors.length;

        for (const twig of main.twigInfos) {
            // Bounding radius: max distance from this anchor to any fine child.
            let maxDist = 0.02;  // floor
            for (let i = twig._fineStart; i < twig._fineStart + twig._fineCount; i++) {
                const d = v3Length(v3Sub(allAnchors[i].position, twig.attachPos));
                if (d > maxDist) maxDist = d;
            }

            allAnchors.push({
                position:   twig.attachPos.slice(),
                direction:  twig.attachDir.slice(),
                spread:     maxDist * 1.15,  // pad for leaf card overhang
                density:    1.0,
                tier:       1,
                childStart: twig._fineCount > 0 ? twig._fineStart : 0xFFFFFFFF,
                childCount: twig._fineCount,
                parentIdx:  0xFFFFFFFF, 
            });
        }

        main._mediumCount = allAnchors.length - main._mediumStart;
    }
    const mediumTotal = allAnchors.length - fineTotal;

    // ─── TIER 2: COARSE ────────────────────────────────────────────
    for (const main of mainBranches) {
        const mp = main.points;
        const tipT = 0.85;
        const tipFrac = tipT * (mp.length - 1);
        const tipIdx = Math.min(Math.floor(tipFrac), mp.length - 2);
        const coarsePos = v3Lerp(mp[tipIdx], mp[tipIdx + 1], tipFrac - tipIdx);
        const coarseDir = v3Normalize(v3Sub(mp[tipIdx + 1], mp[tipIdx]));

        let maxDist = 0.04;
        for (let i = main._mediumStart; i < main._mediumStart + main._mediumCount; i++) {
            const d = v3Length(v3Sub(allAnchors[i].position, coarsePos));
            if (d > maxDist) maxDist = d;
        }

        allAnchors.push({
            position:   coarsePos,
            direction:  coarseDir,
            spread:     maxDist * 1.20,
            density:    1.0,
            tier:       2,
            childStart: main._mediumCount > 0 ? main._mediumStart : 0xFFFFFFFF,
            childCount: main._mediumCount,
            parentIdx:  0xFFFFFFFF, 
        });
    }
    const coarseTotal = allAnchors.length - fineTotal - mediumTotal;
    

    for (let m = fineTotal; m < fineTotal + mediumTotal; m++) {
        const med = allAnchors[m];
        if (med.childStart === 0xFFFFFFFF) continue;
        for (let c = med.childStart; c < med.childStart + med.childCount; c++) {
            allAnchors[c].parentIdx = m;
        }
    }
    for (let k = fineTotal + mediumTotal; k < allAnchors.length; k++) {
        const coarse = allAnchors[k];
        if (coarse.childStart === 0xFFFFFFFF) continue;
        for (let c = coarse.childStart; c < coarse.childStart + coarse.childCount; c++) {
            allAnchors[c].parentIdx = k;
        }
    }

    const bands = { lower: 0, mid: 0, upper: 0 };
    for (const main of mainBranches) {
        let twigFineTotal = 0;
        for (const twig of main.twigInfos) {
            twigFineTotal += twig._fineCount;
        }
        if      (main.crownProgress < 0.40) bands.lower += twigFineTotal;
        else if (main.crownProgress < 0.70) bands.mid   += twigFineTotal;
        else                                 bands.upper += twigFineTotal;
    }

    return {
        fine: fineTotal,
        medium: mediumTotal,
        coarse: coarseTotal,
        fineByBand: bands,
    };
}
static _emitFineAnchorsOnPolyline(rng, allAnchors, points, spacing, cfg) {
    if (!points || points.length < 2) return;

    const cumLen = this._cumulativeArcLength(points);
    const total = cumLen[cumLen.length - 1];
    if (total < 1e-5) return;

    const count = Math.max(
        cfg.fineAnchorMinPerDrooper,
        Math.round(total / spacing)
    );

    for (let a = 0; a < count; a++) {
        const arcLen = ((a + 0.5) / count) * total;
        const sample = this._sampleAtArcLength(points, cumLen, arcLen);

        allAnchors.push({
            position:  sample.position.slice(),
            direction: v3Normalize([
                sample.direction[0] + rng.range(-0.10, 0.10),
                sample.direction[1] + rng.range(-0.08, 0.06),
                sample.direction[2] + rng.range(-0.10, 0.10),
            ]),
            spread:  rng.range(0.018, 0.040),
            // REPURPOSED: for birch fine anchors, density = arc-length
            // (template-local) from this anchor to the drooper tip.
            // The scatter shader uses it to clamp card height so leaves
            // near the tip don't extend past the geometry. Other species
            // and other tiers still treat this as the legacy 0-1 density
            // multiplier, which the shader currently ignores.
            density: total - arcLen,
            tier:       0,
            childStart: 0xFFFFFFFF,
            childCount: 0,
            // Patched by _emitHierarchicalAnchors post-pass. 0xFFFFFFFF
            // means "no parent known yet" — if it survives to the GPU,
            // the shader skips cross-tier collapse for this anchor.
            parentIdx: 0xFFFFFFFF,
        });
    }
}

  /**
 * Emit level-3 twigs off a main branch. Replaces _emitBirchTwigsClose.
 *
 * Three changes vs the old method:
 *
 *   1. chainId stamped on every segment (for gap-free mesh building).
 *
 *   2. RADIUS BUG FIX. The old emit used taper 0.80 + min 0.00070 for r0
 *      but taper 0.88 + min 0.00034 for r1. That made seg[i].endRadius ≠
 *      seg[i+1].startRadius — the tube wall stepped inward at every joint.
 *      This was half of the "broken twig" artifact at <1m. Now: one taper,
 *      one clamp, continuous radii.
 *
 *   3. No inline anchors, no spurs. Droopers (level 4) replace spurs and
 *      carry fine anchors. Anchors are emitted later in one hierarchical
 *      pass so parent→child indices can be set correctly.
 *
 * Returns twigInfos for the anchor pass.
 */
static _emitBirchTwigs(rng, allSegments, source, segIdStart, chainIdStart, options, cfg) {
    const points = source.points;
    if (!points || points.length < 2) {
        return { nextSegId: segIdStart, nextChainId: chainIdStart, twigInfos: [] };
    }

    const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));
    let segId = segIdStart;
    let chainId = chainIdStart;
    const twigInfos = [];

    const rawCount = rng.rangeInt(options.countMin ?? 4, options.countMax ?? 7);
    const twigCount = Math.max(1, Math.min(options.countCap ?? 7, rawCount));

    for (let tw = 0; tw < twigCount; tw++) {
        const twigSeed = (Math.floor(rng.next() * 0x100000000) ^ ((tw * 0x9E3779B9) >>> 0)) >>> 0;
        const twRng = new SeededRandom(twigSeed);

        const evenT = twigCount <= 1 ? 0.5 : (tw / (twigCount - 1));
        const tOnSrc = clamp(
            (options.tMin ?? 0.25) * (1.0 - evenT) + evenT + twRng.range(-0.08, 0.08),
            options.tMin ?? 0.25,
            1.0
        );

        const segFrac = tOnSrc * (points.length - 1);
        const segIdx = Math.min(Math.floor(segFrac), points.length - 2);
        const localT = segFrac - segIdx;
        const attachPos = v3Lerp(points[segIdx], points[segIdx + 1], localT);

        const segDir = v3Normalize(v3Sub(points[segIdx + 1], points[segIdx]));
        const outwardRaw = [segDir[0], 0, segDir[2]];
        const outwardLen = v3Length(outwardRaw);
        const outwardDir = outwardLen > 1e-6
            ? v3Scale(outwardRaw, 1.0 / outwardLen)
            : v3Perp(segDir);

        const outwardMix = twRng.range(options.outMin ?? 0.36, options.outMax ?? 0.72);
        const alongMix   = twRng.range(options.alongMin ?? 0.10, options.alongMax ?? 0.24);
        const drop       = twRng.range(options.dropMin ?? 0.06, options.dropMax ?? 0.20);
        const lift       = twRng.range(options.liftMin ?? 0.04, options.liftMax ?? 0.14);
        const twigDir = v3Normalize([
            outwardDir[0] * outwardMix + segDir[0] * alongMix,
            segDir[1] * 0.30 + lift - drop,
            outwardDir[2] * outwardMix + segDir[2] * alongMix,
        ]);

        const twigLength = twRng.range(options.lenMin ?? 0.05, options.lenMax ?? 0.15);
        const srcRAtT = source.startRadius * (1.0 - tOnSrc * (options.parentTaper ?? 0.74));
        const twigR = Math.max(0.00075, srcRAtT * twRng.range(options.radMin ?? 0.16, options.radMax ?? 0.32));
        const twigSegs = twRng.rangeInt(options.segMin ?? 6, options.segMax ?? 10);

        const down  = [0, -1, 0];
        const side  = v3Perp(twigDir);
        const side2 = v3Normalize(v3Cross(twigDir, side));
        const lateralAmp = twigLength * twRng.range(0.10, 0.22);
        const wobbleAmp  = twigLength * twRng.range(0.015, 0.045);
        const wobbleFreq = twRng.range(1.6, 3.8);
        const wobblePhase = twRng.range(0, Math.PI * 2);

        const p0 = attachPos.slice();
        let p1 = v3Add(p0, v3Add(v3Scale(twigDir, twigLength * 0.30), v3Scale(down, twigLength * 0.01)));
        let p2 = v3Add(p0, v3Add(v3Scale(twigDir, twigLength * 0.62), v3Scale(down, twigLength * 0.06)));
        let p3 = v3Add(p0, v3Add(v3Scale(twigDir, twigLength * 0.92), v3Scale(down, twigLength * 0.14)));

        const arcSign = twRng.next() < 0.5 ? -1.0 : 1.0;
        const arc = lateralAmp * twRng.range(0.55, 1.20);
        p1 = v3Add(p1, v3Add(v3Scale(side, arc * 0.55 * arcSign), v3Scale(side2, lateralAmp * twRng.range(-0.25, 0.25))));
        p2 = v3Add(p2, v3Add(v3Scale(side, arc * 1.00 * arcSign), v3Scale(side2, lateralAmp * twRng.range(-0.35, 0.35))));
        p3 = v3Add(p3, v3Add(v3Scale(side, arc * 0.72 * arcSign), v3Scale(side2, lateralAmp * twRng.range(-0.25, 0.25))));

        const twigPoints = [];
        for (let ts = 0; ts <= twigSegs; ts++) {
            const t = ts / twigSegs;
            let pos = v3Bezier(p0, p1, p2, p3, t);
            const wobbleScale = Math.sin(Math.PI * t);
            const wobble  = Math.sin(t * Math.PI * 2 * wobbleFreq + wobblePhase)       * wobbleAmp * wobbleScale;
            const wobble2 = Math.cos(t * Math.PI * 2 * wobbleFreq + wobblePhase * 0.67) * wobbleAmp * 0.62 * wobbleScale;
            pos = v3Add(pos, v3Add(v3Scale(side, wobble), v3Scale(side2, wobble2)));
            twigPoints.push(pos);
        }

        // ─── Segment emission: RADIUS FIX ────────────────────────────
        // One taper coefficient, one clamp. r0(t1) == r1(t0) at every joint.
        const twigTaper = 0.88;
        const twigMinR  = 0.00034;
        const twigChainId = chainId++;
        const twigSegIds = [];

        for (let ts = 0; ts < twigSegs; ts++) {
            const t0 = ts / twigSegs;
            const t1 = (ts + 1) / twigSegs;
            const r0 = Math.max(twigMinR, twigR * (1.0 - t0 * twigTaper));
            const r1 = Math.max(twigMinR, twigR * (1.0 - t1 * twigTaper));

            allSegments.push({
                id: segId++,
                start: twigPoints[ts].slice(),
                end:   twigPoints[ts + 1].slice(),
                startRadius: r0,
                endRadius:   r1,
                level: 3,
                parentId: twigSegIds.length > 0
                    ? twigSegIds[twigSegIds.length - 1]
                    : source.segIds[Math.min(segIdx, source.segIds.length - 1)],
                chainId: twigChainId,
            });
            twigSegIds.push(segId - 1);
        }

        // ─── Droopers off this twig ─────────────────────────────────
        const twigCumLen = this._cumulativeArcLength(twigPoints);
        const drooperResult = this._emitBirchDroopers(twRng, allSegments, {
            points: twigPoints,
            segIds: twigSegIds,
            cumLen: twigCumLen,
            startRadius: twigR,
        }, segId, chainId, cfg);
        segId   = drooperResult.nextSegId;
        chainId = drooperResult.nextChainId;

        let totalDrooperArc = 0;
for (const dr of drooperResult.drooperInfos) {
    const cL = this._cumulativeArcLength(dr.points);
    totalDrooperArc += cL[cL.length - 1];
    if (dr.fork) {
        const fL = this._cumulativeArcLength(dr.fork.points);
        totalDrooperArc += fL[fL.length - 1];
    }
}

const naturalCount = totalDrooperArc / cfg.fineAnchorSpacing;
const twigAnchorSpacing = naturalCount >= cfg.fineAnchorMinPerTwig
    ? cfg.fineAnchorSpacing
    : Math.max(1e-4, totalDrooperArc / cfg.fineAnchorMinPerTwig);

twigInfos.push({
    attachPos,
    attachDir: twigDir,
    drooperInfos: drooperResult.drooperInfos,
    fineAnchorSpacing: twigAnchorSpacing, 
});
/*
        twigInfos.push({
            attachPos,
            attachDir: twigDir,
            drooperInfos: drooperResult.drooperInfos,
        });*/
    }

    return { nextSegId: segId, nextChainId: chainId, twigInfos };
}

    /**
     * Generate a full branch hierarchy for a birch tree.
     *
     * Birch growth characteristics:
     * - Slender, gently curved white trunk
     * - Primary branches grow upward and outward at 30-60° from trunk
     * - As branches extend, gravity pulls tips downward (arch shape)
     * - Secondary branches continue outward+downward from the arch
     * - Tertiary twigs hang nearly vertically — birch "curtain" effect
     * - Crown is open and airy, widest at 60-70% height
     *
     * @param {number} seed
     * @param {object} [params]
     * @returns {{
     *   segments: BranchSegment[],
     *   anchors: AnchorPoint[],
     *   trunkPath: TrunkPathNode[],
     *   stats: object
     * }}
     */
    static _sampleTrunkPath(trunkPath, t, height) {
        const targetY = t * height;
        for (let i = 0; i < trunkPath.length - 1; i++) {
            const y0 = trunkPath[i].position[1];
            const y1 = trunkPath[i + 1].position[1];
            if (targetY >= y0 && targetY <= y1) {
                const lt = (y1 - y0) > 1e-8 ? (targetY - y0) / (y1 - y0) : 0;
                return v3Lerp(trunkPath[i].position, trunkPath[i + 1].position, lt);
            }
        }
        return trunkPath[trunkPath.length - 1].position.slice();
    }

    static _sampleTrunkRadius(trunkPath, t, height) {
        const targetY = t * height;
        for (let i = 0; i < trunkPath.length - 1; i++) {
            const y0 = trunkPath[i].position[1];
            const y1 = trunkPath[i + 1].position[1];
            if (targetY >= y0 && targetY <= y1) {
                const lt = (y1 - y0) > 1e-8 ? (targetY - y0) / (y1 - y0) : 0;
                return trunkPath[i].radius + (trunkPath[i + 1].radius - trunkPath[i].radius) * lt;
            }
        }
        return trunkPath[trunkPath.length - 1].radius;
    }

    static _sampleTrunkDirection(trunkPath, t, height) {
        const targetY = t * height;
        for (let i = 0; i < trunkPath.length - 1; i++) {
            const y0 = trunkPath[i].position[1];
            const y1 = trunkPath[i + 1].position[1];
            if (targetY >= y0 && targetY <= y1) {
                const lt = (y1 - y0) > 1e-8 ? (targetY - y0) / (y1 - y0) : 0;
                return v3Normalize(
                    v3Lerp(trunkPath[i].direction, trunkPath[i + 1].direction, lt)
                );
            }
        }
        return trunkPath[trunkPath.length - 1].direction.slice();
    }
}
