import { add3, cross3, dot3, length3, normalize3, scale3, sub3 } from '../../../shared/math/Vector3.js';
import { normalizeTectonicRelief } from '../../../core/world/terrain-generator/tectonicReliefConfig.js';

// A jittered spherical distribution keeps the smallest plates from
// collapsing into the same location. Spin vectors are independent.
function plateVectors(count, seed) {
    let state = (seed ^ 0xa399d82d) >>> 0;
    const random = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const phase = random() * 2 * Math.PI;
    const sites = [];
    const spins = [];
    const jitter = 0.54 / Math.sqrt(count);
    for (let i = 0; i < count; i++) {
        const y = 1 - 2 * (i + 0.5) / count;
        const r = Math.sqrt(1 - y * y);
        const angle = i * goldenAngle + phase;
        const centre = [Math.cos(angle) * r, y, Math.sin(angle) * r]
            .map(component => component + (2 * random() - 1) * jitter);
        sites.push(normalize3(centre));
        spins.push(Array.from({ length: 3 }, () => 2 * random() - 1));
    }
    return { sites, spins };
}

// Each shared plate edge lies on the great circle equidistant from its
// two sites. Its corners are shared with a third site. Build those finite
// arcs once so every terrain sample only evaluates actual uplift belts.
function convergentContacts(sites, spins) {
    const contacts = [];
    for (let i = 0; i < sites.length; i++) {
        for (let j = i + 1; j < sites.length; j++) {
            const normal = normalize3(sub3(sites[j], sites[i]));
            const corners = [];
            for (let k = 0; k < sites.length; k++) {
                if (k === i || k === j) continue;
                const axis = cross3(normal, sub3(sites[k], sites[i]));
                if (length3(axis) < 1e-8) continue;
                const intersection = normalize3(axis);
                for (const corner of [intersection, scale3(intersection, -1)]) {
                    const score = dot3(corner, sites[i]);
                    if (sites.every(site => dot3(corner, site) <= score + 1e-8)) corners.push(corner);
                }
            }
            if (corners.length !== 2) continue;
            const [start, end] = corners;
            const center = normalize3(add3(start, end));
            const motion = cross3(sub3(spins[i], spins[j]), center);
            const closing = Math.min(1, Math.max(0, (dot3(motion, normal) - 0.04) / 0.80));
            if (closing <= 0) continue;
            const axis = normalize3(sub3(end, start));
            const strength = closing * closing * (3 - 2 * closing);
            contacts.push({ center, normal, axis, halfSpan: dot3(end, axis), strength });
        }
    }
    return contacts;
}

function createPlateContactWgsl(contacts) {
    if (contacts.length === 0) {
        return 'fn tectonicConvergence_d(dir: vec3<f32>) -> vec4<f32> { return dConst(0.0); }';
    }
    const vector = values => `vec3<f32>(${values.map(value => value.toFixed(8)).join(', ')})`;
    const entries = contacts.map(({ center, normal, axis, halfSpan, strength }) =>
        `PlateContact(${vector(center)}, ${vector(normal)}, ${vector(axis)}, ${halfSpan.toFixed(8)}, ${strength.toFixed(8)})`);
    return `
struct PlateContact {
    center: vec3<f32>,
    normal: vec3<f32>,
    axis: vec3<f32>,
    halfSpan: f32,
    strength: f32,
}

const PLATE_CONTACT_COUNT = ${contacts.length}u;
const PLATE_CONTACTS = array<PlateContact, PLATE_CONTACT_COUNT>(
    ${entries.join(',\n    ')}
);

fn tectonicConvergence_d(dir: vec3<f32>) -> vec4<f32> {
    var compression = dConst(0.0);
    for (var i = 0u; i < PLATE_CONTACT_COUNT; i++) {
        let edge = PLATE_CONTACTS[i];
        if (dot(dir, edge.center) <= 0.0) { continue; }
        let crossTrack = dot(dir, edge.normal);
        let t = dot(dir, edge.axis);
        let width = mix(0.090, 0.152, edge.strength);
        if (abs(crossTrack) >= width + 0.005 || abs(t) >= edge.halfSpan + 0.055) { continue; }
        let across = dSmoothAbs(vec4<f32>(crossTrack, edge.normal), 0.005);
        let along = dSmoothAbs(vec4<f32>(t, edge.axis), 0.005);
        let belt = dConst(1.0) - dSmoothstep(0.006, width, across);
        let ends = dConst(1.0) - dSmoothstep(edge.halfSpan * 0.82, edge.halfSpan + 0.05, along);
        compression += dMul(dMul(belt, ends), dConst(1.0) - compression) * edge.strength;
    }
    return compression;
}
`;
}

export function createTectonicReliefWgsl(options, seed = 0) {
    const config = normalizeTectonicRelief(options);
    if (!config.enabled) return '';
    const { plateCount, mountainReliefM, interiorReliefM, lowlandReliefM, coastalReliefM } = config;
    const { sites, spins } = plateVectors(plateCount, seed);
    return `
${createPlateContactWgsl(convergentContacts(sites, spins))}

struct TectonicRelief {
    upland: vec4<f32>,
    mountains: vec4<f32>,
    localHills: vec4<f32>,
    ${lowlandReliefM > 0 ? 'lowland: vec4<f32>,' : ''}
}

fn tectonicRelief_d(dir: vec3<f32>, seed: i32, landMask: vec4<f32>, existingPeaks: vec4<f32>, regionCoord: vec4<f32>) -> TectonicRelief {
    var out: TectonicRelief;
    let inland = dSmoothstep(0.47, 0.78, landMask);
    if (inland.x <= 0.0) { return out; }
    let maxH = maxTerrainHeightM();

    // Country between the belts alternates between open valleys, rounded
    // hills and more dissected uplands at overlapping scales.
    let province = fbmAuto_d(dir, 43.0, 2, seed + 28071, 2.0, 0.5);
    let hills = fbmAuto_d(dir, 14.0, 2, seed + 28109, 2.0, 0.5);
    let spurs = fbmAuto_d(dir, 4.0, 2, seed + 28141, 2.0, 0.5);
    let rounded = dSmoothstep(-0.55, 0.52, hills * 0.75 + spurs * 0.25);
    let valley = dSmoothAbs(hills + spurs * 0.34, 0.055);
    let dissected = dSmoothstep(0.05, 0.63, valley);
    let uplandStyle = dSmoothstep(-0.27, 0.33, province);
    let rolling = dMix(rounded * 0.56, rounded * 0.42 + dissected * 0.58, uplandStyle);
    let upland = dMul(rolling, dConst(0.35) + uplandStyle * 0.65);
    out.upland = dMul(inland, upland) * (${interiorReliefM.toFixed(4)} / maxH);

    // Bend the plate boundaries and break convergent margins into broad
    // foothills, high massifs and saddles along the same belt.
    let warp = makeWarpedDir(dir,
        fbmAuto_d(dir, 36.0, 2, seed + 28201, 2.0, 0.5),
        fbmAuto_d(dir, 44.0, 2, seed + 28237, 2.0, 0.5),
        fbmAuto_d(dir, 52.0, 2, seed + 28279, 2.0, 0.5), 0.108);
    let warped = tectonicConvergence_d(warp.d);
    let compression = vec4<f32>(warped.x, pullbackWarp(warp, warped.yzw));
    if (compression.x > 0.035) {
        let apron = dSmoothstep(0.035, 0.48, compression);
        let core = dSmoothstep(0.19, 0.84, compression);
        let arc = fbmAuto_d(dir, 24.0, 2, seed + 28301, 2.0, 0.5);
        let massif = fbmAuto_d(dir, 7.8, 3, seed + 28319, 2.0, 0.53);
        let peak = dSmoothstep(-0.39, 0.56, massif + arc * 0.65);
        let arcHeight = dSmoothstep(-0.36, 0.30, arc);
        let ridges = dMul(core, dMul(dConst(0.16) + dMul(peak, peak) * 0.84, dConst(0.24) + arcHeight * 0.76));
        let apronHeight = dMul(apron, dConst(0.08) + rounded * 0.17);
        let peakBlend = dConst(1.0) - dSmoothstep(500.0, 3500.0, existingPeaks * maxH) * 0.52;
        ${coastalReliefM > 0 ? `
        // Carry convergent belts toward the shoreline, using the same
        // shoulders, saddles and massifs as the rest of the range.
        let coastalUplift = dMul(dSmoothstep(0.47, 0.61, landMask),
            dConst(1.0) - dSmoothstep(0.74, 0.93, landMask)) * ${coastalReliefM.toFixed(4)};
        let uplift = inland * ${mountainReliefM.toFixed(4)} + coastalUplift;
        out.mountains = dMul(dMul(uplift, peakBlend), apronHeight + ridges) * (1.0 / maxH);
        ` : `
        out.mountains = dMul(dMul(inland, peakBlend), apronHeight + ridges) * (${mountainReliefM.toFixed(4)} / maxH);
        `}
    }

    // Kilometre-scale knolls break up the slopes between the broader hills.
    // Open valley floors and steep alpine ground get a lighter treatment.
    let openCountry = dConst(1.0) - dSmoothstep(340.0, 1350.0, (existingPeaks + out.mountains) * maxH);
    ${lowlandReliefM > 0 ? `
    // Raise the shoulders of the existing upland field. Leave its lowest
    // ground open for drainage and fade out before the first highland climb.
    let plain = dConst(1.0) - dSmoothstep(0.85, REGION_HIGHLAND_START, regionCoord);
    let lowlandWeight = dMul(dMul(inland, plain), openCountry);
    let shoulders = dSmoothstep(0.10, 0.42, upland);
    let hillCountry = dMul(lowlandWeight, shoulders);
    out.lowland = hillCountry * (${lowlandReliefM.toFixed(4)} / maxH);
    ` : ''}
    let hillCover = dMul(openCountry, dSmoothstep(-0.30, 0.26, hills + spurs * 0.32));
    if (hillCover.x > 0.0${lowlandReliefM > 0 ? ' || hillCountry.x > 0.0' : ''}) {
        let knolls = fbmAuto_d(dir, 1.65, 2, seed + 28381, 2.1, 0.48);
        let shapes = dSmoothstep(-0.45, 0.52, knolls);
        out.localHills = dMul(dMul(inland, hillCover), dMul(shapes, shapes)) * (${(interiorReliefM * 0.21).toFixed(4)} / maxH);
        ${lowlandReliefM > 0 ? `
        // Shorter undulations share the existing knoll field and taper
        // with the broad shoulders before reaching the valley floor.
        out.localHills += dMul(hillCountry, shapes) * (${(lowlandReliefM * 0.43).toFixed(4)} / maxH);
        ` : ''}
    }
    return out;
}
`;
}
