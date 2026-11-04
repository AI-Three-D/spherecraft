/**
 * Terrain stand-in for the voxel-region harness. No engine imports: loads in Node and in the page.
 *
 * One height function feeds both ways a region gets heights:
 *   captureHeightfield() -> the descriptor handed over at region creation (1 m grid, Float32Array)
 *   queryHeights(xz)     -> Promise<Float32Array>, as the GPU query will behave
 *
 * Coordinates are frame-local: x along heading, z = cross(heading, up), heights along up,
 * all relative to the frame origin ~131 km from the planet centre.
 * The hill shape is fixed; the seed only drives the noise.
 */
function mix(a, b) {
    let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 1, 0xc2b2ae35);
    h = Math.imul(h ^ (h >>> 15), 0x27d4eb2d);
    return (h ^ (h >>> 13)) >>> 0;
}

function lattice(ix, iz, seed) {                       // [-1, 1]
    let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ seed;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff * 2 - 1;
}

const fade = t => t * t * t * (t * (t * 6 - 15) + 10);   // quintic, C2

function valueNoise(x, z, seed) {
    const x0 = Math.floor(x), z0 = Math.floor(z);
    const tx = fade(x - x0), tz = fade(z - z0);
    const a = lattice(x0, z0, seed), b = lattice(x0 + 1, z0, seed);
    const c = lattice(x0, z0 + 1, seed), d = lattice(x0 + 1, z0 + 1, seed);
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

const HILL = Object.freeze({ x: -70, z: 10, radiusX: 170, radiusZ: 230, height: 60 });
const OCTAVES = [
    { wavelength: 96, amplitude: 1.5, turn: 0.4 },
    { wavelength: 41, amplitude: 0.6, turn: 1.3 },
    { wavelength: 20, amplitude: 0.15, turn: 2.5 },
];
const VALLEY_NOISE = 0.35;                               // share of the noise that survives on the valley floor

/**
 * @param {Object} [options]
 * @param {number} [options.seed]
 * @param {number | [number, number]} [options.latencyMs] fixed delay, or a [min, max] jittered per call
 * @param {(run: () => void, callIndex: number) => void} [options.schedule] replaces the timer (tests)
 */
export function createTerrainFixture(options = {}) {
    const seed = (options.seed ?? 7) >>> 0;
    const latency = options.latencyMs ?? 0;
    const delay = call => (Array.isArray(latency)
        ? latency[0] + (latency[1] - latency[0]) * (mix(seed, call) / 4294967296)
        : latency);
    const schedule = options.schedule ?? ((run, call) => { setTimeout(run, delay(call)); });

    const octaves = OCTAVES.map((octave, i) => {
        const octaveSeed = mix(seed, i);
        return {
            ...octave,
            seed: octaveSeed,
            cos: Math.cos(octave.turn),
            sin: Math.sin(octave.turn),
            offsetX: mix(octaveSeed, 1) / 4294967296 * 512,
            offsetZ: mix(octaveSeed, 2) / 4294967296 * 512,
        };
    });

    const headingAngle = 0.6;                            // deliberately not axis-aligned
    const makeFrame = () => ({
        origin: { x: 0, y: 131072.337, z: 0 },
        up: { x: 0, y: 1, z: 0 },
        heading: { x: Math.cos(headingAngle), y: 0, z: Math.sin(headingAngle) },
    });

    /** Ground truth, metres along up at frame position (x, z). */
    function heightAt(x, z) {
        const d = Math.hypot((x - HILL.x) / HILL.radiusX, (z - HILL.z) / HILL.radiusZ);
        const mask = d >= 1 ? 0 : fade(1 - d);
        let noise = 0;
        for (const o of octaves) {
            const px = (x * o.cos + z * o.sin) / o.wavelength + o.offsetX;
            const pz = (z * o.cos - x * o.sin) / o.wavelength + o.offsetZ;
            noise += o.amplitude * valueNoise(px, pz, o.seed);
        }
        return HILL.height * mask + (VALLEY_NOISE + (1 - VALLEY_NOISE) * mask) * noise;
    }

    /** 257 samples per side = 256 m across at 1 m spacing. */
    function captureHeightfield({ cornerX = -128, cornerZ = -128, countX = 257, countZ = 257, spacing = 1 } = {}) {
        const heights = new Float32Array(countX * countZ);
        for (let iz = 0; iz < countZ; iz++) {
            const z = cornerZ + iz * spacing;
            for (let ix = 0; ix < countX; ix++) heights[iz * countX + ix] = heightAt(cornerX + ix * spacing, z);
        }
        return { frame: makeFrame(), corner: { x: cornerX, z: cornerZ }, spacing, countX, countZ, heights };
    }

    const fixture = {
        seed,
        frame: makeFrame(),
        hill: HILL,
        noiseAmplitude: OCTAVES.reduce((sum, o) => sum + o.amplitude, 0),
        valleyNoise: VALLEY_NOISE,
        /** Fault injection: metres added to every queried height (the capture is unaffected). */
        queryBias: 0,
        stats: { calls: 0, samples: 0, pending: 0 },
        heightAt,
        captureHeightfield,
        /**
         * @param {ArrayLike<number>} positions interleaved frame-local [x0, z0, x1, z1, ...]
         * @returns {Promise<Float32Array>}
         */
        queryHeights(positions) {
            if (!positions || positions.length % 2 !== 0) {
                return Promise.reject(new RangeError('queryHeights expects interleaved [x, z] pairs'));
            }
            const snapshot = Float64Array.from(positions);   // read now, like a GPU upload; callers may reuse their buffer
            const count = snapshot.length / 2;
            const call = fixture.stats.calls++;
            fixture.stats.samples += count;
            fixture.stats.pending++;
            return new Promise(resolve => {
                schedule(() => {
                    const heights = new Float32Array(count);
                    for (let i = 0; i < count; i++) heights[i] = heightAt(snapshot[2 * i], snapshot[2 * i + 1]) + fixture.queryBias;
                    fixture.stats.pending--;
                    resolve(heights);
                }, call);
            });
        },
    };
    return fixture;
}