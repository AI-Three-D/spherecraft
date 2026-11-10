// Contracts for the current earthLike stack, in metres relative to sea level.
// A sampled minimum is deliberately absent from these displacement budgets.

// Relief is nonnegative and also raises the erosion amount. Keep that
// coupling: min_r [r - A * mix(lowAmount, 1, smoothstep(start, full, r))].
// A is the worst style/variation allowance BEFORE the relief multiplier.
export function reliefErosionLowerBound({ allowanceM: a, lowAmount, startM, fullM }) {
    if (![a, lowAmount, startM, fullM].every(Number.isFinite) || a < 0 || lowAmount < 0 || startM < 0 || fullM <= startM) {
        throw new Error('Unsupported height contract: relief/erosion coupling');
    }
    const width = fullM - startM;
    const evaluate = r => {
        const t = Math.min(1, Math.max(0, (r - startM) / width));
        return r - a * (lowAmount + (1 - lowAmount) * t * t * (3 - 2 * t));
    };
    const candidates = [evaluate(0), evaluate(startM), evaluate(fullM)];
    const coefficient = a * (1 - lowAmount);
    if (coefficient > 0) {
        const discriminant = 1 - 4 * width / (6 * coefficient);
        if (discriminant >= 0) {
            const d = Math.sqrt(discriminant);
            candidates.push(evaluate(startM + width * (1 - d) / 2), evaluate(startM + width * (1 + d) / 2));
        }
    }
    return Math.min(...candidates);
}

export function terrainDisplacementBudgets({ erosionFilter: ef, microGain = 1, features = {} }) {
    const finite = (name, value, minimum = 0) => {
        if (!Number.isFinite(value) || value < minimum) throw new Error(`Unsupported height contract: ${name}`);
        return value;
    };
    finite('strength', ef.strength);
    finite('scale', ef.scale, Number.MIN_VALUE);
    finite('gain', ef.gain);
    finite('gullyWeight', ef.gullyWeight);
    finite('detail', ef.detail, Number.MIN_VALUE);
    finite('variationMin', ef.variationMin);
    finite('lowReliefAmount', ef.lowReliefAmount);
    finite('mesoKeep', ef.mesoKeep);
    if (!Number.isInteger(ef.octaves) || ef.octaves < 1 || ef.octaves > 8) throw new Error('Unsupported height contract: octaves');
    for (const value of ef.styleStrength) finite('styleStrength', value);
    for (const value of [...ef.rounding, ...ef.onset, ...ef.styleRidgeRounding, ...ef.styleCreaseRounding]) finite('erosion mask parameters', value);
    finite('lowAmountRounding', ef.lowAmountRounding);
    let octaveSum = 0, gain = 1;
    for (let i = 0; i < ef.octaves; i++) { octaveSum += gain; gain *= ef.gain; }
    const maxAmount = Math.max(1, ef.variationMin) * Math.max(1, ef.lowReliefAmount) * Math.max(...ef.styleStrength);
    // Phacelle's normalized cosine has magnitude <= 1. After cancelling
    // the initial fade target, q_i = (1-mask_i)q_(i-1) + mask_i*g*cos_i,
    // q_-1 = 0, so |q_i| <= g. No extra fade-target budget is required.
    const erosionM = ef.strength * ef.scale * maxAmount * ef.gullyWeight * octaveSum;
    const reliefErosionLowerM = reliefErosionLowerBound({
        allowanceM: ef.strength * ef.scale * Math.max(1, ef.variationMin) * Math.max(...ef.styleStrength) * ef.gullyWeight * octaveSum,
        lowAmount: ef.lowReliefAmount, startM: ef.reliefStartM, fullM: ef.reliefFullM,
    });
    const profileMicroGain = Math.min(5, finite('microGain', microGain));
    // The implemented Perlin gradient sums two signed coordinate components. Its corner
    // dot products are bounded by 2 and its fade interpolation is convex.
    // Positive, normalized FBM weights preserve that bound. Do not assume
    // the frequently quoted empirical [-1,1] range is a proven envelope.
    const noiseBound = 2;
    const mesoWeight = Math.max(1, Math.abs(1 - maxAmount * (1 - ef.mesoKeep)));
    const mesoM = features.meso2 === false ? 0 : 135 * noiseBound * profileMicroGain * mesoWeight;
    // Forest is the largest final micro budget: (.6+.3+.2+.12)*2*10.
    // Grass, sand (including dune-envelope overshoot) and generic are lower.
    const microM = features.microDetail === false ? 0 : 24.4 * profileMicroGain;
    return { erosionM, reliefErosionLowerM, mesoM, microM, lakeHollowM: features.lakeBasins === false ? 0 : 25,
        octaveSum, maxAmount, noiseBound, numericalAllowanceM: 1 };
}

export function softClampTerrainMeters(heightM, maxH) {
    let h = heightM / maxH;
    if (h > 1.55) h = 1.55 + 0.25 * Math.tanh((h - 1.55) / 0.25);
    if (h < -0.85) h = -0.85 - 0.25 * Math.tanh((-0.85 - h) / 0.25);
    return h * maxH;
}

export function naturalFinalLowerBound({ foundationMinM, oceanMinM, fullyLand, maxH, budgets }) {
    const land = foundationMinM + (budgets.reliefErosionLowerM ?? -budgets.erosionM) - budgets.mesoM - budgets.lakeHollowM;
    const mixed = fullyLand ? land : Math.min(land, oceanMinM);
    // There are TWO soft clamps: natural base and final tile micro height.
    return softClampTerrainMeters(softClampTerrainMeters(mixed, maxH) - budgets.microM, maxH)
        - budgets.numericalAllowanceM;
}
