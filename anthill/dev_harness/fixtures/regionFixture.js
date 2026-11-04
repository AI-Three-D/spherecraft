/**
 * Rock and carve data for the harness region. Plain data: the engine module interprets it
 * (RockModel for layers and veins, VoxelVolume.apply for carves). Coordinates are frame-local
 * metres and assume the terrain fixture's hill (top near x = -70, z = 10, valley from x = 100).
 */
export function createRockDescription() {
    return {
        layers: [
            { name: 'topsoil', thickness: 1.2, follow: 1, color: [0.36, 0.27, 0.18], accent: [0.24, 0.18, 0.12], mottle: 0.5, mottleScale: 2 },
            { name: 'clay', thickness: 3.5, follow: 1, warp: { amplitude: 0.6, wavelength: 25 },
                color: [0.62, 0.45, 0.30], accent: [0.52, 0.36, 0.24], mottle: 0.35, mottleScale: 0.8 },
            { name: 'sandstone', thickness: 14, follow: 0.75, dip: [0.03, 0], warp: { amplitude: 1.5, wavelength: 60 },
                color: [0.78, 0.66, 0.47], accent: [0.64, 0.50, 0.34], banding: 0.8 },
            { name: 'limestone', thickness: 22, follow: 0.45, dip: [0.06, 0.02], warp: { amplitude: 2.5, wavelength: 90 },
                color: [0.72, 0.72, 0.66], accent: [0.58, 0.58, 0.54], banding: 2.2 },
            { name: 'shale', thickness: 28, follow: 0.2, dip: [0.10, -0.03], warp: { amplitude: 3, wavelength: 120 },
                color: [0.33, 0.36, 0.42], accent: [0.24, 0.26, 0.32], banding: 0.5 },
            { name: 'granite', color: [0.50, 0.42, 0.44], accent: [0.32, 0.27, 0.30], mottle: 0.6, mottleScale: 3 },
        ],
        veins: [
            { name: 'quartz', color: [0.93, 0.92, 0.88], frequency: 0.06, stretch: [1, 2.2, 1], threshold: 0.95, depthRange: [8, 60], fade: 4 },
            { name: 'copper', color: [0.25, 0.62, 0.52], frequency: 0.11, stretch: [1.6, 1, 1.6], threshold: 0.965, depthRange: [35, 140], fade: 6 },
        ],
    };
}

const rough = (seed, amplitude = 0.25, frequency = 0.6) => ({ amplitude, frequency, seed });
const carve = shape => ({ mode: 'carve', shape });

export function createCarves() {
    return [
        // Tunnel into the hillside: mouth on the east flank, then west along the default cut (z = 10).
        carve({ type: 'capsule', a: [50, 11, 10], b: [20, 9.5, 10], radius: 1.6, roughness: rough(1) }),
        carve({ type: 'capsule', a: [20, 9.5, 10], b: [-14, 7, 10], radius: 1.6, roughness: rough(2) }),
        // Side gallery that leaves the default cut plane.
        carve({ type: 'capsule', a: [20, 9.5, 10], b: [22, 8, -14], radius: 1.3, roughness: rough(3) }),
        // Upper chamber at the end of the tunnel.
        carve({ type: 'ellipsoid', center: [-18, 8.5, 10], radii: [7, 3.5, 6], roughness: rough(4, 0.4, 0.35) }),
        // Shaft from the surface of the hill down to the deep chamber.
        carve({ type: 'capsule', a: [-40, 60, 10], b: [-40, -22, 10], radius: 1.3, roughness: rough(5, 0.2, 0.7) }),
        carve({ type: 'ellipsoid', center: [-34, -24, 10], radii: [9, 4.5, 7], roughness: rough(6, 0.5, 0.3) }),
        // Closed cave pocket under the flank: no connection to anything.
        carve({ type: 'sphere', center: [38, -28, 9], radius: 4.5, roughness: rough(7, 0.8, 0.35) }),
        carve({ type: 'sphere', center: [43, -30, 12], radius: 3.5, roughness: rough(8, 0.8, 0.35) }),
        carve({ type: 'sphere', center: [34, -29.5, 6], radius: 3, roughness: rough(9, 0.8, 0.35) }),
    ];
}