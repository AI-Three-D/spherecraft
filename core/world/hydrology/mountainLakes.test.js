import { describe, expect, it } from 'vitest';
import { MOUNTAIN_LAKE_DEFAULTS, chooseMountainLakes, continueDrain, drainFrame, findPockets, pocketSolveFrame } from './mountainLakes.js';
import { tangentBasis, dirToPlane, planeToDir } from './lakeRefine.js';
import { RIVER_SHAPE_DEFAULTS, riverReachShape } from './riverRefine.js';

const R = 131072;
const frameAt = (nx, ny, spacing) => ({ c: [0, 0, 1], ...tangentBasis([0, 0, 1]), x0: -nx * spacing / 2, y0: -ny * spacing / 2, spacing, nx, ny });
// A slope falling to +x with bowls; heights in metres on the patch grid.
function patch(nx, ny, spacing, bowls, slope = 0.05) {
    const h = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const x = (i - nx / 2) * spacing, y = (j - ny / 2) * spacing;
        let v = 1000 - slope * x;
        for (const b of bowls) { const r2 = ((x - b.x) ** 2 + (y - b.y) ** 2) / (b.r * b.r); if (r2 < 1) v -= b.depth * (1 - r2) ** 2; }
        h[j * nx + i] = v;
    }
    return h;
}

describe('mountain lakes', () => {
    it('finds closed pockets with their level, area, setting and outflow drop', () => {
        const S = 32, nx = 160, ny = 160, frame = frameAt(nx, ny, S);
        const h = patch(nx, ny, S, [{ x: -600, y: 0, r: 400, depth: 40 }, { x: 900, y: 600, r: 120, depth: 1 }]);
        const pockets = findPockets({ heights: h, frame, R, seaLevelM: 0, P: MOUNTAIN_LAKE_DEFAULTS });
        expect(pockets.length).toBe(1);   // the shallow bowl holds less than 3 m
        const p = pockets[0];
        expect(p.depth).toBeGreaterThan(20);
        expect(p.areaKm2).toBeGreaterThan(0.1);
        expect(p.areaKm2).toBeLessThan(Math.PI * 0.16);
        // On a 5 % slope the outflow falls ~0.05 m per m over 1.5 km.
        expect(p.outflowDropM).toBeGreaterThan(40);
        const [x] = dirToPlane(p.dir, frame, R);
        // The slope moves the deepest point ~50 m downhill of the bowl centre.
        expect(Math.abs(x + 600)).toBeLessThan(100);
        // Its drainage: from beside the sill down the slope to the patch
        // border, every pathStepM, never above the level.
        expect(p.path.length).toBe(p.pathH.length);
        const xs = p.path.map(d => dirToPlane(d, frame, R)[0]);
        const [sx, sy] = dirToPlane(p.sill, frame, R), [px, py] = dirToPlane(p.path[0], frame, R);
        expect(sx).toBeGreaterThan(x);
        expect(Math.hypot(px - sx, py - sy)).toBeLessThan(1.5 * S);
        expect(xs.at(-1)).toBeGreaterThan(frame.x0 + (nx - 1) * S);
        // Down the fall line (+x) beyond the rim; the last point is the border cell.
        const ys = p.path.map(d => dirToPlane(d, frame, R)[1]);
        for (let k = 3; k < xs.length - 1; k++) {
            expect(xs[k] - xs[k - 1]).toBeCloseTo(MOUNTAIN_LAKE_DEFAULTS.pathStepM, 6);
            expect(ys[k]).toBe(ys[k - 1]);
        }
        for (const v of p.pathH) expect(v).toBeLessThan(p.level);
        expect(p.pathH.at(-1)).toBeLessThan(p.pathH[0] - 50);
    });

    it('reports the hollows its drainage crosses, with their level and place on the path', () => {
        const S = 32, nx = 160, ny = 160, frame = frameAt(nx, ny, S);
        // A second, closed hollow down the slope (centre x = 700 m).
        const h = patch(nx, ny, S, [{ x: -600, y: 0, r: 400, depth: 40 }, { x: 700, y: 0, r: 250, depth: 40 }]);
        const pockets = findPockets({ heights: h, frame, R, seaLevelM: 0, P: MOUNTAIN_LAKE_DEFAULTS });
        const up = pockets.find(p => dirToPlane(p.dir, frame, R)[0] < 0);
        // Filled cells at the pocket's own level are its water, not a pond.
        const below = up.pits.filter(t => t.level < up.level - 0.5);
        expect(below.length).toBe(1);
        const pit = below[0], [px] = dirToPlane(pit.dir, frame, R);
        expect(Math.abs(px - 700)).toBeLessThan(150);
        expect(pit.depth).toBeGreaterThan(5);
        expect(pit.level).toBeLessThan(up.level);
        // Its spill level is the ground where the path leaves it.
        const xs = up.path.map(d => dirToPlane(d, frame, R)[0]);
        expect(xs[pit.entry]).toBeLessThan(px);
        expect(xs[pit.exit]).toBeGreaterThan(px);
        expect(Math.abs(up.pathH[pit.exit] - pit.level)).toBeLessThan(5);
    });

    it('continues a drainage that left its patch on a patch ahead of its end', () => {
        const S = 32, frame0 = frameAt(160, 160, S), P = MOUNTAIN_LAKE_DEFAULTS;
        // The last two points of a path leaving frame0's east border.
        const end = planeToDir(2544, 16, frame0, R), prev = planeToDir(2416, 16, frame0, R);
        const f = drainFrame(end, prev, R, P);
        const [cx, cy] = dirToPlane(f.c, frame0, R);
        expect(Math.abs(cx - 2544 - (P.drainPatchM / 2 - 500))).toBeLessThan(5);
        expect(Math.abs(cy - 16)).toBeLessThan(5);
        // The same plain slope, falling to +x of frame0.
        const h = new Float32Array(f.nx * f.ny);
        for (let j = 0; j < f.ny; j++) for (let i = 0; i < f.nx; i++) {
            const [x] = dirToPlane(planeToDir(f.x0 + (i + 0.5) * f.spacing, f.y0 + (j + 0.5) * f.spacing, f, R), frame0, R);
            h[j * f.nx + i] = 1000 - 0.05 * x;
        }
        const { path, pathH } = continueDrain({ heights: h, frame: f, R, start: end, P });
        const pts = path.map(d => dirToPlane(d, frame0, R));
        // From one step past the end down the slope to the patch's far edge.
        expect(Math.abs(pts[0][0] - 2544 - P.pathStepM)).toBeLessThan(f.spacing);
        expect(pts.at(-1)[0]).toBeGreaterThan(2544 + P.drainPatchM - 500 - 2 * f.spacing);
        for (const [, y] of pts) expect(Math.abs(y - 16)).toBeLessThan(f.spacing);
        for (let k = 1; k < pathH.length; k++) expect(pathH[k]).toBeLessThan(pathH[k - 1]);
    });

    it("a stream's ends flare at most 1.25x over a short length", () => {
        const P = { ...RIVER_SHAPE_DEFAULTS, ...MOUNTAIN_LAKE_DEFAULTS.streamShape, reachWidthVar: 0 };
        const at = (s) => riverReachShape({ width: 8, depth: 0.8 }, s, 900, 3, P).width;
        expect(at(0)).toBeCloseTo(10, 6);
        expect(at(900)).toBeCloseTo(10, 6);
        expect(at(40)).toBeCloseTo(8, 6);
        expect(at(450)).toBeCloseTo(8, 6);
    });

    it('chooses pockets in a mountain setting with a steep outflow, larger first, spaced apart', () => {
        const at = (xKm) => { const a = xKm * 1000 / R; return [Math.sin(a), 0, Math.cos(a)]; };
        const pk = (xKm, areaKm2, enclosureM = 40, outflowDropM = 40) => ({ dir: at(xKm), areaKm2, enclosureM, outflowDropM });
        const P = { ...MOUNTAIN_LAKE_DEFAULTS, minSpacingM: 800 };
        const picks = chooseMountainLakes([pk(0, 0.2), pk(0.5, 0.5), pk(3, 0.1), pk(6, 0.3, 5), pk(9, 0.3, 40, 5), pk(12, 0.01)], R, P);
        // 0.5 km^2 at 0.5 km wins over 0.2 km^2 at 0 (too close); flat or sluggish or tiny ones are out.
        expect(picks.map(p => Math.round(Math.asin(p.dir[0]) * R / 100) / 10)).toEqual([0.5, 3]);
    });

    it('solves a pocket on a patch covering its bounding box and margin', () => {
        const S = 64, frame = frameAt(80, 80, S);
        const h = patch(80, 80, S, [{ x: 0, y: 0, r: 500, depth: 30 }]);
        const [p] = findPockets({ heights: h, frame, R, seaLevelM: 0, P: MOUNTAIN_LAKE_DEFAULTS });
        const f = pocketSolveFrame(p, R, MOUNTAIN_LAKE_DEFAULTS);
        expect(f.spacing).toBe(32);
        for (const d of p.corners) {
            const [x, y] = dirToPlane(d, f, R);
            expect(x - f.x0).toBeGreaterThan(MOUNTAIN_LAKE_DEFAULTS.solveMarginM);
            expect(f.x0 + f.nx * f.spacing - x).toBeGreaterThan(MOUNTAIN_LAKE_DEFAULTS.solveMarginM);
            expect(y - f.y0).toBeGreaterThan(MOUNTAIN_LAKE_DEFAULTS.solveMarginM);
        }
    });
});
