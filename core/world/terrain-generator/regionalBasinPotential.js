// A two-dimensional landform potential, baked once into regional controls.
// Noise affects the interior as well as the boundary, so natural high ground
// can remain as peninsulas/islands. Water still comes from the common hull
// and connectivity planner; this potential is not a containment certificate.
const smooth = t => {
    t = Math.max(0, Math.min(1, t));
    return t * t * t * (t * (t * 6 - 15) + 10);
};
const hash = (x, y, seed) => {
    let h = (Math.imul(x, 0x632be5ab) ^ Math.imul(y, 0x85157af5) ^ seed) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    return ((h ^ (h >>> 16)) >>> 0) / 2147483648 - 1;
};
function noise(x, y, seed) {
    const i = Math.floor(x), j = Math.floor(y), u = smooth(x - i), v = smooth(y - j);
    const a = hash(i, j, seed), b = hash(i + 1, j, seed);
    const c = hash(i, j + 1, seed), d = hash(i + 1, j + 1, seed);
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

export function createRegionalBasinPotential({radiusM, seed, version='current'}) {
    if (!['current', 'previous'].includes(version)) throw new Error('Invalid regional basin potential version');
    // Scales are spatial distances, not angular waves around an outline.
    // The finest octave supplies bank-scale structure in this prototype;
    // sub-control shoreline detail still belongs to fine terrain generation.
    const scales = [[radiusM * .65, .90], [radiusM * .25, .42],
        [radiusM * .09, .18], [Math.max(20, radiusM * .035), .07]];
    const angle=seed*2.3999632297,c=Math.cos(angle),s=Math.sin(angle),aspect=.65+((seed*31)%997)/997*.6;
    return (px, py) => {
        // Keep the accepted original prototype available for screenshots.
        // Its unwarped coordinates reproduce the archived potential exactly.
        let x=px,y=py;
        if(version==='current') {
            x=(c*px+s*py)*aspect;y=(-s*px+c*py)/aspect;
            x+=radiusM*.22*noise(x/(radiusM*.8),y/(radiusM*.8),seed+2301);
            y+=radiusM*.22*noise(x/(radiusM*.8),y/(radiusM*.8),seed+3109);
        }
        const r = Math.hypot(x, y) / radiusM;
        if (Math.hypot(px,py)/radiusM >= 1.4) return 0;
        let potential = 1 - r * r;
        for (let k = 0; k < scales.length; k++) {
            const [scale, amount] = scales[k];
            potential += amount * noise(x / scale + 13.7, y / scale - 7.3, seed + k * 4099);
        }
        // A compact interior anchor prevents a failed candidate caused only
        // by the feature's own noise. The common planner checks the final
        // terrain and substantial connected area, including any islands.
        const core = smooth((.28 - Math.hypot(px,py)/radiusM) / .12);
        return Math.max(core, smooth(potential / .45)) * smooth((1.4 - Math.hypot(px,py)/radiusM) / .18);
    };
}
