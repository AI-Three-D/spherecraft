// templates/configs/riverConfig.js
//
// Walking-skeleton river/shallow-water config: a single hardcoded demo patch,
// no JSON authoring yet (that's a later increment). Grid/sim constants are
// carried over from whitewater's "medium" quality tier.

export const DEFAULT_RIVER_CONFIG = {
    grid: { W: 128, L: 128, dx: 1.0 },

    sim: {
        dt: 1 / 120,
        substeps: 2,
        g: 9.81,
        manning: 0.035,
        hmin: 0.02,
        umax: 12.0,
        maxRise: 3.0,
        maxFall: 3.0,
        turbA: 0.6,
        turbL: 3.0,
        turbT: 0.8,
        foamDecay: 0.35,
        kDecay: 0.8,
        macCormack: 1,
        kGen: 1.0,
        foamGen: 1.0,
    },

    // Continuous edge inflow (whitewater's momentum() j<=1 Dirichlet rows).
    inflow: {
        edgeRowCount: 2,       // must match the shader's hardcoded `j <= 1`
        depthAboveMin: 0.6,
        inQ: 1.0,
        inVelScale: 0.5,
    },

    // Initial standing-water dump so the solver has something to react to
    // before the edge inflow has propagated downstream.
    initialFill: {
        startRow: 6,
        rowCount: 24,
        depthAboveMin: 0.5,
    },

    bake: {
        readyDelayFrames: 60,
        // Was 5 (~5-6s of real-world retrying): far too short. The bake is a
        // one-time cost (retries are cheap — one dispatch/readyDelayFrames
        // window until it succeeds), but tile streaming near a fresh spawn
        // point can easily take longer than 6s to make even the coarse
        // depth-0 fallback tile resident, especially competing with
        // everything else loading right after game start. Giving up early
        // permanently strands the patch on zeroed/placeholder bed data with
        // no future retry — confirmed as the real root cause of the water
        // rendering "underground" (see RIVER_WALKING_SKELETON_LOG.md,
        // Session 3). Bumped to a generous ~2 minutes of real-world retrying
        // as a safety net against a genuinely broken environment, not a
        // budget meant to be hit in normal play.
        maxRetries: 120,
        minValidFraction: 0.5,
    },

    render: {
        waveAmp: 0.06,
    },

    waterTint: [0.184, 0.435, 0.451],
    waterClarity: 1.0,
};
